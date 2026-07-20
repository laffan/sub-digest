//! Anthropic Messages API access for the per-newsletter agent.
//!
//! Some newsletters (link roundups, heavily-templated layouts) don't map onto
//! the default HTML parser. For those, the user can assign an agent with custom
//! instructions; this module runs the transform and returns clean Markdown,
//! which the frontend converts into layout blocks.

use serde_json::{json, Value};
use std::sync::OnceLock;

const ANTHROPIC_URL: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION: &str = "2023-06-01";
const MAX_CONTENT_CHARS: usize = 60_000;

const SYSTEM_PROMPT: &str = "You reformat a single email newsletter into clean \
Markdown for inclusion in a printed reading digest. You receive the raw email \
(HTML or plain text) plus optional per-newsletter instructions. Extract the \
meaningful editorial content and output Markdown only.\n\n\
Rules:\n\
- Output GitHub-flavored Markdown and nothing else: no preamble, no explanation, \
no code fences wrapping the whole answer.\n\
- Do NOT include the newsletter's title or a top-level # heading; the digest \
adds its own header.\n\
- Use ## and ### for section headings, - for bullet lists, 1. for numbered \
lists, > for quotes, ![](url) for images worth keeping, and --- for a divider.\n\
- For link-roundup newsletters, render each item as a list entry: the linked \
title in bold, the destination URL in parentheses if present, then any one-line \
description the email gives.\n\
- Strip navigation, subscribe/unsubscribe prompts, social-share buttons, \
'view in browser', paid-upgrade CTAs, comment/like widgets, and footers/legal.\n\
- Preserve the author's wording; do not summarize unless the instructions ask.\n\
- When per-newsletter instructions are present, follow them; they override these \
defaults.";

fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent("SubDigest/0.1")
            .build()
            .expect("failed to build http client")
    })
}

/// Pulls the human-readable message out of an Anthropic error body.
fn error_message(status: reqwest::StatusCode, body: &str) -> String {
    if let Ok(v) = serde_json::from_str::<Value>(body) {
        if let Some(msg) = v["error"]["message"].as_str() {
            return format!("Anthropic API error ({status}): {msg}");
        }
    }
    format!("Anthropic API error ({status}): {body}")
}

async fn call(api_key: &str, body: Value) -> Result<Value, String> {
    if api_key.trim().is_empty() {
        return Err("no Anthropic API key set".to_string());
    }
    let resp = http()
        .post(ANTHROPIC_URL)
        .header("x-api-key", api_key.trim())
        .header("anthropic-version", ANTHROPIC_VERSION)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Anthropic request failed: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(error_message(status, &text));
    }
    serde_json::from_str(&text).map_err(|e| format!("bad Anthropic response: {e}"))
}

/// Concatenates the text blocks of a Messages API response.
fn extract_text(resp: &Value) -> String {
    resp["content"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|b| b["type"] == "text")
        .filter_map(|b| b["text"].as_str())
        .collect::<Vec<_>>()
        .join("")
}

/// Validates an API key with a tiny request; returns the account-visible model.
#[tauri::command]
pub async fn anthropic_test(api_key: String, model: String) -> Result<String, String> {
    let model = if model.trim().is_empty() {
        "claude-opus-4-8".to_string()
    } else {
        model
    };
    let body = json!({
        "model": model,
        "max_tokens": 16,
        "messages": [{ "role": "user", "content": "Reply with the single word: ok" }],
    });
    call(&api_key, body).await?;
    Ok(format!("Connected ({model})"))
}

/// Transforms one newsletter's raw body into Markdown per the given instructions.
#[tauri::command]
pub async fn anthropic_process(
    api_key: String,
    model: String,
    instructions: String,
    subject: String,
    content: String,
) -> Result<String, String> {
    let model = if model.trim().is_empty() {
        "claude-opus-4-8".to_string()
    } else {
        model
    };

    // Bound the input so a huge email can't blow up token usage.
    let trimmed: String = content.chars().take(MAX_CONTENT_CHARS).collect();
    let instr = instructions.trim();
    let user = format!(
        "Per-newsletter instructions:\n{}\n\nNewsletter subject: {}\n\nRaw email content:\n{}",
        if instr.is_empty() { "(none — use the defaults)" } else { instr },
        subject.trim(),
        trimmed
    );

    let body = json!({
        "model": model,
        "max_tokens": 8000,
        "system": SYSTEM_PROMPT,
        "messages": [{ "role": "user", "content": user }],
    });
    let resp = call(&api_key, body).await?;

    if resp["stop_reason"] == "refusal" {
        return Err("the model declined to process this newsletter".to_string());
    }
    let markdown = extract_text(&resp);
    if markdown.trim().is_empty() {
        return Err("the agent returned no content".to_string());
    }
    Ok(markdown)
}
