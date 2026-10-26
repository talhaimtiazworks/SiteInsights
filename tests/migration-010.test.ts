import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MIGRATIONS } from "@/lib/db/migrations";

describe("API sequence privilege hardening migration 010", () => {
  const migration = MIGRATIONS.find((entry) => entry.version === "010_revoke_late_sequence_grants");

  it("keeps generated SQL exactly aligned with the reviewed source migration", () => {
    expect(migration).toBeDefined();
    expect(migration!.sql).toBe(readFileSync(path.join(process.cwd(), "db/migrations/010_revoke_late_sequence_grants.sql"), "utf8"));
  });

  it("revokes default Data API grants from every public sequence", () => {
    const sql = migration!.sql.toLowerCase();
    expect(sql).toContain("n.nspname = 'public'");
    expect(sql).toContain("c.relkind = 's'");
    expect(sql).toContain("revoke all on sequence %s from public");
    expect(sql).toContain("revoke all on sequence %s from anon");
    expect(sql).toContain("revoke all on sequence %s from authenticated");
  });
});
