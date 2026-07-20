/**
 * Gmail OAuth configuration, read from `.env` at build/dev time by Vite.
 * Only variables prefixed `VITE_` are exposed to the app. See `.env.example`.
 */
export const OAUTH_CLIENT_ID = (import.meta.env.VITE_GMAIL_CLIENT_ID ?? "").trim();
export const OAUTH_CLIENT_SECRET = (import.meta.env.VITE_GMAIL_CLIENT_SECRET ?? "").trim();

/** Fixed loopback port for the OAuth redirect; must match the registered URI. */
export const OAUTH_REDIRECT_PORT =
  Number(import.meta.env.VITE_OAUTH_REDIRECT_PORT ?? "") || 8788;

/** The exact redirect URI to register in the Google Cloud Console. */
export const OAUTH_REDIRECT_URI = `http://127.0.0.1:${OAUTH_REDIRECT_PORT}`;

export const HAS_CREDENTIALS = OAUTH_CLIENT_ID.length > 0 && OAUTH_CLIENT_SECRET.length > 0;
