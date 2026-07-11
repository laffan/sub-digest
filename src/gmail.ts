import { invoke } from "@tauri-apps/api/core";
import type { PostMeta } from "./types";

/** Starts the OAuth flow in the system browser; resolves with the account email. */
export function gmailConnect(clientId: string, clientSecret: string): Promise<string> {
  return invoke<string>("gmail_connect", { clientId, clientSecret });
}

/** Returns the connected account's email if a stored token is still usable. */
export function gmailStatus(): Promise<string | null> {
  return invoke<string | null>("gmail_status");
}

export function gmailDisconnect(): Promise<void> {
  return invoke<void>("gmail_disconnect");
}

/** Lists Substack emails newer than `afterMs` (epoch millis). */
export function gmailSearch(afterMs: number): Promise<PostMeta[]> {
  return invoke<PostMeta[]>("gmail_search", { afterMs });
}

/** Returns the HTML body of a message (plain text is wrapped by the backend). */
export function gmailGetBody(id: string): Promise<string> {
  return invoke<string>("gmail_get_body", { id });
}

/** Fetches an image over HTTPS and returns raw bytes as base64. */
export function fetchImageB64(imageUrl: string): Promise<string> {
  return invoke<string>("fetch_image", { imageUrl });
}

export function savePdf(path: string, bytesB64: string): Promise<void> {
  return invoke<void>("save_pdf", { path, bytesB64 });
}

/** Extracts a human publication name from a From header. */
export function publicationFromHeader(from: string): string {
  const m = from.match(/^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/);
  if (m) return m[1].trim();
  // Bare address: use the local part
  const addr = from.match(/([\w.+-]+)@/);
  return addr ? addr[1] : from.trim();
}
