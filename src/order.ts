import type { DigestPost } from "./types";

/**
 * How the entries are arranged in the digest. The order is set in Organize and
 * both exporters take it as given, so this is the one place that decides what
 * follows what.
 */
export type PostOrder = "chronological" | "source" | "custom";

export const ORDERS: { value: PostOrder; label: string; hint: string }[] = [
  {
    value: "chronological",
    label: "Chronological",
    hint: "Oldest first, however they arrived",
  },
  {
    value: "source",
    label: "By source",
    hint: "Grouped by publication, chronological inside each",
  },
  {
    value: "custom",
    label: "Custom",
    hint: "The order you dragged them into",
  },
];

/**
 * Puts the prepared entries in their running order.
 *
 * `custom` is a list of entry ids — the arrangement dragging leaves behind.
 * Anything prepared since it was made has no place in it, so it lands on the
 * end in date order rather than silently at the front.
 */
export function orderPosts(
  posts: DigestPost[],
  order: PostOrder,
  custom: readonly string[]
): DigestPost[] {
  if (order === "custom") {
    const rank = new Map(custom.map((id, i) => [id, i]));
    const placed = posts
      .filter((p) => rank.has(p.id))
      .sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
    return [...placed, ...byDate(posts.filter((p) => !rank.has(p.id)))];
  }

  const chronological = byDate(posts);
  if (order !== "source") return chronological;

  // Grouped by publication, alphabetically — which reads as sections and, being
  // the publications' own names, doesn't shuffle between one scan and the next.
  // Each group keeps the chronological order it came in with.
  const groups = new Map<string, DigestPost[]>();
  for (const post of chronological) {
    const group = groups.get(post.publication);
    if (group) group.push(post);
    else groups.set(post.publication, [post]);
  }
  return [...groups.keys()]
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
    .flatMap((name) => groups.get(name)!);
}

/**
 * Oldest first. Sorting is stable, so the articles an agent found in one email
 * — which all carry that email's date — keep the order it found them in.
 */
function byDate(posts: DigestPost[]): DigestPost[] {
  return [...posts].sort((a, b) => a.dateMs - b.dateMs);
}

/**
 * The publication each entry opens, for the headings the running order shows
 * when it's grouped by source: the id of the first entry of each run, mapped to
 * that run's publication.
 */
export function groupHeadings(posts: DigestPost[]): Map<string, string> {
  const heads = new Map<string, string>();
  let current: string | null = null;
  for (const post of posts) {
    if (post.publication !== current) {
      heads.set(post.id, post.publication);
      current = post.publication;
    }
  }
  return heads;
}
