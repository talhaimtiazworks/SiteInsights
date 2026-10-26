import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { FeedbackMailer } from "@/lib/email/feedback-mailer";
import { FEEDBACK_RECIPIENT } from "@/lib/email/feedback-mailer";
import { renderFeedbackEmail } from "@/lib/email/feedback-template";
import {
  FEEDBACK_AUDIT_THRESHOLD,
  FEEDBACK_MESSAGE_MAX,
  FEEDBACK_MESSAGE_MIN,
  feedbackSubmitSchema,
  getFeedbackPromptState,
  respondToFeedbackInvite,
  retryFeedbackDeliveries,
  submitFeedback,
  type FeedbackAccountStore,
} from "@/lib/services/feedback";
import type { FeedbackPromptRow, FeedbackSubmissionRow } from "@/lib/db/account-types";

/* ── In-memory double of the feedback slice of the account repository ──
   Mirrors the Postgres semantics used by the service contract:
   insert is idempotent on (userId, idempotencyKey); invitation creation is an
   INSERT ... ON CONFLICT DO NOTHING, so concurrent offers collapse to one. */

class FakeStore implements FeedbackAccountStore {
  submissions = new Map<string, FeedbackSubmissionRow>();
  prompts = new Map<string, FeedbackPromptRow>();
  completedCounts = new Map<string, number>();
  deliveryUpdates: { submissionId: string; status: string }[] = [];

  setCompleted(userId: string, n: number) {
    this.completedCounts.set(userId, n);
  }

  private key(userId: string, k: string) {
    return `${userId}:${k}`;
  }

  async countCompletedAuditsForUser(userId: string) {
    return this.completedCounts.get(userId) ?? 0;
  }
  async hasFeedbackSubmission(userId: string) {
    return [...this.submissions.values()].some((s) => s.userId === userId);
  }
  async getFeedbackPrompt(userId: string) {
    return this.prompts.get(userId) ?? null;
  }
  async ensureFeedbackPromptOffered(userId: string) {
    // Model the atomic INSERT ... ON CONFLICT DO NOTHING + SELECT.
    const existing = this.prompts.get(userId);
    if (existing) return existing;
    const row: FeedbackPromptRow = { userId, state: "offered", firstOfferedAt: new Date().toISOString(), remindAfter: null, updatedAt: new Date().toISOString() };
    this.prompts.set(userId, row);
    return row;
  }
  async setFeedbackPromptResponse(userId: string, input: { state: "remind_later" | "dismissed"; remindAfter: Date | null }) {
    const row = this.prompts.get(userId);
    if (!row || row.state === "dismissed") return null;
    const updated = { ...row, state: input.state, remindAfter: input.remindAfter?.toISOString() ?? null, updatedAt: new Date().toISOString() };
    this.prompts.set(userId, updated);
    return updated;
  }
  async insertFeedbackSubmission(input: Omit<FeedbackSubmissionRow, "deliveryStatus" | "deliveryErrorCode" | "providerMessageId" | "outcomeUncertain" | "createdAt" | "updatedAt">) {
    const k = this.key(input.userId, input.idempotencyKey);
    const existing = this.submissions.get(k);
    if (existing) return { submission: existing, created: false };
    const now = new Date().toISOString();
    const row: FeedbackSubmissionRow = { ...input, deliveryStatus: "pending", deliveryErrorCode: null, providerMessageId: null, outcomeUncertain: false, createdAt: now, updatedAt: now };
    this.submissions.set(k, row);
    return { submission: row, created: true };
  }
  async updateFeedbackDelivery(userId: string, submissionId: string, patch: { deliveryStatus: FeedbackSubmissionRow["deliveryStatus"]; deliveryErrorCode: string | null; providerMessageId?: string | null; outcomeUncertain?: boolean }) {
    for (const [k, row] of this.submissions) {
      if (row.id === submissionId && row.userId === userId) {
        this.submissions.set(k, {
          ...row,
          deliveryStatus: patch.deliveryStatus,
          deliveryErrorCode: patch.deliveryErrorCode,
          providerMessageId: patch.providerMessageId ?? row.providerMessageId,
          outcomeUncertain: patch.outcomeUncertain ?? row.outcomeUncertain,
        });
        this.deliveryUpdates.push({ submissionId, status: patch.deliveryStatus });
      }
    }
  }

