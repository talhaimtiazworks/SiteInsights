import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MIGRATIONS } from "@/lib/db/migrations";

describe("team collaboration migration 008", () => {
  const migration = MIGRATIONS.find((m) => m.version === "008_team_collaboration");

  it("keeps the generated migration exactly aligned with the reviewed source SQL", () => {
    expect(migration).toBeDefined();
    expect(migration!.sql).toBe(readFileSync(path.join(process.cwd(), "db/migrations/008_team_collaboration.sql"), "utf8"));
  });

  it("adds explicit sharing/invitation/activity storage with server-only Data API access", () => {
    const sql = migration!.sql.toLowerCase();
    expect(sql).toContain("add column if not exists organization_id uuid references organizations");
    expect(sql).toContain("add column if not exists assigned_to_user_id uuid references profiles");
    expect(sql).toContain("prospects_assignee_requires_organization");
    expect(sql).toContain("create table if not exists organization_invitations");
    expect(sql).toContain("create table if not exists organization_activity");
    expect(sql).toContain("alter table organization_invitations enable row level security");
    expect(sql).toContain("alter table organization_activity enable row level security");
    expect(sql).toContain("revoke all on table organization_invitations, organization_activity from public");
    expect(sql).toContain("revoke all on table organization_invitations, organization_activity from authenticated");
    expect(sql).toContain("char_length(logo_data_url) <= 1398127");
    expect(sql).toContain("octet_length(decode(split_part(logo_data_url, ',', 2), 'base64')) <= 1048576");
  });
});
