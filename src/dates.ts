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

/** `YYYY-MM-DD`, for EPUB metadata (`dc:date`). */
export function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
