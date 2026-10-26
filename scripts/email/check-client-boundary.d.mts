import type { EmailEnvironment } from "./smtp-config.mjs";
export function checkSmtpClientBoundary(options?: { projectRoot?: string; env?: EmailEnvironment }): Promise<{
  ok: boolean;
  code: string;
  message: string;
  filesScanned?: number;
  filesWithMatches?: number;
}>;
