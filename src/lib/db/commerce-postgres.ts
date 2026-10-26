import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import type { ClientReportSnapshot, ClientReportSnapshotContent } from "../report/snapshot-types";
import {
  PROSPECT_STATUSES,
  type AuditBatch,
  type BatchItem,
  type CommerceRepository,
  type CreditAccount,
  type CreditInput,
  type CreditPeriod,
  type CreditResult,
  type LedgerEntry,
  type Prospect,
  type ProspectInput,
  type ProspectPatch,
  type ProspectQuery,
  type ProspectStatus,
  type ReportShare,
  type SpendInput,
  type SpendResult,
} from "./commerce-types";

type Sql = postgres.Sql<Record<string, never>>;
type Tx = postgres.TransactionSql<Record<string, never>>;
type Runner = <T>(fn: (sql: Sql) => Promise<T>) => Promise<T>;
type Json = postgres.JSONValue;

const iso = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null);
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/* eslint-disable @typescript-eslint/no-explicit-any */
const rowToAccount = (r: any): CreditAccount => ({
  principalId: r.principal_id,
  planId: r.plan_id,
  balance: r.balance,
  allowance: r.allowance,
  periodKey: r.period_key,
  periodStart: iso(r.period_start)!,
  periodEnd: iso(r.period_end)!,
  updatedAt: iso(r.updated_at)!,
});
const rowToEntry = (r: any): LedgerEntry => ({
  id: String(r.id),
  principalId: r.principal_id,
  delta: r.delta,
  balanceAfter: r.balance_after,
  entryType: r.entry_type,
  operation: r.operation,
  auditId: r.audit_id,
  periodKey: r.period_key,
  idempotencyKey: r.idempotency_key,
  detail: r.detail ?? {},
  createdAt: iso(r.created_at)!,
});
const rowToProspect = (r: any): Prospect => ({
  id: r.id,
  principalId: r.principal_id,
  organizationId: r.organization_id ?? null,
  organizationName: r.organization_name ?? null,
  assignedToUserId: r.assigned_to_user_id ?? null,
  assignedToName: r.assignee_display_name ?? null,
  assignedToEmail: r.assignee_email ?? null,
  hostname: r.hostname,
  websiteUrl: r.website_url,
  businessName: r.business_name ?? null,
  location: r.location ?? null,
  auditId: r.audit_id,
  status: r.status,
  notes: r.notes,
  contactName: r.contact_name,
  contactEmail: r.contact_email,
  contactUrl: r.contact_url,
  evidence: r.evidence ?? null,
  auditedAt: iso(r.audited_at),
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at)!,
});
type SnapshotRow = { id: string; user_id: string; audit_id: string; version: number; content: unknown; created_at: Date };
const rowToSnapshot = (r: SnapshotRow): ClientReportSnapshot => ({ id: r.id, userId: r.user_id, auditId: r.audit_id, version: r.version, content: r.content as ClientReportSnapshotContent, createdAt: iso(r.created_at)! });
const rowToItem = (r: any): BatchItem => ({
  id: r.id,
  batchId: r.batch_id,
  principalId: r.principal_id,
  position: r.position,
  url: r.url,
  maxPages: r.max_pages,
  status: r.status,
  auditId: r.audit_id,
  error: r.error,
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at)!,
});
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * PostgreSQL commerce store. Every balance change happens in one transaction
 * that locks the account row (SELECT … FOR UPDATE), checks the idempotency key,
 * updates the balance and appends the ledger entry — so concurrent requests
 * can never spend the same credits twice, and retries never double-charge.
 * The CHECK (balance >= 0) constraint is a final safety net.
 */
export class PostgresCommerce implements CommerceRepository {
  constructor(private run: Runner) {}

  private async insertEntry(tx: Tx, acc: CreditAccount, e: { delta: number; entryType: string; operation: string; auditId: string | null; idempotencyKey: string; detail: Record<string, unknown> }) {
    const balance = acc.balance + e.delta;
    const [row] = await tx`
      INSERT INTO credit_ledger (principal_id, delta, balance_after, entry_type, operation, audit_id, period_key, idempotency_key, detail)
      VALUES (${acc.principalId}, ${e.delta}, ${balance}, ${e.entryType}, ${e.operation}, ${e.auditId}, ${acc.periodKey}, ${e.idempotencyKey}, ${tx.json(e.detail as Json)})
      RETURNING *`;
    await tx`UPDATE credit_accounts SET balance = ${balance}, updated_at = now() WHERE principal_id = ${acc.principalId}`;
    acc.balance = balance;
    return rowToEntry(row);
  }

