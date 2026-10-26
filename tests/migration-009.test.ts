import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MIGRATIONS } from "@/lib/db/migrations";

describe("team invitation delivery migration 009", () => {
  const migration = MIGRATIONS.find((entry) => entry.version === "009_invitation_email_delivery");

  it("keeps generated SQL exactly aligned with the reviewed source migration", () => {
    expect(migration).toBeDefined();
    expect(migration!.sql).toBe(readFileSync(path.join(process.cwd(), "db/migrations/009_invitation_email_delivery.sql"), "utf8"));
  });

  it("stores only controlled email outcome fields and indexes recipient inbox lookup", () => {
    const sql = migration!.sql.toLowerCase();
    expect(sql).toContain("email_delivery_status");
    expect(sql).toContain("'not_attempted','accepted','failed','unknown','not_configured'");
    expect(sql).toContain("email_error_code ~ '^[a-z0-9_]{1,64}$'");
    expect(sql).toContain("organization_invitations_pending_recipient_idx");
    expect(sql).toContain("'invitation_resent'");
    expect(sql).not.toMatch(/token[^_a-z]|email_body|provider_response/i);
  });
});
