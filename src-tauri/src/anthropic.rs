//! Anthropic Messages API access for the per-newsletter agent.
//!
//! Some newsletters (link roundups, heavily-templated layouts) don't map onto
//! the default HTML parser. For those, the user can assign an agent with custom
//! instructions; this module runs the transform and returns clean Markdown,
//! which the frontend converts into layout blocks.
//!
//! The agent is equipped with a `fetch_page` tool (executed here in Rust) so it
//! can scrape a linked article — optionally extracting only specific CSS
//! selectors / DIVs — instead of the user paying tokens for whole pages.

use crate::log;
use futures::StreamExt;
use serde_json::{json, Value};
use std::net::IpAddr;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tauri::AppHandle;

const ANTHROPIC_URL: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION: &str = "2023-06-01";
/// The agent runs on Haiku only — fast, cheap, and paired with a strict
/// capture-only prompt it reformats/scrapes without inventing content.
const MODEL: &str = "claude-haiku-4-5";
const MAX_CONTENT_CHARS: usize = 60_000;
/// Cap on the agent's tool-call rounds, to bound token/time cost per newsletter.
const MAX_TOOL_ROUNDS: usize = 6;
/// Cap on each tool result handed back to the model.
const MAX_TOOL_OUTPUT_CHARS: usize = 20_000;
/// Pages fetched at once. A link roundup can ask for a dozen in one turn;
/// firing them all together buries the machine and looks like a stall.
const MAX_CONCURRENT_FETCHES: usize = 4;
/// Cap on fetched page size before parsing.
const MAX_FETCH_CHARS: usize = 2_000_000;

const CONNECT_TIMEOUT_SECS: u64 = 20;
/// A long newsletter on Haiku is well inside this; it exists so a stalled
/// connection can't wedge a whole digest run.
const REQUEST_TIMEOUT_SECS: u64 = 120;
const FETCH_TIMEOUT_SECS: u64 = 45;
/// Whole-run ceiling for one newsletter. Six rounds of model calls and page
/// fetches can otherwise add up to something indistinguishable from a hang;
/// past this the run gives up and the caller falls back to normal parsing.
const AGENT_BUDGET_SECS: u64 = 240;
/// Idle pooled connections are retired early, before the far end drops them.
/// Reusing a keep-alive connection that has just gone away is the usual cause
/// of a bare "error sending request": the POST fails and, not being idempotent,
/// hyper won't replay it.
const POOL_IDLE_SECS: u64 = 15;
/// Total tries per API call, matching what the Anthropic SDKs do by default.
const MAX_ATTEMPTS: u32 = 3;

const BROWSER_UA: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const SYSTEM_PROMPT: &str = "You assemble one email newsletter into clean Markdown \
for a printed reading digest. You are given the raw email (HTML or plain text) \
plus optional per-newsletter instructions, and you have a `fetch_page` tool that \
retrieves linked web pages.\n\n\
ABSOLUTE RULE — capture only, never invent:\n\
- Every word you output must come verbatim from the provided email or from a page \
you retrieved with `fetch_page`. Do NOT write anything from your own knowledge, \
memory, or imagination.\n\
- If the instructions ask you to include a linked article's content, you MUST \
call `fetch_page` on that link and use only what it returns. Never reconstruct, \
guess, paraphrase, or 'fill in' an article you have not actually fetched.\n\
- If a fetch fails, is blocked, or returns no usable content, output the item's \
title followed by '(content unavailable)'. Do NOT fabricate a substitute.\n\
- Add no opinions, commentary, introductions, transitions, or embellishments of \
your own. Do not summarize unless the instructions explicitly ask; when you must \
condense, use only wording drawn from the source.\n\n\
Output format:\n\
- Output GitHub-flavored Markdown only: no preamble, no explanation, no code \
fences wrapping the whole answer.\n\
- Do NOT include the newsletter's title or a top-level # heading; the digest adds \
its own header.\n\
- Use ## and ### for section headings, - for bullet lists, 1. for numbered lists, \
> for quotes, ![](url) for images worth keeping, and --- for a divider.\n\
- For link-roundup newsletters, render each item as a list entry: the linked \
title in bold, the destination URL in parentheses if present, then any \
description the source itself provides.\n\
- Strip navigation, subscribe/unsubscribe prompts, social-share buttons, \
'view in browser', paid-upgrade CTAs, comment/like widgets, and footers/legal.\n\n\
Using the tool:\n\
- Fetch a page only when the newsletter's own text is insufficient and the \
instructions call for linked content. Prefer a CSS `selector` (e.g. 'article', \
'.post-content', '#main') so you get just the article body and keep costs low. \
Fetch no more pages than the task needs.\n\n\
Per-newsletter instructions, when present, take priority over these formatting \
defaults — but the ABSOLUTE RULE always holds.";

