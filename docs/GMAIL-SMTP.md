# Retired SMTP guide

The former Gmail setup has been replaced by **[Mailjet SMTP setup](MAILJET-SMTP.md)**. This compatibility pointer keeps old documentation links from breaking; it contains no active provider configuration instructions.

Use the existing six variables with Mailjet API key / Secret Key credentials and a separately verified sender. Hosted **Supabase Auth still owns authentication delivery**; Vercel environment variables do not configure it. No real delivery is claimed verified. Current results: [RELEASE-VERIFICATION.md](RELEASE-VERIFICATION.md).