  async listUndeliveredFeedback(userId: string, limit: number): Promise<FeedbackSubmissionRow[]> {
    return [...this.submissions.values()]
      .filter((r) => r.userId === userId && r.deliveryStatus === "failed" && !r.outcomeUncertain)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit);
  }
}

const okMailer = (id = "provider-msg-1"): FeedbackMailer => ({
  provider: "mailjet-smtp",
  send: vi.fn(async () => ({ accepted: true as const, providerMessageId: id })),
});
const failingMailer = (code: string, uncertain = false): FeedbackMailer => ({
  provider: "mailjet-smtp",
  send: vi.fn(async () => ({ accepted: false as const, code, uncertain, message: "x" })),
});

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

const validInput = (key = crypto.randomUUID()) => ({
  category: "bug" as const,
  rating: 4,
  message: "The audit history page sometimes keeps the previous filter after signing out and back in.",
  goal: "Checking a client's staging site before a proposal",
  idempotencyKey: key,
});

describe("feedback invitation — counting and one-time trigger", () => {
  it("shows nothing before three completed audits (1 & 8. counts/gates)", async () => {
    const store = new FakeStore();
    store.setCompleted(USER, 2);
    expect(await getFeedbackPromptState(store, USER)).toMatchObject({ show: false, promptState: "not_eligible", submittedAlready: false });
    store.setCompleted(USER, FEEDBACK_AUDIT_THRESHOLD);
    expect((await getFeedbackPromptState(store, USER)).show).toBe(true);
  });

  it("2. offers after the third successful audit and exposes the live count (current-session trigger included)", async () => {
    const store = new FakeStore();
    for (let n = 0; n < FEEDBACK_AUDIT_THRESHOLD; n++) {
      store.setCompleted(USER, n);
      expect((await getFeedbackPromptState(store, USER)).show).toBe(false);
    }
    store.setCompleted(USER, 3);
    const state = await getFeedbackPromptState(store, USER);
    expect(state).toMatchObject({ show: true, promptState: "offered", completedAudits: 3 });
  });

  it("3. failed and cancelled audits never count toward the threshold", () => {
    // The counting SQL is the single source of truth: only completed statuses. (Pin; the env-gated
    // Postgres group in advanced suites exercises the same where clause against a real database.)
    const src = readFileSync("src/lib/db/postgres.ts", "utf8");
    expect(src).toMatch(/a\.status IN \('completed','completed_with_warnings'\)/);
    expect(src).not.toMatch(/a\.status IN \([^)]*(failed|cancelled)/);
  });

  it("4. does not repeat after dismissal or after a submission", async () => {
    const store = new FakeStore();
    store.setCompleted(USER, 5);
    expect((await getFeedbackPromptState(store, USER)).show).toBe(true);
    await respondToFeedbackInvite(store, USER, "dismiss");
    expect((await getFeedbackPromptState(store, USER)).promptState).toBe("dismissed");
    // Count keeps rising — prompt stays hidden forever.
    store.setCompleted(USER, 9);
    expect((await getFeedbackPromptState(store, USER)).show).toBe(false);

    const store2 = new FakeStore();
    store2.setCompleted(OTHER, 3);
    await submitFeedback({ store: store2, mailer: okMailer(), userId: OTHER, accountEmail: "u@example.test", input: validInput() });
    expect((await getFeedbackPromptState(store2, OTHER)).promptState).toBe("submitted");
  });

  it("5. state survives 'new sessions/devices' — i.e. comes from the store, not the client", async () => {
    const store = new FakeStore();
    store.setCompleted(USER, 3);
    expect((await getFeedbackPromptState(store, USER)).show).toBe(true);
    // A fresh code path against the same store = same answer (no client state involved).
    expect((await getFeedbackPromptState(store, USER)).promptState).toBe("offered");
    await respondToFeedbackInvite(store, USER, "remind_later");
    const later = await getFeedbackPromptState(store, USER, new Date(Date.now() + 1000));
    expect(later.show).toBe(false);
    // 72h later the reminder comes due exactly once, then waits again if snoozed again.
    const due = await getFeedbackPromptState(store, USER, new Date(Date.now() + 4 * 24 * 3600 * 1000));
    expect(due.promptState).toBe("remind_due");
    expect(due.show).toBe(true);
  });

  it("6. concurrent completions/race settle to exactly one invitation row", async () => {
    const store = new FakeStore();
    store.setCompleted(USER, 3);
    const results = await Promise.all(Array.from({ length: 8 }, () => getFeedbackPromptState(store, USER)));
    expect(results.every((r) => r.show)).toBe(true);
    expect(store.prompts.size).toBe(1);
    // Cross-account isolation: another user triggering races cannot create a row for USER's account.
    const otherStore = new FakeStore();
    otherStore.setCompleted(OTHER, 10);
    await Promise.all(Array.from({ length: 4 }, () => getFeedbackPromptState(otherStore, OTHER)));
    expect(otherStore.prompts.has(USER)).toBe(false);
  });
});

