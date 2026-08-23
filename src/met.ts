import { invoke } from "@tauri-apps/api/core";
import type { CoverArtwork } from "./types";

/**
 * The Metropolitan Museum of Art's open collection API, which is where cover
 * pictures come from: <https://metmuseum.github.io>. The request itself runs in
 * Rust — no CORS, and one search is a dozen or so calls, which is work the
 * webview shouldn't be doing.
 */

/** How many candidates a search brings back for the picker's grid. */
export const COVER_RESULTS = 18;

/**
 * Searches the museum's open-access collection for `theme` and returns the
 * pieces that have a picture, in the museum's own relevance order.
 */
export function metSearch(theme: string, limit = COVER_RESULTS): Promise<CoverArtwork[]> {
  return invoke<CoverArtwork[]>("met_search", { query: theme, limit });
}

/** A line of the credit under the contents, and how it should be set. */
export interface CreditLine {
  text: string;
  /** `title` is the artwork's own name; `muted` is the small print. */
  weight: "title" | "body" | "muted";
}

/** What the credit is headed, wherever it's drawn. */
export const CREDIT_HEADING = "ON THE COVER";

/**
 * The cover picture's credit: what it is, who made it and when, then what it's
 * made of and where it lives. The PDF, the EPUB and the picker all set these
 * same lines, so the digest says the same thing in every form.
 */
export function coverCredit(art: CoverArtwork): CreditLine[] {
  const lines: CreditLine[] = [{ text: art.title || "Untitled", weight: "title" }];
  const who = [art.artist || "Unknown artist", art.artistBio].filter(Boolean).join(" · ");
  lines.push({ text: who, weight: "body" });
  const what = [art.date, art.medium].filter(Boolean).join(" · ");
  if (what) lines.push({ text: what, weight: "body" });
  lines.push({
    text: [art.creditLine, "The Metropolitan Museum of Art"].filter(Boolean).join(" · "),
    weight: "muted",
  });
  return lines;
}

/** One line naming a piece, for a log entry or a grid caption. */
export function artworkLabel(art: CoverArtwork): string {
  const who = art.artist || "unknown artist";
  return art.date ? `${art.title} — ${who}, ${art.date}` : `${art.title} — ${who}`;
}
