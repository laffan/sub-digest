/**
 * The saved-list input's side of the backend: drive the in-app browser, read
 * the page it's showing, and fetch an article off what it found.
 *
 * The browser is a real webview owned by the backend — a child webview on the
 * Mac, a native one on the iPad — positioned over the modal that frames it.
 * This side only says where to put it and when to read it. Sessions live in
 * Rust; nothing here ever holds a cookie.
 */
import { invoke } from "@tauri-apps/api/core";

/** Where the browser should sit, in CSS pixels from the window's top left. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One article read off the page. */
export interface SavedItem {
  id: string;
  title: string;
  url: string;
  /** Empty when the page didn't name a writer. */
  author: string;
  publication: string;
  /** 0 when the page didn't date it. */
  dateMs: number;
}

/** What **Use this page** brought back. */
export interface Capture {
  pageUrl: string;
  pageTitle: string;
  items: SavedItem[];
}

/** Opens the browser at `url`, covering `rect`. */
export function savedOpen(url: string, rect: Rect): Promise<void> {
  return invoke<void>("saved_open", { url, ...rect });
}

/** Keeps the browser glued to the modal's body as the window changes shape. */
export function savedBounds(rect: Rect): Promise<void> {
  return invoke<void>("saved_bounds", { ...rect });
}

export function savedBack(): Promise<void> {
  return invoke<void>("saved_back");
}

export function savedClose(): Promise<void> {
  return invoke<void>("saved_close");
}

/**
 * Reads the page the browser is showing, and keeps the session that made it
 * readable. That session is what gets a subscriber-only article back later.
 */
export function savedCapture(sourceId: string): Promise<Capture> {
  return invoke<Capture>("saved_capture", { sourceId });
}

/** Forgets a site's session; the browser's own cookies are left alone. */
export function savedForget(sourceId: string): Promise<void> {
  return invoke<void>("saved_forget", { sourceId });
}

/** The domain a site has a session kept for, or null. */
export function savedHasSession(sourceId: string): Promise<string | null> {
  return invoke<string | null>("saved_has_session", { sourceId });
}

/**
 * Fetches one saved article as Markdown — the same scrape the AI agent's link
 * roundups go through, with the site's session attached when the article is on
 * its own domain.
 */
export function savedFetch(sourceId: string, url: string): Promise<string> {
  return invoke<string>("saved_fetch", { sourceId, url });
}