fn tools() -> Value {
    json!([{
        "name": "fetch_page",
        "description": "Fetch a web page over HTTP(S) and return its content. \
By default returns the page's readable text (paragraphs, headings, list items — \
scripts, styles, and navigation excluded), which is token-efficient. Pass a CSS \
`selector` to return only the matching elements (e.g. 'article', '.post-content', \
'#main') — use this to extract a specific DIV/container and avoid unrelated page \
chrome. Set `as_html` to true to get the matched elements' inner HTML with tags, \
useful for discovering the right class/id to target in a follow-up call.",
        "input_schema": {
            "type": "object",
            "properties": {
                "url": { "type": "string", "description": "Absolute http(s) URL to fetch." },
                "selector": { "type": "string", "description": "Optional CSS selector; return only matching elements. Omit for the page's readable text." },
                "as_html": { "type": "boolean", "description": "If true, return matched elements' inner HTML instead of plain text. Requires a selector." }
            },
            "required": ["url"]
        }
    }])
}

/// Dedicated HTTP client (no default UA — set per request for scraping).
fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(CONNECT_TIMEOUT_SECS))
            .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
            .pool_idle_timeout(Duration::from_secs(POOL_IDLE_SECS))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

fn error_message(status: reqwest::StatusCode, body: &str) -> String {
    if let Ok(v) = serde_json::from_str::<Value>(body) {
        if let Some(msg) = v["error"]["message"].as_str() {
            return format!("Anthropic API error ({status}): {msg}");
        }
    }
    format!("Anthropic API error ({status}): {body}")
}

/// Spells out *why* a request failed. reqwest's own message stops at
/// "error sending request for url (…)", which names no cause; the DNS, TLS or
/// connection detail that identifies the problem is down the source chain.
fn describe(err: &reqwest::Error) -> String {
    let mut out = err.to_string();
    let mut source = std::error::Error::source(err);
    while let Some(cause) = source {
        let msg = cause.to_string();
        if !out.contains(&msg) {
            out.push_str(": ");
            out.push_str(&msg);
        }
        source = cause.source();
    }
    if err.is_timeout() {
        out.push_str(" (timed out)");
    } else if err.is_connect() {
        out.push_str(" — could not reach the API; check your network, VPN or proxy");
    }
    out
}

/// Status codes worth another try: rate limits, overload, and gateway hiccups.
fn retriable(status: reqwest::StatusCode) -> bool {
    matches!(status.as_u16(), 408 | 409 | 429 | 500 | 502 | 503 | 504 | 529)
}

/// Honours a `retry-after` header (seconds), capped so a run can't stall.
fn retry_after(resp: &reqwest::Response) -> Option<Duration> {
    let secs: u64 = resp
        .headers()
        .get(reqwest::header::RETRY_AFTER)?
        .to_str()
        .ok()?
        .trim()
        .parse()
        .ok()?;
    Some(Duration::from_secs(secs.min(30)))
}

fn backoff(attempt: u32) -> Duration {
    Duration::from_millis(500 * 2u64.pow(attempt.saturating_sub(1).min(4)))
}

