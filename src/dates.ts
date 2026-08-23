/** Date formatting shared by the PDF and EPUB exporters. */

/** "Monday, July 20, 2026" — the by-line under a post title. */
export function formatLongDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/** "Jul 3, 2026" for a short date, used in tables of contents. */
export function formatShortDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** The span covered by a set of posts, e.g. "Jul 3, 2026 – Jul 19, 2026". */
export function dateRangeLabel(posts: { dateMs: number }[]): string {
  if (posts.length === 0) return "";
  const times = posts.map((p) => p.dateMs);
  const lo = formatShortDate(Math.min(...times));
  const hi = formatShortDate(Math.max(...times));
  return lo === hi ? lo : `${lo} – ${hi}`;
}

/**
 * "Jul 3 – Jul 19, 2026   ·   12 posts from 4 publications" — the line under
 * the masthead, on the cover and on the contents page, in both formats.
 */
export function issueLine(posts: { publication: string; dateMs: number }[]): string {
  const pubs = new Set(posts.map((p) => p.publication)).size;
  return (
    `${dateRangeLabel(posts)}   ·   ${posts.length} post${posts.length === 1 ? "" : "s"}` +
    ` from ${pubs} publication${pubs === 1 ? "" : "s"}`
  );
}

/** `YYYY-MM-DD`, for EPUB metadata (`dc:date`). */
export function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Midnight *local* time at the start of a `YYYY-MM-DD` day, as epoch millis.
 * `new Date("2026-07-01")` would parse as UTC and shift the day for anyone
 * west of Greenwich, so the parts are split by hand. Returns null if unparsable.
 */
export function dayStartMs(isoDate: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(y, mo - 1, d);
  // Rejects overflow like 2026-02-31, which Date would roll forward.
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return date.getTime();
}

/** Midnight local time at the *end* of a day, i.e. the start of the next one. */
export function dayEndMs(isoDate: string): number | null {
  const start = dayStartMs(isoDate);
  if (start === null) return null;
  const next = new Date(start);
  next.setDate(next.getDate() + 1); // handles DST and month/year ends
  return next.getTime();
}

/** `YYYY-MM-DD` for a local date, the format `<input type="date">` expects. */
export function isoLocalDay(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