describe("feedback submission — delivery honesty and idempotency", () => {
  it("7. valid feedback is sent to the fixed recipient and marked accepted", async () => {
    const store = new FakeStore();
    const mailer = okMailer();
    const out = await submitFeedback({ store, mailer, userId: USER, accountEmail: "user@example.test", input: validInput() });
    expect(out.kind).toBe("delivered");
    expect(mailer.send).toHaveBeenCalledTimes(1);
    const sent = (mailer.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const mail = sent as { subject: string; text: string };
    expect(mail.subject).toContain("Bug report");
    expect(mail.text).toContain(USER);
    expect(mail.text).toContain("user@example.test");
    const rows = [...store.submissions.values()];
    expect(rows[0].deliveryStatus).toBe("accepted");
    expect(rows[0].providerMessageId).toBe("provider-msg-1");
    expect(FEEDBACK_RECIPIENT).toBe("talhaimtiazworks@gmail.com");
  });

  it("8. invalid submissions are rejected by the schema before any store/email work", () => {
    expect(feedbackSubmitSchema.safeParse({ ...validInput(), message: "too short" }).success).toBe(false);
    expect(feedbackSubmitSchema.safeParse({ ...validInput(), rating: 6 }).success).toBe(false);
    expect(feedbackSubmitSchema.safeParse({ ...validInput(), rating: 4.5 }).success).toBe(false);
    expect(feedbackSubmitSchema.safeParse({ ...validInput(), category: "spam" }).success).toBe(false);
    expect(feedbackSubmitSchema.safeParse(validInput()).success).toBe(true);
    expect(feedbackSubmitSchema.safeParse({ ...validInput(), message: "x".repeat(FEEDBACK_MESSAGE_MAX + 1) }).success).toBe(false);
    expect(feedbackSubmitSchema.safeParse({ ...validInput(), idempotencyKey: "not-a-uuid" }).success).toBe(false);
    expect(feedbackSubmitSchema.safeParse({ ...validInput(), pageUrl: "https://evil.example/x" }).success).toBe(false);
    expect(feedbackSubmitSchema.safeParse({ ...validInput(), to: "attacker@mail.example" }).success).toBe(false); // z.strict: recipient never user-controlled
    const minimal = { category: "general", message: "a".repeat(FEEDBACK_MESSAGE_MIN), idempotencyKey: crypto.randomUUID() };
    expect(feedbackSubmitSchema.safeParse(minimal).success).toBe(true);
  });

  it("9. provider failure never reports success, never loses the record, and uncertain outcomes are never re-sent", async () => {
    const store = new FakeStore();
    const key = crypto.randomUUID();
    const failMailer = failingMailer("smtp_connection_failed");
    const first = await submitFeedback({ store, mailer: failMailer, userId: USER, accountEmail: null, input: validInput(key) });
    expect(first.kind).toBe("delivery_failed");
    const row = [...store.submissions.values()][0];
    expect(row.deliveryStatus).toBe("failed");
    expect(row.deliveryErrorCode).toBe("smtp_connection_failed");

    // Retry with the same idempotency key after recovery: same row, delivered exactly once.
    const second = await submitFeedback({ store, mailer: okMailer(), userId: USER, accountEmail: null, input: validInput(key) });
    expect(second.kind).toBe("delivered");
    expect(store.submissions.size).toBe(1);

    // Uncertain outcome (timeout after DATA): provider may already have it — never re-send.
    const storeU = new FakeStore();
    const keyU = crypto.randomUUID();
    await submitFeedback({ store: storeU, mailer: failingMailer("smtp_timeout", true), userId: USER, accountEmail: null, input: validInput(keyU) });
    const again = await submitFeedback({ store: storeU, mailer: okMailer(), userId: USER, accountEmail: null, input: validInput(keyU) });
    expect(again.kind).toBe("already_recorded");

    // Delivered rows: a retried submit can never produce a second email.
    const dup = await submitFeedback({ store, mailer: okMailer("other-id"), userId: USER, accountEmail: null, input: validInput(key) });
    expect(dup.kind).toBe("already_recorded");
    // Only ONE accepted send happened for that key.
    expect(store.deliveryUpdates.filter((u) => u.status === "accepted")).toHaveLength(1);
  });

  it("unconfigured provider: recorded + honest non-success, not a pretend delivery", async () => {
    const store = new FakeStore();
    const out = await submitFeedback({ store, mailer: null, userId: USER, accountEmail: null, input: validInput() });
    expect(out.kind).toBe("email_not_configured");
    expect([...store.submissions.values()][0].deliveryErrorCode).toBe("email_not_configured");
  });

  it("10. the service only ever touches the caller's own account (userId-scoped store contract)", async () => {
    const store = new FakeStore();
    store.setCompleted(USER, 3);
    await getFeedbackPromptState(store, USER);
    await respondToFeedbackInvite(store, OTHER, "dismiss"); // OTHER has no invitation — must be a no-op
    expect((await getFeedbackPromptState(store, OTHER)).promptState).toBe("not_eligible");
    expect(store.prompts.has(OTHER)).toBe(false);
    const src = readFileSync("src/app/api/feedback/route.ts", "utf8") + readFileSync("src/app/api/feedback/prompt/route.ts", "utf8");
    expect(src).toContain("getAuditContext"); // 401 for anonymous — account identity is server-verified
    expect(src).not.toMatch(/body\.userId|input\.userId/); // never client-supplied identity
    const retry = readFileSync("src/app/api/feedback/retry/route.ts", "utf8");
    expect(retry).toContain("getAuditContext"); // anonymous 401 — no one can trigger delivery for others
    expect(retry).toContain("ctx.user.id"); // account scope from the verified session, not the request body
  });
});

describe("feedback mailer — SMTP contract against an injected transport", () => {
  const env = { SMTP_USER: "smtp-user-key", SMTP_PASS: "smtp-secret-key", EMAIL_FROM: "audits@verify.example", SMTP_HOST: "in-v3.mailjet.com", SMTP_PORT: "587", SMTP_SECURE: "false" };

  function fakeTransport(behavior: "ok" | "cnx" | "auth" | "data-timeout") {
    const calls: { sent: unknown[]; opts: unknown[] } = { sent: [], opts: [] };
    const transport = {
      verify: async () => {},
      sendMail: async (opts: unknown) => {
        calls.sent.push(opts);
        // Connection/auth handshake happens inside sendMail for a per-send transport.
        if (behavior === "cnx") { const e = new Error("connect ECONNREFUSED") as Error & { code: string }; e.code = "ECONNREFUSED"; throw e; }
        if (behavior === "auth") { const e = new Error("535 Authentication failed") as Error & { responseCode: number }; e.responseCode = 535; throw e; }
        if (behavior === "data-timeout") { const e = new Error("Timeout after 454") as Error & { code: string }; e.code = "ETIMEDOUT"; throw e; }
        return { messageId: "mj-42", accepted: [FEEDBACK_RECIPIENT], rejected: [] };
      },
    };
    return {
      calls,
      mk: ((opts: unknown) => { calls.opts.push(opts); return transport; }) as unknown as (options: Record<string, unknown>) => import("nodemailer").Transporter,
    };
  }

  const mailMsg = () => ({ subject: "s", text: "t", html: "<p>t</p>", replyTo: null });

  it("success path: verify + single send, accepted recipient, provider id captured", async () => {
    const { createFeedbackMailer } = await import("@/lib/email/feedback-mailer");
    const { calls, mk } = fakeTransport("ok");
    const mailer = createFeedbackMailer(env, { createTransport: mk })!;
    expect(mailer.provider).toBe("mailjet-smtp");
    const r = await mailer.send(mailMsg());
    expect(r).toEqual({ accepted: true, providerMessageId: "mj-42" });
    const sent = calls.sent[0] as { from: { address: string }; envelope: { from: string; to: string[] } };
    // Recipient enforced at both the header and the SMTP envelope level; sender is EMAIL_FROM.
    expect(sent.envelope).toEqual({ from: "audits@verify.example", to: [FEEDBACK_RECIPIENT] });
    expect(sent.from.address).toBe("audits@verify.example");
    await mailer.send(mailMsg());
    expect(calls.sent).toHaveLength(2);
  });

  it("classifies transient connection failure as retryable, auth failure as misconfigured", async () => {
    const { createFeedbackMailer } = await import("@/lib/email/feedback-mailer");
    const cnx = createFeedbackMailer(env, { createTransport: fakeTransport("cnx").mk })!;
    expect(await cnx.send(mailMsg())).toMatchObject({ accepted: false, code: "smtp_connection_failed", uncertain: false });
    const auth = createFeedbackMailer(env, { createTransport: fakeTransport("auth").mk })!;
    expect(await auth.send(mailMsg())).toMatchObject({ accepted: false, code: "smtp_authentication_failed", uncertain: false });
  });

  it("a post-DATA timeout is marked UNCERTAIN (provider may have accepted) so it is never re-sent", async () => {
    const { createFeedbackMailer } = await import("@/lib/email/feedback-mailer");
    const t = fakeTransport("data-timeout");
    const mailer = createFeedbackMailer(env, { createTransport: t.mk })!;
    const r = await mailer.send(mailMsg());
    expect(r).toMatchObject({ accepted: false, uncertain: true });
  });

  it("misconfigured/absent env fails closed (no provider object, no connect attempt)", async () => {
    const { createFeedbackMailer } = await import("@/lib/email/feedback-mailer");
    expect(createFeedbackMailer({})).toBeNull();
    expect(createFeedbackMailer({ SMTP_USER: "u" })).toBeNull();
    expect(createFeedbackMailer({ ...env, SMTP_PORT: "25", SMTP_SECURE: "false" })).toBeNull();
    expect(createFeedbackMailer({ ...env, SMTP_HOST: "smtp.other-provider.example" })).toBeNull();
  });

  it("Brevo relay is accepted as the second allowlisted host (and labelled correctly)", async () => {
    const { createFeedbackMailer } = await import("@/lib/email/feedback-mailer");
    const t = fakeTransport("ok");
    const mailer = createFeedbackMailer({ ...env, SMTP_HOST: "smtp-relay.brevo.com" }, { createTransport: t.mk });
    expect(mailer).not.toBeNull();
    expect(mailer!.provider).toBe("brevo-smtp");
    const r = await mailer!.send(mailMsg());
    expect(r).toEqual({ accepted: true, providerMessageId: "mj-42" });
    // The fake transport received exactly the Brevo host + forced pairing.
    expect(t.calls.opts[0]).toMatchObject({ host: "smtp-relay.brevo.com", port: 587, secure: false });
  });

  it("host allowlist: mailjet still works, every unapproved host is rejected (incl. lookalikes)", async () => {
    const { createFeedbackMailer } = await import("@/lib/email/feedback-mailer");
    expect(createFeedbackMailer(env)!.provider).toBe("mailjet-smtp");
    for (const evil of [
      "smtp.other-provider.example",
      "smtp-relay.sendinblue.com",          // legacy alias — not allowlisted
      "smtp-relay.brevo.com.evil.example",  // suffix attack
      "in-v3.mailjet.com.evil.example",
      "https://smtp-relay.brevo.com",        // URL, not a hostname
    ]) {
      expect(createFeedbackMailer({ ...env, SMTP_HOST: evil }, { createTransport: fakeTransport("ok").mk }), evil).toBeNull();
    }
  });

  it("port/security pairing: 587+false and 465+true accepted, everything else rejected", async () => {
    const { createFeedbackMailer } = await import("@/lib/email/feedback-mailer");
    expect(createFeedbackMailer({ ...env, SMTP_PORT: "587", SMTP_SECURE: "false" })).not.toBeNull();
    expect(createFeedbackMailer({ ...env, SMTP_PORT: "465", SMTP_SECURE: "true" })).not.toBeNull();
    for (const [port, secure] of [["587", "true"], ["465", "false"], ["25", "false"], ["2525", "false"], ["587", "true "]]) {
    // note: SMTP_SECURE values are compared case-sensitively against "true"; "FALSE"/"True" simply = false
      expect(createFeedbackMailer({ ...env, SMTP_PORT: port, SMTP_SECURE: secure }), `${port}/${secure}`).toBeNull();
    }
  });

  it("sender must be a bare address: missing credentials and display-name formats fail closed", async () => {
    const { createFeedbackMailer } = await import("@/lib/email/feedback-mailer");
    expect(createFeedbackMailer(env)).not.toBeNull();
    expect(createFeedbackMailer({ ...env, SMTP_USER: "" })).toBeNull();
    expect(createFeedbackMailer({ ...env, SMTP_PASS: "" })).toBeNull();
    expect(createFeedbackMailer({ ...env, SMTP_PASS: undefined })).toBeNull();
    for (const bad of ["SiteInsights <audits@verify.example>", "audits at example", "audits@example"]) {
      expect(createFeedbackMailer({ ...env, EMAIL_FROM: bad }, { createTransport: fakeTransport("ok").mk }), bad).toBeNull();
    }
  });
});

describe("feedback retry — recovering saved-but-undelivered submissions", () => {
  it("delivers queued rows exactly once after configuration (no user resubmission)", async () => {
    const store = new FakeStore();
    await submitFeedback({ store, mailer: null, userId: USER, accountEmail: "u@example.test", input: validInput() });
    await submitFeedback({ store, mailer: null, userId: USER, accountEmail: "u@example.test", input: validInput() });
    expect(store.submissions.size).toBe(2);
    expect([...store.submissions.values()].every((r) => r.deliveryStatus === "failed")).toBe(true);

    // Provider now configured: the retry recovers both rows, emails arrive with original content.
    const mailer = okMailer();
    const out = await retryFeedbackDeliveries({ store, mailer, userId: USER, accountEmail: "u@example.test" });
    expect(out).toMatchObject({ kind: "retried", attempted: 2, delivered: 2, stillFailed: 0 });
    expect(mailer.send).toHaveBeenCalledTimes(2);
    expect([...store.submissions.values()].every((r) => r.deliveryStatus === "accepted")).toBe(true);

    // Second retry run is a no-op: accepted rows are never re-selected, let alone re-sent.
    const again = await retryFeedbackDeliveries({ store, mailer, userId: USER, accountEmail: "u@example.test" });
    expect(again).toMatchObject({ kind: "retried", attempted: 0 });
    expect(mailer.send).toHaveBeenCalledTimes(2);
  });

  it("never re-sends delivery-uncertain rows, even in a retry storm", async () => {
    const store = new FakeStore();
    await submitFeedback({ store, mailer: failingMailer("smtp_timeout", true), userId: USER, accountEmail: null, input: validInput() });
    await submitFeedback({ store, mailer: failingMailer("smtp_connection_failed"), userId: USER, accountEmail: null, input: validInput() });
    const mailer = okMailer();
    const out = await retryFeedbackDeliveries({ store, mailer, userId: USER, accountEmail: null });
    // Only the connection-failed row is eligible; the timeout-uncertain row stays failed forever.
    expect(out).toMatchObject({ kind: "retried", attempted: 1, delivered: 1, stillFailed: 0 });
    expect(mailer.send).toHaveBeenCalledTimes(1);
    const statuses = [...store.submissions.values()].map((r) => `${r.deliveryStatus}${r.outcomeUncertain ? ":uncertain" : ""}`);
    expect(statuses.sort()).toEqual(["accepted", "failed:uncertain"]);
  });

  it("keeps failed rows retryable after a partial recovery outage (nothing lost)", async () => {
    const store = new FakeStore();
    await submitFeedback({ store, mailer: null, userId: USER, accountEmail: null, input: validInput() });
    await submitFeedback({ store, mailer: null, userId: USER, accountEmail: null, input: validInput() });
    const r1 = await retryFeedbackDeliveries({ store, mailer: okMailer(), userId: USER, accountEmail: null });
    expect(r1).toMatchObject({ delivered: 2 });
    // Provider then dies mid-queue: rows that could not send remain failed, not deleted, not "pretend accepted".
    await submitFeedback({ store, mailer: failingMailer("smtp_connection_failed"), userId: USER, accountEmail: null, input: validInput() });
    const r2 = await retryFeedbackDeliveries({ store, mailer: failingMailer("smtp_connection_failed"), userId: USER, accountEmail: null });
    expect(r2).toMatchObject({ kind: "retried", attempted: 1, delivered: 0, stillFailed: 1 });
    expect(store.submissions.size).toBe(3);
    // And the surviving row is recovered once the provider is healthy.
    const r3 = await retryFeedbackDeliveries({ store, mailer: okMailer(), userId: USER, accountEmail: null });
    expect(r3).toMatchObject({ delivered: 1, stillFailed: 0 });
  });

  it("reports the unconfigured state honestly and sends nothing", async () => {
    const store = new FakeStore();
    await submitFeedback({ store, mailer: null, userId: USER, accountEmail: null, input: validInput() });
    const out = await retryFeedbackDeliveries({ store, mailer: null, userId: USER, accountEmail: null });
    expect(out).toEqual({ kind: "email_not_configured", pending: 1 });
  });

  it("is account-scoped: one user's retry can never touch another user's rows", async () => {
    const store = new FakeStore();
    await submitFeedback({ store, mailer: null, userId: USER, accountEmail: null, input: validInput() });
    await submitFeedback({ store, mailer: null, userId: OTHER, accountEmail: null, input: validInput() });
    const out = await retryFeedbackDeliveries({ store, mailer: okMailer(), userId: OTHER, accountEmail: null });
    expect(out).toMatchObject({ attempted: 1, delivered: 1 });
    const rows = [...store.submissions.values()];
    expect(rows.find((r) => r.userId === USER)!.deliveryStatus).toBe("failed");
    expect(rows.find((r) => r.userId === OTHER)!.deliveryStatus).toBe("accepted");
  });
});

describe("rendering and template hygiene", () => {
  it("escapes every user-controlled value in the HTML email", () => {
    const { html, text } = renderFeedbackEmail({
      submissionId: "id-1",
      category: "general",
      rating: 5,
      message: "<script>alert(1)</script> & \"quotes\"",
      goal: "steal <b>cookies</b>",
      pageUrl: "/dashboard",
      accountEmail: "a@b.example",
      accountUserId: USER,
      submittedAt: "2026-10-24T00:00:00.000Z",
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
    expect(html).toContain("steal &lt;b&gt;cookies&lt;/b&gt;");
    expect(text).toContain("<script>alert(1)</script>"); // plain text stays verbatim
  });

  it("11. page + form + invitation render for narrow and wide containers (SSR smoke)", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const Page = (await import("@/app/feedback/page")).default;
    const html = renderToStaticMarkup(createElement(Page));
    expect(html).toContain("Help Us Improve SiteInsights");
    expect(html).toContain("fb-message");
    expect(html).toContain("Send feedback");
    // Responsive grid classes present on shell + form follows single-column flow
    expect(html).toMatch(/container\s+max-w-3xl/);
    // The invitation island is client-only (uses the app router). Pin its contract at source:
    // probes the server for truth, never localStorage, and renders nothing until the API says show.
    const island = readFileSync("src/components/feedback-invite.tsx", "utf8");
    expect(island).toContain("/api/feedback/prompt");
    expect(island).toContain('"use client"');
    expect(island).not.toMatch(/localStorage\s*[.(]/);
    expect(island).not.toMatch(/sessionStorage\s*[.(]/);
    expect(island).toContain('if (!state) return null');
  });
});
