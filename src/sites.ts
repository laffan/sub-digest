/**
 * The **sites** the saved-list input knows about: the ones you've signed in to
 * and taken a list from, and how they're remembered on the device.
 *
 * A site isn't something you configure — it's something that happened. You give
 * the browser an address once, sign in, and press **Use this page**; the site
 * that capture landed on is the site, and it's in the picker from then on. So
 * what's stored here is a record rather than a setting: a domain, the page it
 * was last read from, and when. There's nothing to get wrong, and nothing to
 * keep in step with a site that redesigns itself.
 *
 * The backend keeps the sessions, under the same domains. It's the authority on
 * which sites are real — this list is reconciled against it at startup, so a
 * site whose session has gone doesn't sit in the picker pretending.
 */

export interface SavedSite {
  /** The site's registrable domain — its identity, and the session's key. */
  domain: string;
  /** The page the last capture was taken from; where the browser reopens. */
  url: string;
  /** When it was last used, so the most recent is offered first. */
  usedMs: number;
}

export const SITES_KEY = "subdigest.sites";

/** The example worth suggesting, since it's the one that prompted all this. */
export const EXAMPLE_URL = "https://substack.com/saved";

/** An address the browser can actually open. */
export function isOpenable(url: string): boolean {
  return /^https?:\/\/\S+$/i.test(url.trim());
}

/** Accepts `substack.com/saved` as readily as the full address. */
export function normalizeUrl(raw: string): string {
  const text = raw.trim();
  if (!text) return "";
  return /^https?:\/\//i.test(text) ? text : `https://${text}`;
}

/** The path a site was last read from, for the line under the picker. */
export function siteDetail(site: SavedSite): string {
  try {
    const url = new URL(site.url);
    return `${url.pathname}${url.search}`.replace(/^\/$/, "/");
  } catch {
    return site.url;
  }
}

/**
 * Records a capture: the site it landed on, and the page it was read from.
 * Capturing the same site again moves it to the front rather than adding it
 * twice — it's one site however many times you go back to it.
 */
export function rememberSite(
  sites: SavedSite[],
  domain: string,
  url: string
): SavedSite[] {
  const site: SavedSite = { domain, url, usedMs: Date.now() };
  return [site, ...sites.filter((s) => s.domain !== domain)];
}

function coerceSite(value: unknown): SavedSite | null {
  const s = (value ?? {}) as Partial<SavedSite>;
  if (typeof s.domain !== "string" || !s.domain) return null;
  return {
    domain: s.domain,
    url: typeof s.url === "string" ? s.url : `https://${s.domain}`,
    usedMs: typeof s.usedMs === "number" ? s.usedMs : 0,
  };
}

/** What's on the device, newest first. */
export function loadSites(): SavedSite[] {
  try {
    const raw = localStorage.getItem(SITES_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed
          .map(coerceSite)
          .filter((s): s is SavedSite => s !== null)
          .sort((a, b) => b.usedMs - a.usedMs);
      }
    }
  } catch {
    /* nothing worth keeping */
  }
  return [];
}
