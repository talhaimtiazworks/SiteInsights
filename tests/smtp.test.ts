/** Mailjet SMTP tests are offline. All mail transports are injected doubles. */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mailjetSmtpPatch, readMailjetSmtpConfig, SmtpConfigurationError, smtpTransportOptions, type EmailEnvironment } from "../scripts/email/smtp-config.mjs";
import { createSmtpService, safeSmtpFailure, type DiagnosticTransport, type SmtpResult } from "../scripts/email/smtp-service.mjs";
import { runSmtpCheck } from "../scripts/email/check-smtp.mjs";
import { MAILJET_TEST_USER as USER, MAILJET_TEST_PASS as PASS, MAILJET_TEST_FROM as FROM } from "./fixtures/mailjet-smtp";

const valid: EmailEnvironment = { SMTP_USER: USER, SMTP_PASS: PASS, EMAIL_FROM: FROM };
const noSecret = (value: unknown) => {
  const text = JSON.stringify(value);
  for (const secret of [USER, PASS, FROM, "raw-provider-secret"]) expect(text).not.toContain(secret);
};
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("server/operator Mailjet configuration", () => {
  it("defaults to port 587 / required STARTTLS and hides the independent API key, Secret Key and sender from JSON", () => {
    const config = readMailjetSmtpConfig(valid);
    expect({ ...config }).toEqual({ host: "in-v3.mailjet.com", port: 587, secure: false });
    expect(config.user).toBe(USER); expect(config.password).toBe(PASS); expect(config.from).toBe(FROM);
    expect(config.user).not.toBe(config.from);
    expect(Object.isFrozen(config)).toBe(true); noSecret(config);
  });

  it("ships matching Mailjet defaults and only blank credential/sender placeholders", () => {
    const text = readFileSync(new URL("../config/environment.example.txt", import.meta.url), "utf8");
    const fields = Object.fromEntries([...text.matchAll(/^(SMTP_[A-Z_]+|EMAIL_FROM)=(.*)$/gm)].map((match) => [match[1], match[2]]));
    expect(fields).toEqual({ SMTP_HOST: "in-v3.mailjet.com", SMTP_PORT: "587", SMTP_SECURE: "false", SMTP_USER: "", SMTP_PASS: "", EMAIL_FROM: "" });
    expect(readMailjetSmtpConfig({ ...fields, ...valid }).host).toBe("in-v3.mailjet.com");
  });

  it("preserves opaque credential bytes/case, including non-16-character keys; only sender outer spaces are trimmed", () => {
    const user = "Test-Mailjet-API-Key-Exact-Case";
    const password = "Test-Secret_Key-Case+Must/Stay=Exact";
    const config = readMailjetSmtpConfig({ ...valid, SMTP_USER: user, SMTP_PASS: password, EMAIL_FROM: " SenderCase@Example.test " });
    expect(config.user).toBe(user); expect(config.password).toBe(password);
    expect(config.from).toBe("SenderCase@Example.test");
    expect(JSON.stringify(config)).not.toContain(user); expect(JSON.stringify(config)).not.toContain(password);
  });

  it("accepts synthetic 32-character hex-shaped keys without claiming provider validation", () => {
    const config = readMailjetSmtpConfig({ ...valid, SMTP_USER: "a".repeat(32), SMTP_PASS: "b".repeat(32) });
    expect(config.user).toBe("a".repeat(32)); expect(config.password).toBe("b".repeat(32));
  });

  it("allows port 465 only with secure=true and verified implicit TLS", () => {
    const config = readMailjetSmtpConfig({ ...valid, SMTP_HOST: "IN-V3.MAILJET.COM", SMTP_PORT: "465", SMTP_SECURE: "true" });
    expect(smtpTransportOptions(config)).toMatchObject({ host: "in-v3.mailjet.com", port: 465, secure: true, requireTLS: false, ignoreTLS: false, opportunisticTLS: false, tls: { rejectUnauthorized: true } });
  });

  it("requires STARTTLS on 587, never allows opportunistic/plaintext fallback or disabled certificate validation", () => {
    const options = smtpTransportOptions(readMailjetSmtpConfig(valid));
    expect(options).toMatchObject({ port: 587, secure: false, requireTLS: true, ignoreTLS: false, opportunisticTLS: false, tls: { minVersion: "TLSv1.2", rejectUnauthorized: true, servername: "in-v3.mailjet.com" } });
  });

  it.each(["SMTP_USER", "SMTP_PASS", "EMAIL_FROM"])("requires %s without printing any values", (field) => {
    const env = { ...valid, [field]: "" };
    expect(() => readMailjetSmtpConfig(env)).toThrow(SmtpConfigurationError);
    try { readMailjetSmtpConfig(env); } catch (error) { noSecret(error); expect((error as SmtpConfigurationError).variables).toContain(field); }
  });

  it.each([
    ["arbitrary SMTP host", { SMTP_HOST: "attacker.example.test" }],
    ["obsolete Gmail host", { SMTP_HOST: "smtp.gmail.com" }],
    ["SMTP URL instead of host", { SMTP_HOST: "smtps://in-v3.mailjet.com" }],
    ["unapproved plaintext-capable port", { SMTP_PORT: "25" }],
    ["unapproved alternative port", { SMTP_PORT: "2525" }],
    ["fractional port", { SMTP_PORT: "587.0" }],
    ["scientific port", { SMTP_PORT: "5.87e2" }],
    ["465 TLS mismatch", { SMTP_PORT: "465", SMTP_SECURE: "false" }],
    ["587 TLS mismatch", { SMTP_PORT: "587", SMTP_SECURE: "true" }],
    ["465 without explicit implicit TLS", { SMTP_PORT: "465" }],
    ["invalid TLS boolean", { SMTP_SECURE: "1" }],
    ["noncanonical boolean", { SMTP_SECURE: "TRUE" }],
    ["short Secret Key", { SMTP_PASS: "short" }],
    ["short API key", { SMTP_USER: "short" }],
    ["oversized API key", { SMTP_USER: "x".repeat(257) }],
    ["oversized Secret Key", { SMTP_PASS: "x".repeat(257) }],
    ["Secret Key newline", { SMTP_PASS: `${PASS}\n` }],
    ["Secret Key leading space", { SMTP_PASS: ` ${PASS}` }],
    ["Secret Key embedded space", { SMTP_PASS: "secret key must never be normalized" }],
    ["API key tab", { SMTP_USER: `${USER}\t` }],
    ["API key newline", { SMTP_USER: `${USER}\n` }],
    ["API key null", { SMTP_USER: `${USER}\0` }],
    ["Secret Key DEL", { SMTP_PASS: `${PASS}\x7f` }],
    ["non-ASCII Secret Key", { SMTP_PASS: `${PASS}é` }],
    ["old grouped credential format", { SMTP_PASS: "abcd efgh ijkl mnop" }],
    ["account email instead of API key", { SMTP_USER: "operator@example.test" }],
    ["sender display name", { EMAIL_FROM: `SiteInsights <${FROM}>` }],
    ["sender list", { EMAIL_FROM: `${FROM},other@example.test` }],
    ["sender header injection", { EMAIL_FROM: `${FROM}\r\nBcc: other@example.test` }],
    ["sender newline", { EMAIL_FROM: `${FROM}\n` }],
    ["invalid sender", { EMAIL_FROM: "not-an-email" }],
    ["API key used as sender", { EMAIL_FROM: USER }],
    ["double-dot mailbox", { EMAIL_FROM: "bad..user@example.test" }],
    ["public SMTP password", { NEXT_PUBLIC_SMTP_PASS: PASS }],
    ["public SMTP user", { NEXT_PUBLIC_SMTP_USER: USER }],
    ["public Mailjet API key alias", { NEXT_PUBLIC_MAILJET_API_KEY: USER }],
    ["public Mailjet Secret Key alias", { NEXT_PUBLIC_MAILJET_SECRET_KEY: PASS }],
    ["public provider-named key alias", { NEXT_PUBLIC_MJ_APIKEY_PUBLIC: USER }],
    ["public sender", { NEXT_PUBLIC_EMAIL_FROM: FROM }],
    ["even an empty public SMTP placeholder", { NEXT_PUBLIC_SMTP_PASS: "" }],
  ] as Array<[string, EmailEnvironment]>)("rejects %s before any transport is created", (_label, patch) => {
    const factory = vi.fn();
    expect(() => createSmtpService({ env: { ...valid, ...patch }, createTransport: factory })).toThrow(SmtpConfigurationError);
    expect(factory).not.toHaveBeenCalled();
    try { readMailjetSmtpConfig({ ...valid, ...patch }); } catch (error) { noSecret(error); }
  });

  it("keeps sender syntax independent of the API key and does not pretend to prove Mailjet sender approval offline", () => {
    const from = "another-controlled-sender@example.test";
    expect(readMailjetSmtpConfig({ ...valid, EMAIL_FROM: from }).from).toBe(from);
  });

  it("refuses browser execution even if imported accidentally", () => {
    vi.stubGlobal("window", {}); expect(() => readMailjetSmtpConfig(valid)).toThrow(/server-only/);
  });

  it("emits only the six documented Supabase SMTP fields, no made-up smtp_secure or security overrides", () => {
    expect(mailjetSmtpPatch(valid)).toEqual({ smtp_host: "in-v3.mailjet.com", smtp_port: "587", smtp_user: USER, smtp_pass: PASS, smtp_admin_email: FROM, smtp_sender_name: "SiteInsights" });
    const patch = mailjetSmtpPatch(valid);
    expect(Object.keys(patch)).toHaveLength(6); expect(patch).not.toHaveProperty("smtp_secure"); expect(patch).not.toHaveProperty("mailer_autoconfirm");
  });

  it("never falls back to removed-provider credentials", () => {
    expect(() => readMailjetSmtpConfig({ POSTMARK_SERVER_TOKEN: "legacy-test-token", SMTP_SENDER_EMAIL: FROM })).toThrow(/Missing server-side/);
  });

  it("locks TLS verification, bounds timeouts, disables file/URL attachments, pooling and debug logs", () => {
    const options = smtpTransportOptions(readMailjetSmtpConfig(valid));
    expect(options).toMatchObject({ secure: false, requireTLS: true, pool: false, logger: false, debug: false, disableFileAccess: true, disableUrlAccess: true, tls: { minVersion: "TLSv1.2", rejectUnauthorized: true, servername: "in-v3.mailjet.com" }, auth: { user: USER, pass: PASS } });
    for (const timeout of [options.connectionTimeout, options.greetingTimeout, options.socketTimeout, options.dnsTimeout]) { expect(timeout).toBeGreaterThan(0); expect(timeout).toBeLessThanOrEqual(20_000); }
    expect(options).not.toHaveProperty("service"); // presets must not override the validated host/TLS pair.
  });
});

