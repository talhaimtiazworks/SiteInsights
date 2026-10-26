import type { EmailEnvironment } from "../email/smtp-config.mjs";
export function runConfigureAuth(options?: {
  argv?: string[];
  env?: EmailEnvironment;
  fetchImpl?: typeof fetch;
  output?: (...values: unknown[]) => void;
  errorOutput?: (...values: unknown[]) => void;
}): Promise<number>;
