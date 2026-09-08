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

/** Where the browser should sit, in CSS pixels from the page's top left. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The rectangle, plus the height of the page it was measured in.
 *
 * The backend places the browser in the *window's* coordinates, and on a Mac
 * the page starts below the title bar — so it needs to know how tall the page
 * is to work out the difference. Sending it with every rectangle keeps that a
 * measurement rather than an assumption about window furniture.
 */
function placement(rect: Rect) {
  return { ...rect, viewportH: window.innerHeight };
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
  /** The site it landed on — the session's key, and the site's name. */
  domain: string;
  pageUrl: string;
  pageTitle: string;
  items: SavedItem[];
}

/** Opens the browser at `url`, covering `rect`. */
export function savedOpen(url: string, rect: Rect): Promise<void> {
  return invoke<void>("saved_open", { url, ...placement(rect) });
}

/** Keeps the browser glued to the modal's body as the window changes shape. */
export function savedBounds(rect: Rect): Promise<void> {
  return invoke<void>("saved_bounds", placement(rect));
}

export function savedBack(): Promise<void> {
  return invoke<void>("saved_back");
}

export function savedClose(): Promise<void> {
  return invoke<void>("saved_close");
}

/**
 * Reads the page the browser is showing, and keeps the site — and the session
 * that made it readable — for next time. Which site this is, is whichever one
 * the browser ended up on: signing in and navigating *are* the choosing.
 */
export function savedCapture(): Promise<Capture> {
  return invoke<Capture>("saved_capture");
}

/** The sites captured from, as domains. The backend is the authority. */
export function savedSites(): Promise<string[]> {
  return invoke<string[]>("saved_sites");
}

/** Forgets a site and its session; the browser's own cookies are left alone. */
export function savedForget(domain: string): Promise<void> {
  return invoke<void>("saved_forget", { domain });
}

/**
 * Fetches one saved article as Markdown — the same scrape the AI agent's link
 * roundups go through, with a signed-in site's session attached when the
 * article is on it.
 */
export function savedFetch(url: string): Promise<string> {
  return invoke<string>("saved_fetch", { url });
}
