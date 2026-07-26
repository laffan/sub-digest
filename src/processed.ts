/**
 * A record of which posts have already been fetched and parsed, kept between
 * sessions.
 *
 * It is only ever a marker. Nothing is skipped, filtered or deselected on the
 * strength of it — a processed post is shown at half strength in the scan list
 * so you can see at a glance what's new since last time, and that is all it
 * does. Clearing it in Settings loses nothing but the shading.
 */

const KEY = "subdigest.processed";

/**
 * Ceiling on remembered posts. A mailbox scanned over years would otherwise
 * grow this without limit; past the cap the oldest entries go first, which at
 * worst un-shades something read long ago.
 */
const MAX_ENTRIES = 5000;

/** Message id → when it was processed, as epoch millis. */
type Store = Record<string, number>;

function read(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Store;
    }
  } catch {
    /* unreadable or not ours — start over rather than fail */
  }
  return {};
}

function write(store: Store) {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* a full or disabled localStorage isn't worth interrupting a run for */
  }
}

/** Every post remembered from a previous session. */
export function loadProcessed(): Set<string> {
  return new Set(Object.keys(read()));
}

/** Remembers these posts, and returns how many are now remembered in total. */
export function markProcessed(ids: string[]): number {
  const store = read();
  const now = Date.now();
  for (const id of ids) store[id] = now;

  const keys = Object.keys(store);
  if (keys.length > MAX_ENTRIES) {
    const newest = keys.sort((a, b) => store[b] - store[a]).slice(0, MAX_ENTRIES);
    const pruned: Store = {};
    for (const id of newest) pruned[id] = store[id];
    write(pruned);
    return newest.length;
  }

  write(store);
  return keys.length;
}

export function clearProcessed() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to do about it */
  }
}
