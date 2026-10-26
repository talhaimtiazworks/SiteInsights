import type { EmailEnvironment } from "./smtp-config.mjs";
import { createSmtpService } from "./smtp-service.mjs";
export function runSmtpCheck(options?: {
  argv?: string[];
  env?: EmailEnvironment;
  makeService?: typeof createSmtpService;
  output?: (value: unknown) => void;
}): Promise<number>;
