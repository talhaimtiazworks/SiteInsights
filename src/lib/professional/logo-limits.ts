/**
 * Shared limits for private PNG/JPEG professional logos.
 * The data-URI and JSON bounds are derived from the exact raw-byte cap rather
 * than approximated from "KB" values, so the browser, API, schema and storage
 * agree on one MiB (1,048,576 decoded bytes).
 */
export const MAX_LOGO_BYTES = 1_048_576;
export const MAX_LOGO_BASE64_CHARS = Math.ceil(MAX_LOGO_BYTES / 3) * 4;
export const MAX_LOGO_DATA_URL_CHARS = "data:image/jpeg;base64,".length + MAX_LOGO_BASE64_CHARS;
export const MAX_LOGO_DIMENSION = 2_048;
export const MAX_LOGO_PIXELS = 2_000_000;

/** Includes bounded profile/service/portfolio JSON around a maximum-sized logo. */
export const MAX_PROFESSIONAL_PROFILE_BODY_BYTES = 2 * 1_048_576;
