//! Backend → UI logging.
//!
//! Anything the Rust side does that a user might need to see (Gmail queries,
//! agent turns, tool calls, retries) is emitted as a `log` event and shown in
//! the app's log pane. Delivery is best-effort: a failed emit is never worth
//! interrupting the work that produced it.

use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize)]
pub struct LogEvent {
    pub level: &'static str,
    pub source: &'static str,
    pub message: String,
}

fn emit(app: &AppHandle, level: &'static str, source: &'static str, message: String) {
    let _ = app.emit("log", LogEvent { level, source, message });
}

pub fn info(app: &AppHandle, source: &'static str, message: impl Into<String>) {
    emit(app, "info", source, message.into());
}

pub fn warn(app: &AppHandle, source: &'static str, message: impl Into<String>) {
    emit(app, "warn", source, message.into());
}

pub fn error(app: &AppHandle, source: &'static str, message: impl Into<String>) {
    emit(app, "error", source, message.into());
}

/// Shortens a long value (a URL, a prompt) for a single log line.
pub fn ellipsize(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let head: String = text.chars().take(max.saturating_sub(1)).collect();
    format!("{head}…")
}
