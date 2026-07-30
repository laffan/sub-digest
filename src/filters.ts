/**
 * Mail filters: what a scan looks for, and how they're stored on the device.
 * The Gmail query itself is built in Rust (`src-tauri/src/gmail.rs`) — this
 * side only keeps the criteria tidy and describes them for the UI.
 */
import type { FilterField, MailFilter } from "./types";

export const FILTERS_KEY = "subdigest.filters";
/** Before filters there was a bare list of sender domains. Read once, to migrate. */
const LEGACY_DOMAINS_KEY = "subdigest.domains";

/** Reduces "@Substack.com", "https://ghost.io/x" etc. to a bare "substack.com". */
export function normalizeDomain(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/\s+/g, "");
}

/** A whole address, bare: no `mailto:`, no display name, no spaces. */
export function normalizeSender(raw: string): string {
  const inAngles = raw.match(/<([^>]+)>/);
  return (inAngles ? inAngles[1] : raw)
    .trim()
    .toLowerCase()
    .replace(/^mailto:/, "")
    .replace(/\s+/g, "");
}

/**
 * Subject slices and search terms are phrases, so spaces stay. Quotes don't:
 * they're what delimits a phrase in a Gmail query, and a stray one would end
 * it early. Case is left alone — Gmail ignores it either way.
 */
export function normalizeText(raw: string): string {
  return raw
    .replace(/["“”]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The normalizer for each kind of criterion. */
export const NORMALIZE: Record<FilterField, (raw: string) => string> = {
  domains: normalizeDomain,
  senders: normalizeSender,
  subjects: normalizeText,
  terms: normalizeText,
};

let idCounter = 0;

/** Unique within a device's list, which is all the checkboxes need. */
export function newFilterId(): string {
  return `f${Date.now().toString(36)}${(idCounter++).toString(36)}`;
}

export function emptyFilter(name = ""): MailFilter {
  return {
    id: newFilterId(),
    name,
    enabled: true,
    domains: [],
    senders: [],
    subjects: [],
    terms: [],
  };
}

/** A filter with no criteria would match the whole mailbox, so it never runs. */
export function filterIsEmpty(f: MailFilter): boolean {
  return f.domains.length + f.senders.length + f.subjects.length + f.terms.length === 0;
}

/** The filters a scan actually uses: enabled, and with something to match on. */
export function activeFilters(filters: MailFilter[]): MailFilter[] {
  return filters.filter((f) => f.enabled && !filterIsEmpty(f));
}

/** What to call a filter on screen when the user hasn't named it. */
export function filterLabel(f: MailFilter): string {
  const name = f.name.trim();
  if (name) return name;
  return f.domains[0] ?? f.senders[0] ?? f.subjects[0] ?? f.terms[0] ?? "Untitled filter";
}

/** One line saying what a filter matches, for the list in the sidebar. */
export function filterSummary(f: MailFilter): string {
  const parts: string[] = [];
  const from = [...f.domains, ...f.senders];
  if (from.length > 0) parts.push(`from ${from.join(" / ")}`);
  if (f.subjects.length > 0) parts.push(`subject “${f.subjects.join("” / “")}”`);
  if (f.terms.length > 0) parts.push(`mentioning ${f.terms.join(" / ")}`);
  return parts.length > 0 ? parts.join(" · ") : "nothing to match on yet";
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Reads back one stored filter, tolerating anything an older build wrote. */
function coerceFilter(value: unknown): MailFilter {
  const f = (value ?? {}) as Partial<MailFilter>;
  return {
    id: typeof f.id === "string" && f.id.length > 0 ? f.id : newFilterId(),
    name: typeof f.name === "string" ? f.name : "",
    enabled: f.enabled !== false,
    domains: stringList(f.domains),
    senders: stringList(f.senders),
    subjects: stringList(f.subjects),
    terms: stringList(f.terms),
  };
}

/** What a fresh install scans with. */
export function defaultFilters(): MailFilter[] {
  return [{ ...emptyFilter("Substack"), domains: ["substack.com"] }];
}

/**
 * The stored filters. An install that predates them keeps scanning what it
 * always scanned: its sender domains come across as one filter.
 */
export function loadFilters(): MailFilter[] {
  try {
    const raw = localStorage.getItem(FILTERS_KEY);
    // An empty list is a real answer — the user deleted every filter — so only
    // a missing key falls through to the domains that came before.
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map(coerceFilter);
    } else {
      const legacy = JSON.parse(localStorage.getItem(LEGACY_DOMAINS_KEY) ?? "null");
      if (Array.isArray(legacy)) {
        const domains = legacy
          .filter((d): d is string => typeof d === "string")
          .map(normalizeDomain)
          .filter((d) => d.length > 0);
        if (domains.length > 0) return [{ ...emptyFilter("Sender domains"), domains }];
      }
    }
  } catch {
    /* fall through to the default */
  }
  return defaultFilters();
}
