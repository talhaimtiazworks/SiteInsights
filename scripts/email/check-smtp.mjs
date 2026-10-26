#!/usr/bin/env node
/** Explicit operator-only diagnostics. Default is offline configuration validation. */
import { pathToFileURL } from "node:url";
import { readMailjetSmtpConfig, SmtpConfigurationError } from "./smtp-config.mjs";
import { createSmtpService } from "./smtp-service.mjs";

export async function runSmtpCheck({ argv = process.argv.slice(2), env = process.env, makeService = createSmtpService, output = (value) => console.log(JSON.stringify(value)) } = {}) {
  try {
    const allowed = new Set(["--config-only", "--verify", "--send-test", "--help"]);
    if (argv.some((flag) => !allowed.has(flag)) || new Set(argv).size !== argv.length) throw new SmtpConfigurationError("Use exactly one of --config-only, --verify or --send-test; credentials must only be in the environment.", []);
    if (argv.includes("--help")) {
      output({ usage: "npm run email:check -- [--config-only | --verify | --send-test]", default: "--config-only: offline validation, no connection", verify: "Connects/authenticates, sends no email", sendTest: "Sends ONE test only to EMAIL_FROM (your verified sender); no retries or arbitrary recipient. Not a Supabase delivery test." });
      return 0;
    }
    if (argv.filter((a) => a !== "--help").length > 1) throw new SmtpConfigurationError("Choose only one SMTP diagnostic mode.", []);
    readMailjetSmtpConfig(env);
    if (!argv.length || argv.includes("--config-only")) {
      output({ ok: true, code: "smtp_configuration_valid", accepted: false, delivery: "not_sent", message: "Local configuration format is valid. No network connection or email was attempted; Mailjet credentials, sender approval and Supabase settings are not verified." });
      return 0;
    }
    const service = makeService({ env, auditLog: () => {} });
    const result = await (argv.includes("--send-test") ? service.sendTest() : service.verify());
    output(result); // Safe result fields only, never the transport/config/error object.
    return result.ok ? 0 : 1;
  } catch (error) {
    output(error instanceof SmtpConfigurationError
      ? { ok: false, code: error.code, message: error.message, variables: error.variables, delivery: "not_sent", accepted: false }
      : { ok: false, code: "smtp_check_failed", message: "The SMTP check could not be completed. No credential or transport details are logged. Inspect the account and configuration privately.", accepted: false, delivery: "unknown" });
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await runSmtpCheck();
