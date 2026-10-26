import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ORGANIZATION_INVITATION_EMAIL_NOT_CONFIGURED } from "@/lib/services/organization-invitation-email";

describe("invitation delivery boundary", () => {
  it("reports email as not configured and never claims a send", () => {
    expect(ORGANIZATION_INVITATION_EMAIL_NOT_CONFIGURED).toEqual({
      status: "not_configured",
      errorCode: "email_not_configured",
      message: expect.stringMatching(/recipient can accept or decline.*Invitation inbox/i),
    });
  });

  it("does not import an app-runtime SMTP or Nodemailer transport", () => {
    const source = readFileSync(path.join(process.cwd(), "src/lib/services/organization-invitation-email.ts"), "utf8");
    expect(source).not.toMatch(/from\s+["']nodemailer["']/);
    expect(source).not.toMatch(/smtp-config\.mjs/);
    expect(source).not.toContain("sendMail(");
  });
});
