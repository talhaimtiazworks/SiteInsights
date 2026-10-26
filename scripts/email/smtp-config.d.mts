export class SmtpConfigurationError extends Error {
  code: string;
  variables: string[];
  constructor(message: string, variables: string[]);
}

export type EmailEnvironment = Record<string, string | undefined>;

export interface MailjetSmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  readonly user: string;
  readonly password: string;
  readonly from: string;
}

export function readMailjetSmtpConfig(env?: NodeJS.ProcessEnv | Record<string, string | undefined>): MailjetSmtpConfig;
export function smtpTransportOptions(config: MailjetSmtpConfig): Record<string, unknown>;
export function mailjetSmtpPatch(env?: NodeJS.ProcessEnv | Record<string, string | undefined>): Record<string, string>;
