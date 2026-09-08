/**
 * Saved-list **sources**: the sites the app opens a browser at, and how they're
 * stored on the device.
 *
 * A source is a name and an address, and that is the whole of it. There is no
 * recipe to get wrong, because nothing is being predicted: the browser opens
 * there, you sign in and navigate as you would anywhere, and what gets read is
 * the page you were looking at when you pressed the button. A site that
 * redesigns its saved page, or renames the endpoint behind it, changes nothing
 * here.
 *
 * Nothing secret lives here either. The session a capture leaves behind is kept
 * by the backend, in the app's data directory, and never comes back to this
 * side.
 */

export interface SavedSource {
  id: string;
  name: string;
  /** Where the browser opens — the site's own list page. */
  url: string;
  /**
   * The page the last capture was taken from, so the browser reopens where you
   * left it. A saved list is somewhere you go back to.
   */
  lastUrl?: string;
}

export const SOURCES_KEY = "subdigest.sources";

let idCounter = 0;

export function newSourceId(): string {
  return `s${Date.now().toString(36)}${(idCounter++).toString(36)}`;
}

/** What a fresh install can collect from. */
export function defaultSources(): SavedSource[] {
  return [{ id: "substack-saved", name: "Substack", url: "https://substack.com/saved" }];
}

export function emptySource(): SavedSource {
  return { id: newSourceId(), name: "", url: "" };
}

/** `https://example.com/saved` → `example.com`; a bare host is left alone. */
export function domainFromUrl(raw: string): string {
  const text = raw.trim().toLowerCase();
  if (!text) return "";
  try {
    return new URL(text.includes("://") ? text : `https://${text}`).hostname.replace(/^www\./, "");
  } catch {
    return text.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  }
}

/** An address the browser can actually open. */
export function sourceIsUsable(source: SavedSource): boolean {
  return /^https?:\/\/\S+$/i.test(source.url.trim());
}

/** Where opening this source starts: where you left it, else where it points. */
export function openingUrl(source: SavedSource): string {
  return (source.lastUrl ?? "").trim() || source.url.trim();
}

/** What to call a source the user hasn't named. */
export function sourceLabel(source: SavedSource): string {
  return source.name.trim() || domainFromUrl(source.url) || "Untitled site";
}

/** Reads back one stored source, tolerating anything an older build wrote. */
function coerceSource(value: unknown): SavedSource {
  const s = (value ?? {}) as Partial<SavedSource> & { home?: unknown };
  // Sources used to carry a sign-in recipe and a list of endpoints; all that
  // survives is where to open, which the old `home` field is as good a guess at
  // as anything the recipe held.
  const url =
    (typeof s.url === "string" && s.url) || (typeof s.home === "string" ? s.home : "") || "";
  return {
    id: typeof s.id === "string" && s.id ? s.id : newSourceId(),
    name: typeof s.name === "string" ? s.name : "",
    url,
    lastUrl: typeof s.lastUrl === "string" ? s.lastUrl : undefined,
  };
}

/** The stored sources, seeded from the built-in one on first run. */
export function loadSources(): SavedSource[] {
  try {
    const raw = localStorage.getItem(SOURCES_KEY);
    // An empty list is a real answer — every site was removed — so only a
    // missing key falls through to the built-in.
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map(coerceSource);
    }
  } catch {
    /* fall through to the built-in */
  }
  return defaultSources();
}