async fn call(app: &AppHandle, api_key: &str, body: Value) -> Result<Value, String> {
    if api_key.trim().is_empty() {
        return Err("no Anthropic API key set".to_string());
    }
    let mut attempt: u32 = 1;
    loop {
        let started = Instant::now();
        let sent = http()
            .post(ANTHROPIC_URL)
            .header("x-api-key", api_key.trim())
            .header("anthropic-version", ANTHROPIC_VERSION)
            .json(&body)
            .send()
            .await;

        match sent {
            // A transport failure means the exchange didn't complete — most
            // often a keep-alive connection the far end had already closed, or
            // a brief network drop — so the call is worth repeating.
            Err(e) if attempt < MAX_ATTEMPTS && (e.is_connect() || e.is_timeout() || e.is_request()) => {
                let wait = backoff(attempt);
                log::warn(
                    app,
                    "agent",
                    format!(
                        "API attempt {attempt}/{MAX_ATTEMPTS} failed after {:.1}s ({}); retrying in {:.1}s",
                        started.elapsed().as_secs_f32(),
                        describe(&e),
                        wait.as_secs_f32()
                    ),
                );
                tokio::time::sleep(wait).await;
                attempt += 1;
            }
            Err(e) => return Err(format!("Anthropic request failed: {}", describe(&e))),
            Ok(resp) if attempt < MAX_ATTEMPTS && retriable(resp.status()) => {
                let status = resp.status();
                let wait = retry_after(&resp).unwrap_or_else(|| backoff(attempt));
                log::warn(
                    app,
                    "agent",
                    format!(
                        "API returned {status} on attempt {attempt}/{MAX_ATTEMPTS}; retrying in {:.1}s",
                        wait.as_secs_f32()
                    ),
                );
                tokio::time::sleep(wait).await;
                attempt += 1;
            }
            Ok(resp) => {
                let status = resp.status();
                let text = resp
                    .text()
                    .await
                    .map_err(|e| format!("Anthropic reply cut short: {}", describe(&e)))?;
                if !status.is_success() {
                    return Err(error_message(status, &text));
                }
                let value: Value = serde_json::from_str(&text)
                    .map_err(|e| format!("bad Anthropic response: {e}"))?;
                log::info(
                    app,
                    "agent",
                    format!(
                        "API replied in {:.1}s ({} in / {} out tokens, stop: {})",
                        started.elapsed().as_secs_f32(),
                        value["usage"]["input_tokens"].as_u64().unwrap_or(0),
                        value["usage"]["output_tokens"].as_u64().unwrap_or(0),
                        value["stop_reason"].as_str().unwrap_or("?")
                    ),
                );
                return Ok(value);
            }
        }
    }
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

/// Validates an API key with a tiny request; returns a status string.
#[tauri::command]
pub async fn anthropic_test(app: AppHandle, api_key: String) -> Result<String, String> {
    let body = json!({
        "model": MODEL,
        "max_tokens": 16,
        "messages": [{ "role": "user", "content": "Reply with the single word: ok" }],
    });
    log::info(&app, "agent", "Testing API key");
    call(&app, &api_key, body).await?;
    Ok("Connected (Claude Haiku 4.5)".to_string())
}

/// Transforms one newsletter's raw body into Markdown, running the agent's
/// `fetch_page` tool loop as needed.
#[tauri::command]
pub async fn anthropic_process(
    app: AppHandle,
    api_key: String,
    instructions: String,
    subject: String,
    content: String,
) -> Result<String, String> {
    // A stalled run is indistinguishable from a hung app, so cap the whole
    // thing; the caller falls back to the default parser on failure.
    match tokio::time::timeout(
        Duration::from_secs(AGENT_BUDGET_SECS),
        run_agent(&app, api_key, instructions, subject.clone(), content),
    )
    .await
    {
        Ok(result) => {
            if let Err(e) = &result {
                log::error(&app, "agent", format!("\"{subject}\" failed: {e}"));
            }
            result
        }
        Err(_) => {
            let msg = format!("gave up after {AGENT_BUDGET_SECS}s on \"{subject}\"");
            log::error(&app, "agent", msg.clone());
            Err(msg)
        }
    }
}

async fn run_agent(
    app: &AppHandle,
    api_key: String,
    instructions: String,
    subject: String,
    content: String,
) -> Result<String, String> {
    let started = Instant::now();
    let trimmed: String = content.chars().take(MAX_CONTENT_CHARS).collect();
    let instr = instructions.trim();
    let user = format!(
        "Per-newsletter instructions:\n{}\n\nNewsletter subject: {}\n\nRaw email content:\n{}",
        if instr.is_empty() { "(none — use the defaults)" } else { instr },
        subject.trim(),
        trimmed
    );

    log::info(
        app,
        "agent",
        format!(
            "Starting \"{}\" — {} chars of email{}",
            subject.trim(),
            trimmed.chars().count(),
            if instr.is_empty() {
                String::new()
            } else {
                format!(", instructions: {}", log::ellipsize(instr, 120))
            }
        ),
    );

    let mut messages: Vec<Value> = vec![json!({ "role": "user", "content": user })];

    for round in 1..=MAX_TOOL_ROUNDS {
        log::info(app, "agent", format!("Round {round}/{MAX_TOOL_ROUNDS}: asking the model"));
        let body = json!({
            "model": MODEL,
            "max_tokens": 8000,
            "temperature": 0, // deterministic, faithful capture — no creative drift
            "system": SYSTEM_PROMPT,
            "tools": tools(),
            "messages": messages,
        });
        let resp = call(app, &api_key, body).await?;
        let stop = resp["stop_reason"].as_str().unwrap_or("");

        if stop == "refusal" {
            return Err("the model declined to process this newsletter".to_string());
        }
        if stop == "tool_use" {
            // Record the assistant turn, then answer every tool call it made.
            messages.push(json!({ "role": "assistant", "content": resp["content"].clone() }));

            let calls: Vec<(String, Value)> = resp["content"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|b| b["type"] == "tool_use")
                .map(|b| (b["id"].as_str().unwrap_or("").to_string(), b.clone()))
                .collect();

            log::info(
                app,
                "agent",
                format!("Round {round}: {} page fetch(es) requested", calls.len()),
            );

            let results: Vec<Value> = futures::stream::iter(calls.into_iter().map(
                |(id, block)| async move {
                    match run_tool(app, &block).await {
                        Ok(text) => json!({ "type": "tool_result", "tool_use_id": id, "content": text }),
                        Err(e) => {
                            json!({ "type": "tool_result", "tool_use_id": id, "content": e, "is_error": true })
                        }
                    }
                },
            ))
            .buffered(MAX_CONCURRENT_FETCHES)
            .collect()
            .await;

            messages.push(json!({ "role": "user", "content": results }));
            continue;
        }

        // Terminal turn — return the Markdown it produced.
        let markdown = extract_text(&resp);
        if markdown.trim().is_empty() {
            return Err(format!("the agent returned no content (stop reason: {stop})"));
        }
        log::info(
            app,
            "agent",
            format!(
                "Finished \"{}\" in {:.1}s: {} chars of Markdown",
                subject.trim(),
                started.elapsed().as_secs_f32(),
                markdown.chars().count()
            ),
        );
        return Ok(markdown);
    }

    Err(format!(
        "the agent still wanted more pages after {MAX_TOOL_ROUNDS} rounds; giving up"
    ))
}

// ---------------------------------------------------------------------------
// Tools

async fn run_tool(app: &AppHandle, block: &Value) -> Result<String, String> {
    let name = block["name"].as_str().unwrap_or("");
    let input = &block["input"];
    match name {
        "fetch_page" => {
            let url = input["url"].as_str().ok_or("fetch_page: missing 'url'")?;
            let selector = input["selector"].as_str().filter(|s| !s.trim().is_empty());
            let as_html = input["as_html"].as_bool().unwrap_or(false);
            let started = Instant::now();
            log::info(
                app,
                "fetch",
                format!(
                    "GET {}{}{}",
                    log::ellipsize(url, 120),
                    selector.map(|s| format!(" [{s}]")).unwrap_or_default(),
                    if as_html { " (html)" } else { "" }
                ),
            );
            let result = fetch_page(url, selector, as_html).await;
            match &result {
                Ok(text) => log::info(
                    app,
                    "fetch",
                    format!(
                        "{} chars in {:.1}s from {}",
                        text.chars().count(),
                        started.elapsed().as_secs_f32(),
                        log::ellipsize(url, 90)
                    ),
                ),
                Err(e) => log::warn(
                    app,
                    "fetch",
                    format!("{e} after {:.1}s — {}", started.elapsed().as_secs_f32(), log::ellipsize(url, 90)),
                ),
            }
            result
        }
        other => Err(format!("unknown tool: {other}")),
    }
}

fn host_blocked(host: &str) -> bool {
    let h = host.to_ascii_lowercase();
    if h == "localhost" || h.ends_with(".localhost") {
        return true;
    }
    match h.parse::<IpAddr>() {
        Ok(IpAddr::V4(v4)) => {
            v4.is_loopback() || v4.is_private() || v4.is_link_local() || v4.is_unspecified()
        }
        Ok(IpAddr::V6(v6)) => v6.is_loopback() || v6.is_unspecified(),
        Err(_) => false,
    }
}

async fn fetch_page(url: &str, selector: Option<&str>, as_html: bool) -> Result<String, String> {
    let parsed = url::Url::parse(url).map_err(|e| format!("bad url: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("only http(s) URLs can be fetched".to_string());
    }
    if parsed.host_str().map(host_blocked).unwrap_or(true) {
        return Err("refusing to fetch a private or loopback address".to_string());
    }

    let resp = http()
        .get(parsed)
        .header("user-agent", BROWSER_UA)
        .timeout(Duration::from_secs(FETCH_TIMEOUT_SECS)) // a slow page shouldn't hold up the run
        .send()
        .await
        .map_err(|e| format!("fetch failed: {}", describe(&e)))?;
    if !resp.status().is_success() {
        return Err(format!("fetch failed: HTTP {}", resp.status()));
    }
    let body = resp.text().await.map_err(|e| format!("could not read page: {e}"))?;
    let body: String = if body.len() > MAX_FETCH_CHARS {
        body.chars().take(MAX_FETCH_CHARS).collect()
    } else {
        body
    };

    // Parse + extract synchronously (scraper's Html isn't Send; no awaits here).
    let out = extract(&body, selector, as_html)?;
    Ok(truncate_output(out))
}

fn extract(html: &str, selector: Option<&str>, as_html: bool) -> Result<String, String> {
    let doc = scraper::Html::parse_document(html);

    if let Some(sel) = selector {
        let parsed = scraper::Selector::parse(sel)
            .map_err(|e| format!("invalid CSS selector '{sel}': {e:?}"))?;
        let mut parts = Vec::new();
        for el in doc.select(&parsed) {
            if as_html {
                parts.push(el.inner_html());
            } else {
                let text = normalize(&el.text().collect::<Vec<_>>().join(" "));
                if !text.is_empty() {
                    parts.push(text);
                }
            }
        }
        if parts.is_empty() {
            return Err(format!("no elements matched selector '{sel}'"));
        }
        return Ok(parts.join("\n\n"));
    }

    // No selector: readable text from content tags (naturally excludes script/style/nav).
    let content = scraper::Selector::parse("p, h1, h2, h3, h4, h5, h6, li, blockquote, figcaption")
        .expect("static selector");
    let mut parts = Vec::new();
    for el in doc.select(&content) {
        let text = normalize(&el.text().collect::<Vec<_>>().join(" "));
        if !text.is_empty() {
            parts.push(text);
        }
    }
    if !parts.is_empty() {
        return Ok(parts.join("\n"));
    }
    // Fallback: whole-body text.
    let body = scraper::Selector::parse("body").expect("static selector");
    if let Some(b) = doc.select(&body).next() {
        let text = normalize(&b.text().collect::<Vec<_>>().join(" "));
        if !text.is_empty() {
            return Ok(text);
        }
    }
    Err("no readable text found on the page".to_string())
}

fn normalize(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate_output(mut s: String) -> String {
    if s.chars().count() > MAX_TOOL_OUTPUT_CHARS {
        s = s.chars().take(MAX_TOOL_OUTPUT_CHARS).collect();
        s.push_str("\n…[truncated]");
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE: &str = r#"<html><head><style>.x{color:red}</style>
        <script>var a = 'noise';</script></head>
        <body>
          <nav>Home About</nav>
          <article class="post-content">
            <h1>The Headline</h1>
            <p>First paragraph of the article.</p>
            <p>Second paragraph here.</p>
          </article>
          <aside class="related">unrelated sidebar text</aside>
          <footer>© 2026</footer>
        </body></html>"#;

    #[test]
    fn extracts_selector_text() {
        let out = extract(PAGE, Some(".post-content"), false).unwrap();
        assert!(out.contains("First paragraph of the article."));
        assert!(out.contains("Second paragraph here."));
        assert!(!out.contains("sidebar"));
        assert!(!out.contains("noise")); // script text excluded
    }

    #[test]
    fn extracts_selector_html() {
        let out = extract(PAGE, Some("article"), true).unwrap();
        assert!(out.contains("<p>First paragraph of the article.</p>"));
    }

    #[test]
    fn readable_text_skips_chrome_and_scripts() {
        let out = extract(PAGE, None, false).unwrap();
        assert!(out.contains("The Headline"));
        assert!(out.contains("First paragraph of the article."));
        assert!(!out.contains("noise")); // no <script> body
        assert!(!out.contains("color:red")); // no <style> body
    }

    #[test]
    fn missing_selector_errors() {
        assert!(extract(PAGE, Some(".does-not-exist"), false).is_err());
    }

    #[test]
    fn retries_rate_limits_and_gateway_errors_only() {
        use reqwest::StatusCode;
        for code in [429, 500, 502, 503, 504, 529] {
            assert!(retriable(StatusCode::from_u16(code).unwrap()), "{code} should retry");
        }
        for code in [200, 400, 401, 403, 404, 413] {
            assert!(!retriable(StatusCode::from_u16(code).unwrap()), "{code} should not retry");
        }
    }

    #[test]
    fn backoff_grows_and_stays_bounded() {
        assert!(backoff(1) < backoff(2) && backoff(2) < backoff(3));
        assert!(backoff(99) <= Duration::from_secs(8));
    }

    /// The failure this guards against reports only "error sending request for
    /// url (…)". Checks that the cause is appended, and that the kind really is
    /// one the retry arm in `call` matches.
    #[tokio::test]
    async fn transport_failures_name_their_cause() {
        // Nothing listens on port 1, so the connection is refused outright.
        let err = reqwest::Client::new()
            .post("http://127.0.0.1:1/v1/messages")
            .send()
            .await
            .expect_err("connection should be refused");

        assert!(
            err.is_connect() || err.is_request() || err.is_timeout(),
            "retry arm would not match this error: {err:?}"
        );
        let described = describe(&err);
        assert!(
            described.len() > err.to_string().len(),
            "no cause appended to {described:?}"
        );
    }

    #[test]
    fn blocks_private_hosts() {
        assert!(host_blocked("localhost"));
        assert!(host_blocked("127.0.0.1"));
        assert!(host_blocked("10.0.0.5"));
        assert!(host_blocked("192.168.1.1"));
        assert!(host_blocked("169.254.1.1"));
        assert!(!host_blocked("example.com"));
        assert!(!host_blocked("8.8.8.8"));
    }
}
