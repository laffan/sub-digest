/**
 * Saved-list **sources**: the sites the app can sign in to and collect a list
 * from, and how they're stored on the device.
 *
 * A source is a recipe rather than code — a domain, the endpoints its sign-in
 * uses, and one or more lists, each an address and how to read what comes back.
 * That's the whole of what makes the saved-list input work for a site: adding
 * another one is filling in a form, not writing a parser. Substack ships as a
 * recipe like any other, and can be edited like any other, which matters
 * because it has no published API and the addresses below are what its own web
 * app calls — the day one of them moves, correcting it is a paste.
 *
 * Nothing secret lives here. The session a sign-in produces is kept by the
 * backend, in the app's data directory, and never comes back to this side.
 */

/** How you get a session out of a site. */
export type SignInMethod = "link" | "password" | "cookie";

export const METHOD_LABELS: Record<SignInMethod, string> = {
  link: "Sign-in link",
  password: "Password",
  cookie: "Session cookie",
};

/** One list on a source — the thing the app points at and collects. */
export interface SavedList {
  id: string;
  /** What it's called on the site: "Saved", "Inbox", "Read later". */
  name: string;
  /**
   * Addresses to try, in order, until one answers with articles. A site that
   * renames an endpoint doesn't take the list with it, and a guess that turns
   * out wrong costs a retry rather than the feature.
   */
  urls: string[];
  /** `json` for a list endpoint, `links` for a page of links. */
  kind: "json" | "links";
  /** Where the array of items sits in the JSON, e.g. `posts`. Blank: find it. */
  itemsPath: string;
  /** For a page of links: which links to take. Blank: every link on the page. */
  linkSelector: string;
}

export interface SavedSource {
  id: string;
  name: string;
  /** The site itself, for the sign-in hint and for deriving the domain. */
  home: string;
  /** Cookies are kept for this domain and its subdomains, and sent nowhere else. */
  domain: string;
  /** What a pasted bare cookie value is assumed to be. */
  cookieName: string;
  /** The ways in this site offers, in the order they're worth trying. */
  methods: SignInMethod[];
  /** Endpoint that mails a sign-in link, posted `{email}`. */
  linkRequestUrl: string;
  /** Endpoint that takes an address and password. */
  passwordUrl: string;
  /** A URL that answers "who's signed in", for checking a session took. */
  probeUrl: string;
  /** Where in that answer the account's name is, most specific first. */
  probeFields: string[];
  lists: SavedList[];
}

export const SOURCES_KEY = "subdigest.sources";

let idCounter = 0;

