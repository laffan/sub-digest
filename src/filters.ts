/**
 * Mail filters: what a scan looks for, and how they're stored on the device.
 * The Gmail query itself is built in Rust (`src-tauri/src/gmail.rs`) — this
 * side only keeps the criteria tidy and describes them for the UI.
 */
import type { FilterField, MailFilter } from "./types";

export const FILTERS_KEY = "subdigest.filters";
/** Before filters there was a bare list of sender domains. Read once, to migrate. */
const LEGACY_DOMAINS_KEY = "subdigest.domains";
/** …and the agent was configured per publication. Likewise. */
const LEGACY_AGENTS_KEY = "subdigest.agentConfigs";

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

/**
 * A sender, as Gmail's `from:` takes one — which matches the name on the From
 * header as well as the address, so `Astral Codex Ten` is as good a sender as
 * `astral@substack.com`. An address pasted in full (`Nate <n@example.com>`)
 * reduces to the address, and only an address is lowercased: a name is left
 * as written, since it's read back in the editor.
 */
export function normalizeSender(raw: string): string {
  const inAngles = raw.match(/<([^>]+)>/);
  const value = (inAngles ? inAngles[1] : raw)
    .replace(/^\s*mailto:/i, "")
    .replace(/["“”]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return /\s/.test(value) ? value : value.toLowerCase();
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
    useAgent: false,
    instructions: "",
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

/**
 * Which of the filters that found a post decides how it's read. An agentic
 * filter wins: carving the link roundups out with a filter of their own is
 * exactly what one is for, so it shouldn't lose to the broad filter that
 * happens to catch them too. Otherwise it's the first in the user's own order.
 */
export function decidingFilter(
  filters: MailFilter[],
  matched: readonly string[]
): MailFilter | undefined {
  const ids = new Set(matched);
  const hits = filters.filter((f) => ids.has(f.id));
  return hits.find((f) => f.useAgent) ?? hits[0];
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
    useAgent: f.useAgent === true,
    instructions: typeof f.instructions === "string" ? f.instructions : "",
  };
}

/** What a fresh install scans with. */
export function defaultFilters(): MailFilter[] {
  return [{ ...emptyFilter("Substack"), domains: ["substack.com"] }];
}

/**
 * The settings that came before filters, as filters — so an install that
 * predates them keeps finding what it found and reading it how it read it.
 * Returns null when there's nothing to carry across.
 */
function migrated(): MailFilter[] | null {
  const legacyDomains = JSON.parse(localStorage.getItem(LEGACY_DOMAINS_KEY) ?? "null");
  const domains = Array.isArray(legacyDomains)
    ? legacyDomains
        .filter((d): d is string => typeof d === "string")
        .map(normalizeDomain)
        .filter((d) => d.length > 0)
    : [];

  // The agent used to be switched on per publication. Gmail's `from:` matches
  // the name on a From header as well as the address, so each publication that
  // had it on becomes a filter that finds exactly that publication and sends
  // it to the agent — the same mail, read the same way, now as a filter.
  const legacyAgents = JSON.parse(localStorage.getItem(LEGACY_AGENTS_KEY) ?? "null");
  const agentFilters: MailFilter[] =
    legacyAgents && typeof legacyAgents === "object" && !Array.isArray(legacyAgents)
      ? Object.entries(legacyAgents as Record<string, { useAgent?: unknown; instructions?: unknown }>)
          .filter(([, cfg]) => cfg?.useAgent === true)
          .flatMap(([publication, cfg]) => {
            const sender = normalizeSender(publication);
            if (!sender) return [];
            return [
              {
                ...emptyFilter(publication),
                senders: [sender],
                useAgent: true,
                instructions: typeof cfg.instructions === "string" ? cfg.instructions : "",
              },
            ];
          })
      : [];

  if (domains.length === 0 && agentFilters.length === 0) return null;
  const base =
    domains.length > 0 ? [{ ...emptyFilter("Sender domains"), domains }] : defaultFilters();
  return [...base, ...agentFilters];
}

/** The stored filters, migrating the settings they replaced on first run. */
export function loadFilters(): MailFilter[] {
  try {
    const raw = localStorage.getItem(FILTERS_KEY);
    // An empty list is a real answer — the user deleted every filter — so only
    // a missing key falls through to what came before.
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map(coerceFilter);
    } else {
      const carried = migrated();
      if (carried) return carried;
    }
  } catch {
    /* fall through to the default */
  }
  return defaultFilters();
}
