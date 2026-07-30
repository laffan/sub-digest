import { invoke } from "@tauri-apps/api/core";
import {
  OAUTH_CLIENT_ID,
  OAUTH_CLIENT_SECRET,
  OAUTH_IOS_CLIENT_ID,
  OAUTH_IOS_REDIRECT_SCHEME,
  OAUTH_REDIRECT_PORT,
} from "./config";
import type { MailFilter, PostMeta } from "./types";

/**
 * Starts the OAuth flow in the system browser; resolves with the account email.
 * All platform credentials are passed; the backend selects desktop (loopback)
 * or iOS (custom-scheme deep link) based on the OS it's running on.
 */
export function gmailConnect(): Promise<string> {
  return invoke<string>("gmail_connect", {
    clientId: OAUTH_CLIENT_ID,
    clientSecret: OAUTH_CLIENT_SECRET,
    iosClientId: OAUTH_IOS_CLIENT_ID,
    iosRedirectScheme: OAUTH_IOS_REDIRECT_SCHEME,
    redirectPort: OAUTH_REDIRECT_PORT,
  });
}

/** Aborts an in-flight connect attempt and frees the loopback port. */
export function gmailCancelConnect(): Promise<void> {
  return invoke<void>("gmail_cancel_connect");
}

/** Returns the connected account's email if a stored token is still usable. */
export function gmailStatus(): Promise<string | null> {
  return invoke<string | null>("gmail_status");
}

export function gmailDisconnect(): Promise<void> {
  return invoke<void>("gmail_disconnect");
}

/**
 * Lists emails matching any of `filters` between `afterMs` and `beforeMs`
 * (epoch millis). Either bound may be 0, meaning open-ended on that side.
 * The backend turns the filters into one Gmail query.
 */
export function gmailSearch(
  afterMs: number,
  beforeMs: number,
  filters: MailFilter[]
): Promise<PostMeta[]> {
  return invoke<PostMeta[]>("gmail_search", { afterMs, beforeMs, filters });
}

/** Returns the HTML body of a message (plain text is wrapped by the backend). */
export function gmailGetBody(id: string): Promise<string> {
  return invoke<string>("gmail_get_body", { id });
}

/** Fetches an image over HTTPS and returns raw bytes as base64. */
export function fetchImageB64(imageUrl: string): Promise<string> {
  return invoke<string>("fetch_image", { imageUrl });
}

/** Writes a generated document (PDF or EPUB) to a path the user picked. */
export function saveFile(path: string, bytesB64: string): Promise<void> {
  return invoke<void>("save_file", { path, bytesB64 });
}

/** Extracts a human publication name from a From header. */
export function publicationFromHeader(from: string): string {
  const m = from.match(/^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/);
  if (m) return m[1].trim();
  // Bare address: use the local part
  const addr = from.match(/([\w.+-]+)@/);
  return addr ? addr[1] : from.trim();
}
