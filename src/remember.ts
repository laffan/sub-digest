/**
 * Remembering what was struck out. A filter with *Remember removed content*
 * keeps a signature of every block taken out of the mail it found, and strikes
 * the same material out again wherever it turns up in a later post.
 *
 * The signature is the block's own identity — an image's address, a
 * paragraph's words — rather than the class names around it. A newsletter
 * template gives every paragraph in the body the same class, so a signature
 * made of those would remove one week's sign-off and next week's article with
 * it. What actually recurs verbatim is the furniture itself: the masthead
 * image, the standing sign-off, the promo that runs every issue.
 */
import type { Block, DigestPost, MailFilter } from "./types";
import { blockKey } from "./types";

/** How much of a paragraph is enough to recognise it by. */
const TEXT_LIMIT = 200;

/**
 * An image address reduced to the picture it names. CDNs wrap the real URL,
 * percent-encoded, behind a resizing prefix — `…/image/fetch/w_1456,c_limit/
 * https%3A%2F%2F…` — so the same picture arrives at a different address in a
 * post laid out at another width. Unwrapping it first means one signature
 * covers them all. Query strings (cache busters, tracking) go the same way.
 */
export function normalizeImageUrl(raw: string): string {
  let url = raw.trim();
  // The wrapped address is the tail of the path (or of a query parameter), and
  // always absolute. The leading `.*` is greedy so that it's the *last* address
  // in the string that's taken, not the wrapper's own.
  const nested = /^.*[/=](https?(?::|%3a)(?:\/\/|%2f%2f).+)$/i.exec(url);
  if (nested) {
    try {
      url = decodeURIComponent(nested[1]);
    } catch {
      url = nested[1]; // malformed escapes: keep what we have
    }
  }
  return url
    .replace(/[?#].*$/, "")
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase().slice(0, TEXT_LIMIT);
}

/**
 * What identifies this block for the purpose of striking it out again, or null
 * for a block too generic to remember — a horizontal rule is a horizontal
 * rule, and remembering one would quietly delete every rule in the digest.
 */
export function blockSignature(block: Block): string | null {
  switch (block.kind) {
    case "image":
      return `image:${normalizeImageUrl(block.src)}`;
    case "heading": {
      const text = normalizeText(block.text);
      return text ? `heading:${text}` : null;
    }
    case "para": {
      const text = normalizeText(block.text);
      return text ? `para:${text}` : null;
    }
    case "list": {
      const text = normalizeText(block.items.join(" | "));
      return text ? `list:${text}` : null;
    }
    case "rule":
      return null;
  }
}

/**
 * How much one filter remembers. Furniture is a handful of things per
 * publication, so this is only here to keep a runaway from filling the
 * device's storage; the oldest go first.
 */
const MEMORY_LIMIT = 500;

/** Adds `signatures` to a filter's memory, or takes them out of it. */
export function withSignatures(
  filter: MailFilter,
  signatures: readonly string[],
  remember: boolean
): MailFilter {
  if (signatures.length === 0) return filter;
  const kept = new Set(filter.removedSignatures);
  const before = kept.size;
  for (const sig of signatures) {
    if (remember) {
      // Re-adding moves it to the end, so it isn't the next one dropped.
      kept.delete(sig);
      kept.add(sig);
    } else {
      kept.delete(sig);
    }
  }
  const list = [...kept];
  if (kept.size === before && list.every((sig, i) => sig === filter.removedSignatures[i])) {
    return filter;
  }
  return { ...filter, removedSignatures: list.slice(-MEMORY_LIMIT) };
}

/**
 * The blocks of freshly prepared entries that a filter already knows to
 * remove, as the keys that mark them.
 */
export function rememberedKeys(entries: readonly DigestPost[], filter: MailFilter): string[] {
  if (!filter.rememberRemovals || filter.removedSignatures.length === 0) return [];
  const known = new Set(filter.removedSignatures);
  const keys: string[] = [];
  for (const entry of entries) {
    entry.blocks.forEach((block, i) => {
      const sig = blockSignature(block);
      if (sig && known.has(sig)) keys.push(blockKey(entry.id, i));
    });
  }
  return keys;
}
