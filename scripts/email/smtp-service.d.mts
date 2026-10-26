import type { EmailEnvironment, SmtpTransportOptions } from "./smtp-config.mjs";
export interface SmtpResult {
  ok: boolean;
  accepted: boolean;
  code: string;
  message: string;
  delivery: "not_sent" | "not_accepted" | "unknown" | "accepted_by_smtp";
  automaticRetry: false;
}
export interface DiagnosticTransport {
  verify(): Promise<boolean>;
  sendMail(message: Record<string, unknown>): Promise<{ accepted?: (string | { address: string })[]; rejected?: (string | { address: string })[] }>;
  close?(): void;
}
export function safeSmtpFailure(error: unknown, operation: "verify" | "send-test"): SmtpResult;
export function createSmtpService(options?: {
  env?: EmailEnvironment;
  createTransport?: (options: SmtpTransportOptions) => DiagnosticTransport;
  auditLog?: (entry: Record<string, string | boolean>) => void;
}): { verify(): Promise<SmtpResult>; sendTest(): Promise<SmtpResult> };
