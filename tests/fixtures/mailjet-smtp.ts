/** Deliberately invalid-as-issued canaries, NOT credentials for any real Mailjet account. */
export const MAILJET_TEST_USER = "test-mailjet-api-key-do-not-use-01";
export const MAILJET_TEST_PASS = "test-mailjet-secret-key-do-not-use-02";
export const MAILJET_TEST_FROM = "smtp-sender-fixture@example.test";
export const MAILJET_TEST_ENV = {
  SMTP_HOST: "in-v3.mailjet.com",
  SMTP_PORT: "587",
  SMTP_SECURE: "false",
  SMTP_USER: MAILJET_TEST_USER,
  SMTP_PASS: MAILJET_TEST_PASS,
  EMAIL_FROM: MAILJET_TEST_FROM,
};
