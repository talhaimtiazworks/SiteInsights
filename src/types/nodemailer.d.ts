declare module "nodemailer" {
  export interface AddressObject { name?: string; address: string }
  export interface RecipientAddressObject { address: string }
  export interface SentMessageInfo {
    accepted?: Array<string | RecipientAddressObject>;
    rejected?: Array<string | RecipientAddressObject>;
  }
  export interface Transporter {
    sendMail(message: Record<string, unknown>): Promise<SentMessageInfo>;
    close(): void;
  }
  export function createTransport(options: Record<string, unknown>): Transporter;
  const nodemailer: { createTransport: typeof createTransport };
  export default nodemailer;
}