function newId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${(idCounter++).toString(36)}`;
}

export const newSourceId = () => newId("s");
export const newListId = () => newId("l");

/**
 * Substack's saved posts.
 *
 * There is no published Substack API: these are the addresses its own reader
 * calls, and the saved list is the inbox endpoint under the surface its Saved
 * tab uses. Both spellings that endpoint has gone by are listed, so the first
 * one that answers wins — and if neither does, the address is editable, and the
 * log says exactly what came back.
 */
function substack(): SavedSource {
  return {
    id: "substack",
    name: "Substack",
    home: "https://substack.com",
    domain: "substack.com",
    cookieName: "connect.sid",
    methods: ["link", "password", "cookie"],
    linkRequestUrl: "https://substack.com/api/v1/email-login",
    passwordUrl: "https://substack.com/api/v1/login",
    probeUrl: "https://substack.com/api/v1/user/profile/self",
    probeFields: ["user.name", "user.handle", "name", "handle", "email"],
    lists: [
      {
        id: "substack-saved",
        name: "Saved",
        urls: [
          "https://substack.com/api/v1/inbox/top?inboxType=inbox&surface=inbox_saved&limit=50",
          "https://substack.com/api/v1/reader/saved?limit=50",
          "https://substack.com/api/v1/saved?limit=50",
        ],
        kind: "json",
        itemsPath: "",
        linkSelector: "",
      },
      {
        id: "substack-inbox",
        name: "Inbox",
        urls: [
          "https://substack.com/api/v1/inbox/top?inboxType=inbox&surface=inbox_all&limit=50",
        ],
        kind: "json",
        itemsPath: "",
        linkSelector: "",
      },
    ],
  };
}

/** What a fresh install can collect from. */
export function defaultSources(): SavedSource[] {
  return [substack()];
}

export function emptyList(name = ""): SavedList {
  return { id: newListId(), name, urls: [""], kind: "json", itemsPath: "", linkSelector: "" };
}

/**
 * A new source, ready to be filled in. It starts with the cookie method alone,
 * since pasting one is the way into a site whose sign-in endpoints you don't
 * know — and knowing them is what the advanced fields are for.
 */
export function emptySource(name = ""): SavedSource {
  return {
    id: newSourceId(),
    name,
    home: "",
    domain: "",
    cookieName: "",
    methods: ["cookie"],
    linkRequestUrl: "",
    passwordUrl: "",
    probeUrl: "",
    probeFields: [],
    lists: [emptyList("Saved")],
  };
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

/**
 * The domain a source's cookies belong to: what it was given, or what its own
 * address implies. Deriving it is what keeps the common case to one field.
 */
export function sourceDomain(source: SavedSource): string {
  return source.domain.trim() || domainFromUrl(source.home) || domainFromUrl(source.lists[0]?.urls[0] ?? "");
}

/** The methods a source can actually offer, given what it has been told. */
export function availableMethods(source: SavedSource): SignInMethod[] {
  return source.methods.filter(
    (m) =>
      m === "cookie" ||
      (m === "link" && source.linkRequestUrl.trim().length > 0) ||
      (m === "password" && source.passwordUrl.trim().length > 0)
  );
}

/** A source with nothing to collect can't be scanned with. */
export function listIsEmpty(list: SavedList): boolean {
  return list.urls.every((u) => u.trim().length === 0);
}

/** One line saying where a list comes from, for the picker. */
export function listSummary(list: SavedList): string {
  const first = list.urls.find((u) => u.trim().length > 0);
  if (!first) return "no address yet";
  try {
    const url = new URL(first);
    return `${url.hostname}${url.pathname}`;
  } catch {
    return first;
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function coerceList(value: unknown): SavedList {
  const l = (value ?? {}) as Partial<SavedList>;
  const urls = stringList(l.urls);
  return {
    id: typeof l.id === "string" && l.id ? l.id : newListId(),
    name: typeof l.name === "string" ? l.name : "",
    urls: urls.length > 0 ? urls : [""],
    kind: l.kind === "links" ? "links" : "json",
    itemsPath: typeof l.itemsPath === "string" ? l.itemsPath : "",
    linkSelector: typeof l.linkSelector === "string" ? l.linkSelector : "",
  };
}

/** Reads back one stored source, tolerating anything an older build wrote. */
function coerceSource(value: unknown): SavedSource {
  const s = (value ?? {}) as Partial<SavedSource>;
  const methods = stringList(s.methods).filter((m): m is SignInMethod =>
    ["link", "password", "cookie"].includes(m)
  );
  const lists = Array.isArray(s.lists) ? s.lists.map(coerceList) : [];
  return {
    id: typeof s.id === "string" && s.id ? s.id : newSourceId(),
    name: typeof s.name === "string" ? s.name : "",
    home: typeof s.home === "string" ? s.home : "",
    domain: typeof s.domain === "string" ? s.domain : "",
    cookieName: typeof s.cookieName === "string" ? s.cookieName : "",
    methods: methods.length > 0 ? methods : ["cookie"],
    linkRequestUrl: typeof s.linkRequestUrl === "string" ? s.linkRequestUrl : "",
    passwordUrl: typeof s.passwordUrl === "string" ? s.passwordUrl : "",
    probeUrl: typeof s.probeUrl === "string" ? s.probeUrl : "",
    probeFields: stringList(s.probeFields),
    lists: lists.length > 0 ? lists : [emptyList("Saved")],
  };
}

/**
 * The stored sources. They're seeded from the built-in recipes on first run and
 * are the user's own from then on — a recipe that needs correcting is theirs to
 * correct, and one they added is theirs to keep.
 */
export function loadSources(): SavedSource[] {
  try {
    const raw = localStorage.getItem(SOURCES_KEY);
    // An empty list is a real answer — every source was deleted — so only a
    // missing key falls through to the built-ins.
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map(coerceSource);
    }
  } catch {
    /* fall through to the built-ins */
  }
  return defaultSources();
}
