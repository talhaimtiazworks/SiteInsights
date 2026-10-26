import { describe, expect, it } from "vitest";
import { MIGRATIONS } from "@/lib/db/migrations";

describe("professional reports migration 007", () => {
  const migration = MIGRATIONS.find((m) => m.version === "007_professional_reports_and_prospects");

  it("adds server-only profile, service, portfolio, snapshot and manual prospect fields", () => {
    expect(migration).toBeDefined();
    const sql = migration!.sql.toLowerCase();
    for (const table of ["professional_profiles", "professional_services", "professional_portfolio_items", "client_report_snapshots"]) {
      expect(sql).toContain(`create table if not exists ${table}`);
      expect(sql).toContain(`alter table ${table} enable row level security`);
    }
    expect(sql).toContain("add column if not exists snapshot_id");
    expect(sql).toContain("add column if not exists business_name");
    expect(sql).toContain("add column if not exists location");
    expect(sql).toContain("revoke update on public.profiles from authenticated");
    expect(sql).toContain("revoke update (avatar_url) on public.profiles from authenticated");
    expect(sql).toContain("char_length(logo_data_url) <= 1398127");
    expect(sql).toContain("octet_length(decode(split_part(logo_data_url, ',', 2), 'base64')) <= 1048576");
    expect(sql).not.toContain("grant update (display_name, avatar_url)");
  });
});