  private async lockAccount(tx: Tx, principalId: string): Promise<CreditAccount | null> {
    const [r] = await tx`SELECT * FROM credit_accounts WHERE principal_id = ${principalId} FOR UPDATE`;
    return r ? rowToAccount(r) : null;
  }

  private async entry(sql: Sql | Tx, principalId: string, key: string): Promise<LedgerEntry | null> {
    const [r] = await sql`SELECT * FROM credit_ledger WHERE principal_id = ${principalId} AND idempotency_key = ${key}`;
    return r ? rowToEntry(r) : null;
  }

  async ensureCreditPeriod(principalId: string, p: CreditPeriod): Promise<CreditAccount> {
    return this.run((sql) =>
      sql.begin(async (tx) => {
        await tx`
          INSERT INTO credit_accounts (principal_id, plan_id, balance, allowance, period_key, period_start, period_end)
          VALUES (${principalId}, ${p.planId}, 0, ${p.allowance}, ${p.periodKey}, ${p.periodStart}, ${p.periodEnd})
          ON CONFLICT (principal_id) DO NOTHING`;
        const acc = (await this.lockAccount(tx, principalId))!;
        if (acc.periodKey !== p.periodKey) {
          if (acc.balance > 0) await this.insertEntry(tx, acc, { delta: -acc.balance, entryType: "expire", operation: "period_end", auditId: null, idempotencyKey: `expire:${acc.periodKey}`, detail: { reason: "Unused credits from the previous period expired." } });
          await tx`UPDATE credit_accounts SET plan_id = ${p.planId}, allowance = ${p.allowance}, period_key = ${p.periodKey}, period_start = ${p.periodStart}, period_end = ${p.periodEnd}, updated_at = now() WHERE principal_id = ${principalId}`;
          Object.assign(acc, { planId: p.planId, allowance: p.allowance, periodKey: p.periodKey, periodStart: p.periodStart.toISOString(), periodEnd: p.periodEnd.toISOString() });
        } else if (acc.planId !== p.planId || acc.allowance !== p.allowance) {
          await tx`UPDATE credit_accounts SET plan_id = ${p.planId}, allowance = ${p.allowance}, updated_at = now() WHERE principal_id = ${principalId}`;
          Object.assign(acc, { planId: p.planId, allowance: p.allowance });
        }
        const key = `grant:${p.periodKey}`;
        if (p.allowance > 0 && !(await this.entry(tx, principalId, key))) {
          await this.insertEntry(tx, acc, { delta: p.allowance, entryType: "grant", operation: "monthly_grant", auditId: null, idempotencyKey: key, detail: { plan: p.planId } });
        }
        return acc;
      }) as Promise<CreditAccount>,
    );
  }

  async getCreditAccount(principalId: string) {
    return this.run(async (sql) => {
      const [r] = await sql`SELECT * FROM credit_accounts WHERE principal_id = ${principalId}`;
      return r ? rowToAccount(r) : null;
    });
  }

  async spendCredits(input: SpendInput): Promise<SpendResult> {
    if (!Number.isInteger(input.amount) || input.amount < 0) throw new Error("invalid credit amount");
    return this.run((sql) =>
      sql.begin(async (tx) => {
        const acc = await this.lockAccount(tx, input.principalId);
        if (!acc) return { ok: false, reason: "no_account", balance: 0 } as SpendResult;
        const existing = await this.entry(tx, input.principalId, input.idempotencyKey);
        if (existing) return { ok: true, replayed: true, entry: existing, balance: acc.balance } as SpendResult;
        if (acc.balance < input.amount) return { ok: false, reason: "insufficient_credits", balance: acc.balance } as SpendResult;
        const entry = await this.insertEntry(tx, acc, { delta: -input.amount, entryType: input.entryType, operation: input.operation, auditId: input.auditId ?? null, idempotencyKey: input.idempotencyKey, detail: input.detail ?? {} });
        return { ok: true, replayed: false, entry, balance: acc.balance } as SpendResult;
      }) as Promise<SpendResult>,
    );
  }

