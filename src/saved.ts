/**
 * The saved-list input's side of the backend: sign in to a source, read one of
 * its lists, and fetch an article off it.
 *
 * Only the recipe crosses over. Sessions live in Rust, in the app's data
 * directory, and this side never holds a cookie — the most it ever sees is the
 * name of the account a sign-in landed on.
 */
import { invoke } from "@tauri-apps/api/core";
import type { SavedList, SavedSource, SignInMethod } from "./sources";
import { sourceDomain } from "./sources";

/** One article on a list, as the backend read it. */
export interface SavedItem {
  id: string;
  title: string;
  url: string;
  /** Empty when the list didn't name a writer. */
  author: string;
  publication: string;
  /** 0 when the list didn't date it. */
  dateMs: number;
}

/** The recipe as the backend wants it — the domain resolved, nothing derived there. */
function recipe(source: SavedSource) {
  return {
    id: source.id,
    name: source.name || "this source",
    domain: sourceDomain(source),
    cookieName: source.cookieName,
    linkRequestUrl: source.linkRequestUrl,
    passwordUrl: source.passwordUrl,
    probeUrl: source.probeUrl,
    probeFields: source.probeFields,
  };
}

function listRecipe(list: SavedList) {
  return {
    name: list.name || "this list",
    urls: list.urls.filter((u) => u.trim().length > 0),
    kind: list.kind,
    itemsPath: list.itemsPath,
    linkSelector: list.linkSelector,
  };
}

/** Asks the site to mail a sign-in link; resolves with what to do next. */
export function savedRequestLink(source: SavedSource, email: string): Promise<string> {
  return invoke<string>("saved_request_link", { source: recipe(source), email });
}

/** What one sign-in attempt carries; only the field its method uses is read. */
export interface SignInDetails {
  email?: string;
  password?: string;
  /** The sign-in link the site mailed, pasted rather than opened. */
  link?: string;
  /** A session cookie copied out of a browser. */
  cookie?: string;
}

/** Signs in and keeps the session; resolves with the account it landed on. */
export function savedSignIn(
  source: SavedSource,
  method: SignInMethod,
  details: SignInDetails
): Promise<string> {
  return invoke<string>("saved_sign_in", {
    source: recipe(source),
    method,
    email: details.email ?? "",
    password: details.password ?? "",
    link: details.link ?? "",
    cookie: details.cookie ?? "",
  });
}

/** The account a source is signed in as, or null. */
export function savedStatus(sourceId: string): Promise<string | null> {
  return invoke<string | null>("saved_status", { sourceId });
}

export function savedSignOut(sourceId: string): Promise<void> {
  return invoke<void>("saved_sign_out", { sourceId });
}

/**
 * Collects one list: the articles on it, newest first. `afterMs`/`beforeMs` are
 * the session's date window, either bound 0 for open-ended — the same window
 * the mail scan uses, so a timeframe means the same thing whichever input it's
 * applied to. An item the list didn't date is never excluded by one.
 */
export function savedCollect(
  source: SavedSource,
  list: SavedList,
  limit: number,
  afterMs: number,
  beforeMs: number
): Promise<SavedItem[]> {
  return invoke<SavedItem[]>("saved_collect", {
    source: recipe(source),
    list: listRecipe(list),
    limit,
    afterMs,
    beforeMs,
  });
}

/**
 * Fetches one saved article as Markdown — the same scrape the AI agent's link
 * roundups go through. The session rides along when the article is on the
 * source's own domain, which is what gets a subscriber-only post back whole.
 */
export function savedFetch(sourceId: string, url: string): Promise<string> {
  return invoke<string>("saved_fetch", { sourceId, url });
}