function mocked() {
  const verify = vi.fn<DiagnosticTransport["verify"]>().mockResolvedValue(true);
  const sendMail = vi.fn<DiagnosticTransport["sendMail"]>().mockResolvedValue({ accepted: [FROM], rejected: [] });
  const close = vi.fn();
  const createTransport = vi.fn(() => ({ verify, sendMail, close }));
  const auditLog = vi.fn();
  const service = createSmtpService({ env: valid, createTransport, auditLog });
  return { service, verify, sendMail, close, createTransport, auditLog };
}

describe("mocked Nodemailer operator service", () => {
  it("does not connect or send merely by constructing the service", () => {
    const mock = mocked();
    expect(mock.createTransport).not.toHaveBeenCalled();
    expect(mock.sendMail).not.toHaveBeenCalled();
  });

  it("verify checks connection/authentication only, never claims inbox delivery or sends", async () => {
    const mock = mocked();
    const result = await mock.service.verify();
    expect(result).toMatchObject({ ok: true, accepted: false, delivery: "not_sent", code: "smtp_connection_verified", automaticRetry: false });
    expect(result.message).toContain("inbox delivery remain unverified");
    expect(mock.verify).toHaveBeenCalledTimes(1);
    expect(mock.sendMail).not.toHaveBeenCalled();
    expect(mock.close).toHaveBeenCalledOnce();
    noSecret(result); noSecret(mock.auditLog.mock.calls);
  });

  it("sends exactly one branded test to the configured sender mailbox, only after explicit invocation", async () => {
    const mock = mocked();
    const result = await mock.service.sendTest();
    expect(result).toMatchObject({ ok: true, accepted: true, delivery: "accepted_by_smtp", automaticRetry: false });
    expect(result.message).toContain("inbox delivery and Supabase auth mail are not yet verified");
    expect(mock.sendMail).toHaveBeenCalledTimes(1);
    expect(mock.verify).not.toHaveBeenCalled();
    expect(mock.sendMail.mock.calls[0][0]).toMatchObject({ from: { name: "SiteInsights", address: FROM }, to: FROM, envelope: { from: FROM, to: [FROM] }, subject: "SiteInsights SMTP configuration test", disableFileAccess: true, disableUrlAccess: true });
    expect(String(mock.sendMail.mock.calls[0][0].text)).toContain("A TalhaImtiazWorks Product");
    expect(String(mock.sendMail.mock.calls[0][0].text)).not.toContain(PASS);
    for (const value of [USER, PASS]) expect(JSON.stringify(mock.sendMail.mock.calls[0][0])).not.toContain(value);
    noSecret(result); noSecret(mock.auditLog.mock.calls);
  });

  it("matches SMTP acceptance of the sender case-insensitively, including mailbox objects", async () => {
    const mock = mocked(); mock.sendMail.mockResolvedValue({ accepted: [{ address: FROM.toUpperCase() }], rejected: [] });
    expect((await mock.service.sendTest()).accepted).toBe(true);
    expect(mock.sendMail).toHaveBeenCalledOnce();
  });

  it("does not announce acceptance before sendMail resolves", async () => {
    const mock = mocked();
    let finish!: (info: { accepted: string[] }) => void;
    mock.sendMail.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = mock.service.sendTest();
    expect(mock.auditLog).not.toHaveBeenCalled();
    finish({ accepted: [FROM] });
    const result = await pending;
    expect(result.accepted).toBe(true);
    expect(mock.auditLog).toHaveBeenCalledOnce();
  });

  it.each([
    { accepted: [], rejected: [FROM] },
    { accepted: ["other@example.test"], rejected: [] },
    { accepted: [USER], rejected: [] },
    { accepted: [FROM], rejected: [FROM] },
    {},
  ])("does not claim success without acceptance of the only configured recipient (%j)", async (info) => {
    const mock = mocked(); mock.sendMail.mockResolvedValue(info);
    const result = await mock.service.sendTest();
    expect(result).toMatchObject({ ok: false, accepted: false, delivery: "not_accepted", code: "smtp_message_not_accepted" });
    expect(mock.sendMail).toHaveBeenCalledTimes(1);
    noSecret(result);
  });

  it.each([
    ["EAUTH", 535, "smtp_authentication_failed", "not_sent"],
    ["ETLS", 0, "smtp_tls_failed", "not_sent"],
    ["CERT_HAS_EXPIRED", 0, "smtp_tls_failed", "not_sent"],
    ["ECONNREFUSED", 0, "smtp_connection_failed", "not_sent"],
    ["EDNS", 0, "smtp_connection_failed", "not_sent"],
    ["EENVELOPE", 550, "smtp_message_rejected", "not_accepted"],
    ["EMESSAGE", 421, "smtp_message_rejected", "not_accepted"],
    ["ETIMEDOUT", 0, "smtp_timeout", "unknown"],
    ["ESOCKET", 0, "smtp_unavailable", "unknown"],
    ["UNKNOWN", 0, "smtp_unavailable", "unknown"],
  ] as Array<[string, number, string, string]>)("sanitizes %s, does not retry/resend, closes transport", async (code, responseCode, expected, delivery) => {
    const mock = mocked();
    mock.sendMail.mockRejectedValue(Object.assign(new Error(`raw-provider-secret SMTP_PASS=${PASS} user=${USER}`), { code, responseCode, response: `SMTP_PASS=${PASS}`, command: "DATA" }));
    const result = await mock.service.sendTest();
    expect(result).toMatchObject({ ok: false, code: expected, accepted: false, delivery, automaticRetry: false });
    expect(mock.createTransport).toHaveBeenCalledTimes(1);
    expect(mock.sendMail).toHaveBeenCalledTimes(1);
    expect(mock.close).toHaveBeenCalledTimes(1);
    noSecret(result); noSecret(mock.auditLog.mock.calls);
  });

  it("does not claim a false verify result was successful", async () => {
    const mock = mocked(); mock.verify.mockResolvedValue(false);
    expect(await mock.service.verify()).toMatchObject({ ok: false, code: "smtp_verification_failed", delivery: "not_sent" });
    expect(mock.sendMail).not.toHaveBeenCalled();
  });

  it("sanitizes transport construction and close failures without resending", async () => {
    const mock = mocked();
    mock.createTransport.mockImplementation(() => { throw new Error(`raw-provider-secret ${PASS}`); });
    const result = await mock.service.verify();
    expect(result.ok).toBe(false); noSecret(result);
    expect(mock.createTransport).toHaveBeenCalledOnce(); expect(mock.sendMail).not.toHaveBeenCalled();
    const mock2 = mocked(); mock2.close.mockImplementation(() => { throw new Error(`raw-provider-secret ${PASS}`); });
    expect((await mock2.service.sendTest()).ok).toBe(true);
    expect(mock2.sendMail).toHaveBeenCalledOnce(); noSecret(mock2.auditLog.mock.calls);
  });

  it("a logging exception cannot cause a resend or turn confirmed acceptance into a failure", async () => {
    const mock = mocked(); mock.auditLog.mockImplementation(() => { throw new Error("logger failed"); });
    expect((await mock.service.sendTest()).accepted).toBe(true);
    expect(mock.sendMail).toHaveBeenCalledOnce();
  });

  it("distinguishes handshake timeout from an uncertain post-DATA timeout", () => {
    expect(safeSmtpFailure({ code: "ETIMEDOUT", command: "CONN" }, "send-test").delivery).toBe("not_sent");
    expect(safeSmtpFailure({ code: "ETIMEDOUT", command: "DATA" }, "send-test").delivery).toBe("unknown");
    expect(safeSmtpFailure({ code: "ETIMEDOUT" }, "verify").delivery).toBe("not_sent");
  });
});