  async creditCredits(input: CreditInput): Promise<CreditResult> {
    if (!Number.isInteger(input.amount) || input.amount < 0) throw new Error("invalid credit amount");
    return this.run((sql) =>
      sql.begin(async (tx) => {
        const acc = await this.lockAccount(tx, input.principalId);
        if (!acc) return { replayed: false, entry: null, balance: 0 };
        const existing = await this.entry(tx, input.principalId, input.idempotencyKey);
        if (existing) return { replayed: true, entry: existing, balance: acc.balance };
        const stale = !!input.sourcePeriodKey && input.sourcePeriodKey !== acc.periodKey;
        const detail = { ...(input.detail ?? {}), ...(stale && input.amount > 0 ? { expiredAmount: input.amount, note: "Credits from an earlier billing period are not carried over." } : {}) };
        const entry = await this.insertEntry(tx, acc, { delta: stale ? 0 : input.amount, entryType: input.entryType, operation: input.operation, auditId: input.auditId ?? null, idempotencyKey: input.idempotencyKey, detail });
        return { replayed: false, entry, balance: acc.balance };
      }) as Promise<CreditResult>,
    );
  }

  async getLedgerEntry(principalId: string, key: string) {
    return this.run((sql) => this.entry(sql, principalId, key));
  }

  async listLedger(principalId: string, limit: number, offset: number) {
    return this.run(async (sql) => {
      const rows = await sql`SELECT * FROM credit_ledger WHERE principal_id = ${principalId} ORDER BY created_at DESC, id DESC LIMIT ${limit} OFFSET ${offset}`;
      const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM credit_ledger WHERE principal_id = ${principalId}`;
      return { items: rows.map(rowToEntry), total: n };
    });
  }

  async listUnsettledReservations(limit: number) {
    return this.run(async (sql) =>
      (
        await sql`
          SELECT r.principal_id, r.audit_id, r.created_at FROM credit_ledger r
          WHERE r.entry_type = 'reserve' AND r.audit_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM credit_ledger s WHERE s.principal_id = r.principal_id AND s.idempotency_key = 'audit:' || r.audit_id || ':settle')
          ORDER BY r.created_at ASC LIMIT ${limit}`
      ).map((r) => ({ principalId: r.principal_id as string, auditId: r.audit_id as string, createdAt: iso(r.created_at as Date)! })),
    );
  }

  // ── Prospects ──
  async upsertProspect(principalId: string, input: ProspectInput) {
    return this.run(async (sql) => {
      const [r] = await sql`
        INSERT INTO prospects (id, principal_id, hostname, website_url, business_name, location, audit_id, status, notes, contact_name, contact_email, contact_url, evidence, audited_at)
        VALUES (${randomUUID()}, ${principalId}, ${input.hostname}, ${input.websiteUrl}, ${input.businessName ?? null}, ${input.location ?? null}, ${input.auditId}, ${input.status ?? "new"}, ${input.notes ?? null}, ${input.contactName ?? null}, ${input.contactEmail ?? null}, ${input.contactUrl ?? null}, ${input.evidence ? sql.json(input.evidence as unknown as Json) : null}, ${input.auditedAt})
        ON CONFLICT (principal_id, hostname) DO UPDATE SET
          website_url = EXCLUDED.website_url,
          business_name = CASE WHEN ${input.businessName !== undefined} THEN EXCLUDED.business_name ELSE prospects.business_name END,
          location = CASE WHEN ${input.location !== undefined} THEN EXCLUDED.location ELSE prospects.location END,
          audit_id = COALESCE(EXCLUDED.audit_id, prospects.audit_id),
          evidence = COALESCE(EXCLUDED.evidence, prospects.evidence),
          audited_at = COALESCE(EXCLUDED.audited_at, prospects.audited_at),
          updated_at = now()
        RETURNING *, (xmax = 0) AS created`;
      return { prospect: rowToProspect(r), created: !!r.created };
    });
  }

  async getProspect(principalId: string, id: string, organizationIds: string[] = [], userId: string | null = null) {
    return this.run(async (sql) => {
      const sharedScope = userId
        ? sql`(p.organization_id IS NOT NULL AND EXISTS (SELECT 1 FROM organization_members m WHERE m.organization_id = p.organization_id AND m.user_id = ${userId}))`
        : organizationIds.length
          ? sql`p.organization_id = ANY(${organizationIds}::uuid[])`
          : sql`false`;
      const [r] = await sql`SELECT p.*, assignee.display_name AS assignee_display_name, assignee.email AS assignee_email, org.name AS organization_name
        FROM prospects p LEFT JOIN profiles assignee ON assignee.id = p.assigned_to_user_id
        LEFT JOIN organizations org ON org.id = p.organization_id
        WHERE p.id = ${id} AND (p.principal_id = ${principalId} OR ${sharedScope})`;
      return r ? rowToProspect(r) : null;
    });
  }

  async updateProspect(principalId: string, id: string, patch: ProspectPatch, organizationIds: string[] = [], actorUserId: string | null = null) {
    const cols: Record<string, unknown> = {};
    if (patch.status !== undefined) cols.status = patch.status;
    if (patch.notes !== undefined) cols.notes = patch.notes;
    if (patch.businessName !== undefined) cols.business_name = patch.businessName;
    if (patch.location !== undefined) cols.location = patch.location;
    if (patch.contactName !== undefined) cols.contact_name = patch.contactName;
    if (patch.contactEmail !== undefined) cols.contact_email = patch.contactEmail;
    if (patch.contactUrl !== undefined) cols.contact_url = patch.contactUrl;
    if (patch.organizationId !== undefined) cols.organization_id = patch.organizationId;
    if (patch.assignedToUserId !== undefined) cols.assigned_to_user_id = patch.assignedToUserId;
    if (patch.organizationId === null && patch.assignedToUserId === undefined) cols.assigned_to_user_id = null;

    return this.run(async (sql) => {
      if (!Object.keys(cols).length) return this.getProspect(principalId, id, organizationIds, actorUserId);
      return sql.begin(async (tx) => {
        const [initial] = await tx<{ principal_id: string; organization_id: string | null }[]>`SELECT principal_id, organization_id FROM prospects WHERE id = ${id}`;
        if (!initial) return null;
        const targetOrganizationId = patch.organizationId !== undefined ? patch.organizationId : initial.organization_id;
        const lockIds = [...new Set([initial.organization_id, targetOrganizationId].filter((x): x is string => !!x))].sort();
        for (const orgId of lockIds) await tx`SELECT id FROM organizations WHERE id = ${orgId} FOR UPDATE`;

        const [current] = await tx<{ principal_id: string; organization_id: string | null; assigned_to_user_id: string | null }[]>`SELECT principal_id, organization_id, assigned_to_user_id FROM prospects WHERE id = ${id} FOR UPDATE`;
        if (!current || current.organization_id !== initial.organization_id) return null;
        const isOwner = current.principal_id === principalId;
        let actorRole: string | null = null;
        if (current.organization_id && actorUserId) {
          const [membership] = await tx<{ role: string }[]>`SELECT role FROM organization_members WHERE organization_id = ${current.organization_id} AND user_id = ${actorUserId} FOR UPDATE`;
          actorRole = membership?.role ?? null;
        }
        if (!isOwner && (!current.organization_id || !actorRole)) return null;
        if (patch.organizationId !== undefined && !isOwner) return null;
        if (patch.assignedToUserId !== undefined && !isOwner && actorRole !== "owner" && actorRole !== "admin") return null;
        if (targetOrganizationId && (!actorUserId || !isOwner && targetOrganizationId !== current.organization_id)) return null;

        if (targetOrganizationId) {
          const [membership] = await tx<{ role: string }[]>`SELECT role FROM organization_members WHERE organization_id = ${targetOrganizationId} AND user_id = ${actorUserId} FOR UPDATE`;
          if (!membership) return null;
          if (targetOrganizationId === current.organization_id) actorRole = membership.role;
        }
        const nextAssignee = patch.assignedToUserId !== undefined
          ? patch.assignedToUserId
          : (patch.organizationId !== undefined && patch.organizationId !== current.organization_id ? null : current.assigned_to_user_id);
        if (patch.organizationId !== undefined && patch.assignedToUserId === undefined) cols.assigned_to_user_id = nextAssignee;
        if (nextAssignee) {
          if (!targetOrganizationId) return null;
          const [assignee] = await tx<{ user_id: string }[]>`SELECT user_id FROM organization_members WHERE organization_id = ${targetOrganizationId} AND user_id = ${nextAssignee} FOR UPDATE`;
          if (!assignee) return null;
        }

        const [updated] = await tx`UPDATE prospects SET ${tx(cols as Record<string, string | null>)}, updated_at = now() WHERE id = ${id} RETURNING id`;
        if (!updated) return null;
        const actorId = actorUserId ?? principalId;
        const log = async (orgId: string, event: string, details: Record<string, unknown> = {}) => {
          await tx`INSERT INTO organization_activity (organization_id, actor_user_id, event_type, prospect_id, details)
            VALUES (${orgId}, ${actorId}, ${event}, ${id}, ${tx.json(details as Json)})`;
        };
        if (current.organization_id !== targetOrganizationId) {
          if (current.organization_id) await log(current.organization_id, "prospect_unshared");
          if (targetOrganizationId) await log(targetOrganizationId, "prospect_shared");
        }
        if (nextAssignee !== current.assigned_to_user_id && targetOrganizationId) {
          await log(targetOrganizationId, "prospect_assigned", { assignedToUserId: nextAssignee });
        }
        const contentChanges = ["status", "notes", "businessName", "location", "contactName", "contactEmail", "contactUrl"].filter((key) => Object.hasOwn(patch, key));
        if (contentChanges.length && targetOrganizationId && current.organization_id === targetOrganizationId) {
          await log(targetOrganizationId, "prospect_updated", { fields: contentChanges });
        }
        const [row] = await tx`SELECT p.*, assignee.display_name AS assignee_display_name, assignee.email AS assignee_email, org.name AS organization_name
          FROM prospects p LEFT JOIN profiles assignee ON assignee.id = p.assigned_to_user_id
          LEFT JOIN organizations org ON org.id = p.organization_id WHERE p.id = ${id}`;
        return row ? rowToProspect(row) : null;
      });
    });
  }

  async deleteProspect(principalId: string, id: string) {
    return this.run(async (sql) => (await sql`DELETE FROM prospects WHERE id = ${id} AND principal_id = ${principalId} RETURNING id`).length > 0);
  }

  async listProspects(q: ProspectQuery) {
    return this.run(async (sql) => {
      const term = q.search?.trim().toLowerCase() || null;
      const like = term ? `%${likeEscape(term)}%` : null;
      const status = q.status && q.status !== "all" ? q.status : null;
      const sharedScope = q.userId
        ? sql`OR (p.organization_id IS NOT NULL AND EXISTS (SELECT 1 FROM organization_members m WHERE m.organization_id = p.organization_id AND m.user_id = ${q.userId}))`
        : q.organizationIds?.length
          ? sql`OR p.organization_id = ANY(${q.organizationIds}::uuid[])`
          : sql``;
      const scope = sql`(p.principal_id = ${q.principalId} ${sharedScope})`;
      const where = sql`${scope}
        ${status ? sql`AND p.status = ${status}` : sql``}
        ${like ? sql`AND (p.hostname LIKE ${like} OR lower(coalesce(p.business_name, '')) LIKE ${like} OR lower(coalesce(p.location, '')) LIKE ${like} OR lower(coalesce(p.notes, '')) LIKE ${like} OR lower(coalesce(p.contact_name, '')) LIKE ${like})` : sql``}`;
      const rows = await sql`SELECT p.*, assignee.display_name AS assignee_display_name, assignee.email AS assignee_email, org.name AS organization_name
        FROM prospects p LEFT JOIN profiles assignee ON assignee.id = p.assigned_to_user_id
        LEFT JOIN organizations org ON org.id = p.organization_id
        WHERE ${where} ORDER BY p.updated_at DESC, p.id DESC LIMIT ${q.limit} OFFSET ${q.offset}`;
      const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM prospects p WHERE ${where}`;
      const counts = await sql<{ status: ProspectStatus; n: number }[]>`SELECT p.status, count(*)::int AS n FROM prospects p WHERE ${scope} GROUP BY p.status`;
      const byStatus = Object.fromEntries(PROSPECT_STATUSES.map((s) => [s, counts.find((c) => c.status === s)?.n ?? 0])) as Record<ProspectStatus, number>;
      return { items: rows.map(rowToProspect), total: n, byStatus };
    });
  }

  async countProspects(principalId: string) {
    return this.run(async (sql) => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM prospects WHERE principal_id = ${principalId}`)[0].n);
  }

  async findProspectByHostname(principalId: string, hostname: string) {
    return this.run(async (sql) => {
      const [r] = await sql`SELECT * FROM prospects WHERE principal_id = ${principalId} AND hostname = ${hostname}`;
      return r ? rowToProspect(r) : null;
    });
  }

  // ── Batches ──
  async createBatch(b: AuditBatch) {
    await this.run((sql) =>
      sql.begin(async (tx) => {
        await tx`INSERT INTO audit_batches (id, principal_id, ip_hash, created_at) VALUES (${b.id}, ${b.principalId}, ${b.ipHash}, ${b.createdAt})`;
        for (const i of b.items) {
          await tx`INSERT INTO audit_batch_items (id, batch_id, principal_id, position, url, max_pages, status, audit_id, error, created_at, updated_at)
                   VALUES (${i.id}, ${b.id}, ${b.principalId}, ${i.position}, ${i.url}, ${i.maxPages}, ${i.status}, ${i.auditId}, ${i.error}, ${i.createdAt}, ${i.updatedAt})`;
        }
      }),
    );
  }

  private async items(sql: Sql, batchIds: string[]) {
    if (!batchIds.length) return [];
    return (await sql`SELECT * FROM audit_batch_items WHERE batch_id IN ${sql(batchIds)} ORDER BY position`).map(rowToItem);
  }

  async getBatch(principalId: string, id: string) {
    return this.run(async (sql) => {
      const [b] = await sql`SELECT * FROM audit_batches WHERE id = ${id} AND principal_id = ${principalId}`;
      if (!b) return null;
      return { id: b.id, principalId: b.principal_id, ipHash: b.ip_hash, createdAt: iso(b.created_at)!, items: await this.items(sql, [b.id]) } as AuditBatch;
    });
  }

  async listBatches(principalId: string, limit: number) {
    return this.run(async (sql) => {
      const rows = await sql`SELECT * FROM audit_batches WHERE principal_id = ${principalId} ORDER BY created_at DESC LIMIT ${limit}`;
      const items = await this.items(sql, rows.map((r) => r.id as string));
      return rows.map((b) => ({ id: b.id, principalId: b.principal_id, ipHash: b.ip_hash, createdAt: iso(b.created_at)!, items: items.filter((i) => i.batchId === b.id) }) as AuditBatch);
    });
  }

  async claimNextBatchItem(principalId: string) {
    return this.run(async (sql) => {
      const [r] = await sql`
        UPDATE audit_batch_items SET status = 'started', updated_at = now()
        WHERE id = (SELECT id FROM audit_batch_items WHERE principal_id = ${principalId} AND status = 'pending' ORDER BY created_at, position LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING *`;
      return r ? rowToItem(r) : null;
    });
  }

  async updateBatchItem(id: string, patch: Partial<Pick<BatchItem, "status" | "auditId" | "error">>) {
    const cols: Record<string, string | null> = {};
    if (patch.status !== undefined) cols.status = patch.status;
    if (patch.auditId !== undefined) cols.audit_id = patch.auditId;
    if (patch.error !== undefined) cols.error = patch.error;
    if (!Object.keys(cols).length) return;
    await this.run((sql) => sql`UPDATE audit_batch_items SET ${sql(cols)}, updated_at = now() WHERE id = ${id}`);
  }

  async listPrincipalsWithPendingBatchItems(limit: number) {
    return this.run(async (sql) =>
      (
        await sql`
          SELECT DISTINCT ON (i.principal_id) i.principal_id, b.ip_hash FROM audit_batch_items i JOIN audit_batches b ON b.id = i.batch_id
          WHERE i.status = 'pending' ORDER BY i.principal_id, i.created_at LIMIT ${limit}`
      ).map((r) => ({ principalId: r.principal_id as string, ipHash: (r.ip_hash as string | null) ?? null })),
    );
  }

  // ── Immutable report snapshots ──
  async createReportSnapshot(userId: string, auditId: string, content: ClientReportSnapshotContent): Promise<ClientReportSnapshot> {
    return this.run((sql) => sql.begin(async (tx) => {
      const [audit] = await tx<{ id: string }[]>`SELECT id FROM audits WHERE id = ${auditId} AND owner_id = ${userId} FOR UPDATE`;
      if (!audit) throw new Error("Cannot snapshot a report for an audit not owned by this account.");
      const [v] = await tx<{ next_version: number }[]>`SELECT (COALESCE(MAX(version), 0) + 1)::int AS next_version FROM client_report_snapshots WHERE user_id = ${userId} AND audit_id = ${auditId}`;
      const [row] = await tx<SnapshotRow[]>`
        INSERT INTO client_report_snapshots (id, user_id, audit_id, version, content)
        VALUES (${randomUUID()}, ${userId}, ${auditId}, ${v.next_version}, ${tx.json(content as unknown as Json)})
        RETURNING id, user_id, audit_id, version, content, created_at`;
      return rowToSnapshot(row);
    }) as Promise<ClientReportSnapshot>);
  }

  async getReportSnapshot(userId: string, snapshotId: string): Promise<ClientReportSnapshot | null> {
    return this.run(async (sql) => {
      const [row] = await sql<SnapshotRow[]>`SELECT id, user_id, audit_id, version, content, created_at FROM client_report_snapshots WHERE user_id = ${userId} AND id = ${snapshotId}`;
      return row ? rowToSnapshot(row) : null;
    });
  }

  async deleteReportSnapshot(userId: string, snapshotId: string): Promise<void> {
    await this.run((sql) => sql`DELETE FROM client_report_snapshots WHERE user_id = ${userId} AND id = ${snapshotId}`);
  }

  // ── Report shares ──
  async createReportShare(x: ReportShare) {
    await this.run(
      (sql) => sql`
        INSERT INTO report_shares (id, principal_id, audit_id, snapshot_id, token_hash, label, allow_pdf, created_at, expires_at)
        VALUES (${x.id}, ${x.principalId}, ${x.auditId}, ${x.snapshotId ?? null}, ${x.tokenHash}, ${x.label}, ${x.allowPdf}, ${x.createdAt}, ${x.expiresAt})`,
    );
  }

  async listReportShares(principalId: string, auditId: string) {
    return this.run(async (sql) => (await sql`
      SELECT rs.*, s.version AS snapshot_version FROM report_shares rs
      LEFT JOIN client_report_snapshots s ON s.id = rs.snapshot_id
      WHERE rs.principal_id = ${principalId} AND rs.audit_id = ${auditId}
      ORDER BY rs.created_at DESC LIMIT 50`).map(rowToShare));
  }

  async revokeReportShare(principalId: string, id: string) {
    return this.run(async (sql) => (await sql`UPDATE report_shares SET revoked_at = now() WHERE id = ${id} AND principal_id = ${principalId} AND revoked_at IS NULL`).count > 0);
  }

  async useReportShare(tokenHash: string) {
    return this.run(async (sql) => {
      const [r] = await sql`
        UPDATE report_shares SET view_count = view_count + 1, last_viewed_at = now()
        WHERE token_hash = ${tokenHash} AND revoked_at IS NULL AND expires_at > now()
        RETURNING *`;
      return r ? rowToShare(r) : null;
    });
  }
}

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
function rowToShare(r: any): ReportShare {
  return {
    id: r.id,
    principalId: r.principal_id,
    auditId: r.audit_id,
    snapshotId: r.snapshot_id ?? null,
    snapshotVersion: r.snapshot_version ?? null,
    tokenHash: r.token_hash,
    label: r.label ?? null,
    allowPdf: r.allow_pdf,
    createdAt: iso(r.created_at)!,
    expiresAt: iso(r.expires_at)!,
    revokedAt: iso(r.revoked_at),
    lastViewedAt: iso(r.last_viewed_at),
    viewCount: r.view_count,
  };
}
