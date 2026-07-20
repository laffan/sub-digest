/**
 * Gmail OAuth configuration, read from `.env` at build/dev time by Vite.
 * Only variables prefixed `VITE_` are exposed to the app. See `.env.example`.
 */
// Desktop (loopback) client — a Desktop-app OAuth client, with secret.
export const OAUTH_CLIENT_ID = (import.meta.env.VITE_GMAIL_CLIENT_ID ?? "").trim();
export const OAUTH_CLIENT_SECRET = (import.meta.env.VITE_GMAIL_CLIENT_SECRET ?? "").trim();

// iOS client — a separate iOS OAuth client (public, PKCE, no secret). The
// redirect scheme defaults to the app's bundle id; the backend picks the iOS
// values automatically when running on iOS.
export const OAUTH_IOS_CLIENT_ID = (import.meta.env.VITE_GMAIL_IOS_CLIENT_ID ?? "").trim();
export const OAUTH_IOS_REDIRECT_SCHEME = (
  import.meta.env.VITE_GMAIL_IOS_REDIRECT_SCHEME ?? "com.subdigest.app"
).trim();

/** Fixed loopback port for the desktop OAuth redirect; must match the registered URI. */
export const OAUTH_REDIRECT_PORT =
  Number(import.meta.env.VITE_OAUTH_REDIRECT_PORT ?? "") || 8788;

/** The exact desktop redirect URI to register in the Google Cloud Console. */
export const OAUTH_REDIRECT_URI = `http://127.0.0.1:${OAUTH_REDIRECT_PORT}`;

/** True when either platform's credentials are present. */
export const HAS_CREDENTIALS =
  (OAUTH_CLIENT_ID.length > 0 && OAUTH_CLIENT_SECRET.length > 0) ||
  OAUTH_IOS_CLIENT_ID.length > 0;