describe("safe SMTP diagnostic CLI", () => {
  const success: SmtpResult = { ok: true, accepted: false, code: "smtp_connection_verified", message: "No email sent.", delivery: "not_sent", automaticRetry: false };
  it("defaults to offline validation; no service or SMTP connection is constructed", async () => {
    const makeService = vi.fn(); const output = vi.fn();
    expect(await runSmtpCheck({ env: valid, argv: [], makeService, output })).toBe(0);
    expect(output.mock.calls[0][0]).toMatchObject({ code: "smtp_configuration_valid", delivery: "not_sent", accepted: false });
    expect(makeService).not.toHaveBeenCalled(); noSecret(output.mock.calls);
  });
  it("--verify invokes the mocked handshake only, never sendTest", async () => {
    const verify = vi.fn().mockResolvedValue(success); const sendTest = vi.fn(); const output = vi.fn();
    expect(await runSmtpCheck({ env: valid, argv: ["--verify"], makeService: () => ({ verify, sendTest }), output })).toBe(0);
    expect(verify).toHaveBeenCalledOnce(); expect(sendTest).not.toHaveBeenCalled(); noSecret(output.mock.calls);
  });
  it("only --send-test invokes one send and never an implicit verify", async () => {
    const verify = vi.fn(); const sendTest = vi.fn().mockResolvedValue({ ...success, accepted: true });
    expect(await runSmtpCheck({ env: valid, argv: ["--send-test"], makeService: () => ({ verify, sendTest }), output: () => {} })).toBe(0);
    expect(sendTest).toHaveBeenCalledOnce(); expect(verify).not.toHaveBeenCalled();
  });
  it.each([["--verify", "--send-test"], ["--recipient", FROM], ["--password", PASS], ["--verify", "--verify"]])("rejects unsafe/ambiguous arguments without echoing values (%j)", async (...args) => {
    const argv = args as string[]; const output = vi.fn(); const makeService = vi.fn();
    expect(await runSmtpCheck({ env: valid, argv, output, makeService })).toBe(1);
    expect(makeService).not.toHaveBeenCalled(); noSecret(output.mock.calls);
  });
  it("returns a nonzero status on sanitized transport failure", async () => {
    const output = vi.fn();
    const verify = vi.fn().mockResolvedValue(safeSmtpFailure({ code: "EAUTH" }, "verify"));
    expect(await runSmtpCheck({ env: valid, argv: ["--verify"], output, makeService: () => ({ verify, sendTest: vi.fn() }) })).toBe(1);
    noSecret(output.mock.calls);
  });
  it("help and actual standalone default work without a real account or network", async () => {
    const output = vi.fn(); expect(await runSmtpCheck({ env: {}, argv: ["--help"], output })).toBe(0);
    const { stdout, stderr } = await promisify(execFile)(process.execPath, ["scripts/email/check-smtp.mjs"], { env: { NODE_ENV: "test", PATH: process.env.PATH, ...valid } });
    expect(JSON.parse(stdout)).toMatchObject({ code: "smtp_configuration_valid", delivery: "not_sent" });
    expect(stderr).toBe(""); noSecret(stdout);
  });
});
