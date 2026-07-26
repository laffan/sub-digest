import { useSyncExternalStore } from "react";

/**
 * A small app-wide log. It's a module store rather than React state so any
 * layer can write to it — the image pipeline and the layout engine have no
 * components to thread a callback through — and the Rust backend feeds into it
 * over Tauri events (see `src-tauri/src/log.rs`).
 */

export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
  id: number;
  ts: number;
  level: LogLevel;
  /** Which part of the app spoke: "gmail", "agent", "render", "app"… */
  source: string;
  message: string;
}

/** Older entries are dropped past this; a long digest run is chatty. */
const MAX_ENTRIES = 3000;

let entries: LogEntry[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function publish() {
  for (const notify of listeners) notify();
}

export function log(level: LogLevel, source: string, message: string) {
  const entry: LogEntry = { id: nextId++, ts: Date.now(), level, source, message };
  // A new array each time: `useSyncExternalStore` compares snapshots by identity.
  entries = entries.length >= MAX_ENTRIES ? [...entries.slice(1), entry] : [...entries, entry];
  publish();
}

export const logInfo = (source: string, message: string) => log("info", source, message);
export const logWarn = (source: string, message: string) => log("warn", source, message);
export const logError = (source: string, message: string) => log("error", source, message);

export function clearLog() {
  entries = [];
  publish();
}

/** The whole log as plain text, for the pane's copy button. */
export function logAsText(): string {
  return entries.map((e) => `${timestamp(e.ts)} ${e.level} [${e.source}] ${e.message}`).join("\n");
}

export function timestamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(
    d.getMilliseconds(),
    3
  )}`;
}

function subscribe(notify: () => void): () => void {
  listeners.add(notify);
  return () => listeners.delete(notify);
}

export function useLog(): LogEntry[] {
  return useSyncExternalStore(
    subscribe,
    () => entries,
    () => entries
  );
}
