//! Anthropic Messages API access for the per-newsletter agent.
//!
//! Some newsletters (link roundups, heavily-templated layouts) don't map onto
//! the default HTML parser. For those, the user can assign an agent with custom
//! instructions; this module runs the transform and returns clean Markdown,
//! which the frontend converts into layout blocks.
//!
//! There is exactly one model call, and its only job is naming the newsletter's
//! links (structured output). Everything after that is code: this module
//! resolves each link, scrapes the article as Markdown, and assembles the entry
//! from what came back. The model never writes a word of the digest — having it
//! retype the scraped articles cost 30-80s per newsletter and bought nothing,
//! since the text was already in hand.

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
/// Cap on one scraped article. This used to be 20k because every character was
/// about to be spent as model input *and* re-emitted as output; now the text
/// goes straight into the digest, so it only has to be long enough that a piece
/// of long-form journalism arrives whole.
const MAX_ARTICLE_CHARS: usize = 60_000;
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
/// Longest gap between bytes before a response is treated as dead. Streaming
/// keeps traffic flowing, so a silence this long is a real stall rather than
/// the model thinking.
const READ_TIMEOUT_SECS: u64 = 45;
/// Whole-run ceiling for one newsletter: one model call plus a round of page
/// fetches. Past this the run gives up and the caller falls back to normal
/// parsing, rather than leaving something indistinguishable from a hang.
const AGENT_BUDGET_SECS: u64 = 240;
/// Total tries per API call, matching what the Anthropic SDKs do by default.
const MAX_ATTEMPTS: u32 = 3;

const BROWSER_UA: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const LINK_PROMPT: &str = "You are given one email newsletter. Identify the \
outbound links to articles it is recommending, and return them in the required \
JSON shape.\n\n\
Rules:\n\
- Include a link only when the newsletter is pointing the reader at a piece of \
writing: an article, essay, story, paper, or post.\n\
- Exclude the newsletter's own chrome: subscribe/unsubscribe, 'view in browser', \
'read in app', comment/like/share/restack, social profiles, app stores, \
sponsor/advertisement links, the publication's own archive or homepage, and \
anything pointing at an email address.\n\
- Copy each URL exactly as it appears in the email, character for character. Do \
not clean, shorten, unwrap, or resolve it — that is handled downstream.\n\
- Take the title and the note verbatim from the newsletter's own words. Never \
write a description of your own; if the newsletter gives none, leave the note \
empty.\n\
- List each distinct article once, in the order the newsletter presents them.\n\
- If the newsletter recommends no articles, return an empty list. Do not invent \
links to fill it.\n\n\
If the per-newsletter instructions name a CSS selector to pull content out of \
the linked pages, return it as `selector`; otherwise return an empty string.";

/// The shape the link pass must return. Structured outputs require
/// `additionalProperties: false` on every object and every property listed in
/// `required`, so optional fields are modelled as empty strings.
fn link_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "items": {
                "type": "array",
                "description": "The articles this newsletter recommends, in order.",
                "items": {
                    "type": "object",
                    "properties": {
                        "title": {
                            "type": "string",
                            "description": "The item's title, in the newsletter's own words."
                        },
                        "url": {
                            "type": "string",
                            "description": "The link's destination exactly as written in the email."
                        },
                        "note": {
                            "type": "string",
                            "description": "The newsletter's own description of the item, or an empty string."
                        }
                    },
                    "required": ["title", "url", "note"],
                    "additionalProperties": false
                }
            },
            "selector": {
                "type": "string",
                "description": "CSS selector to extract from the linked pages if the per-newsletter instructions name one, otherwise an empty string."
            }
        },
        "required": ["items", "selector"],
        "additionalProperties": false
    })
}

/// One article the newsletter points at, as the model read it out of the email.
#[derive(Debug, Clone)]
struct LinkItem {
    title: String,
    url: String,
    note: String,
}

/// One scraped page: the URL the text actually came from — after the redirect
/// wrapper and the query-string retry, so it's the article's own address rather
/// than the newsletter's — and the page as Markdown.
#[derive(Debug, Clone)]
struct Article {
    url: String,
    markdown: String,
}

/// Dedicated HTTP client (no default UA — set per request for scraping).
fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(CONNECT_TIMEOUT_SECS))
            .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
            // No pooling and no HTTP/2 for these calls. A pooled connection the
            // far end has already dropped fails the next POST outright, and an
            // h2 connection multiplexes that failure across everything sharing
            // it. A fresh HTTP/1.1 connection per request costs a handshake and
            // removes both. See the streaming note in `call` for the rest.
            .pool_max_idle_per_host(0)
            .http1_only()
            // Nothing arriving for this long means the connection is dead,
            // however healthy the socket looks.
            .read_timeout(Duration::from_secs(READ_TIMEOUT_SECS))
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

/// What a streamed response adds up to.
#[derive(Default)]
struct StreamedMessage {
    text: String,
    stop_reason: String,
    input_tokens: u64,
    output_tokens: u64,
    first_token_secs: f32,
    total_secs: f32,
}

impl StreamedMessage {
    /// Tokens emitted per second of *generation* — the wait after the first
    /// token, which is the part that scales with how much the model writes.
    /// Time-to-first-token is queueing and prompt processing, and is reported
    /// separately; lumping them together hides which one a slow call was.
    fn tokens_per_sec(&self) -> f32 {
        let generating = (self.total_secs - self.first_token_secs).max(0.01);
        self.output_tokens as f32 / generating
    }
}

/// Folds one SSE payload into the message being assembled. Anything not
/// carrying content or bookkeeping (`ping`, block starts/stops) is ignored.
fn apply_event(event: &Value, msg: &mut StreamedMessage) -> Result<(), String> {
    match event["type"].as_str().unwrap_or("") {
        "message_start" => {
            let usage = &event["message"]["usage"];
            msg.input_tokens = usage["input_tokens"].as_u64().unwrap_or(0);
        }
        "content_block_delta" => {
            if let Some(text) = event["delta"]["text"].as_str() {
                msg.text.push_str(text);
            }
        }
        "message_delta" => {
            if let Some(stop) = event["delta"]["stop_reason"].as_str() {
                msg.stop_reason = stop.to_string();
            }
            if let Some(out) = event["usage"]["output_tokens"].as_u64() {
                msg.output_tokens = out;
            }
        }
        "error" => {
            let detail = event["error"]["message"]
                .as_str()
                .unwrap_or("unknown streaming error");
            return Err(format!("Anthropic stream error: {detail}"));
        }
        _ => {}
    }
    Ok(())
}

/// Consumes the SSE body. Streaming isn't for show here: a request that sits
/// silent while the model works is exactly what an idle-connection timeout
/// somewhere in the path kills, and the first-token timing it records says
/// whether a slow call was slow to start or slow to finish.
async fn read_stream(resp: reqwest::Response, started: Instant) -> Result<StreamedMessage, String> {
    let mut msg = StreamedMessage::default();
    let mut buffer = String::new();
    let mut body = resp.bytes_stream();

    while let Some(chunk) = body.next().await {
        let chunk = chunk.map_err(|e| format!("Anthropic stream cut short: {}", describe(&e)))?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        // SSE events are separated by a blank line.
        while let Some(end) = buffer.find("\n\n") {
            let raw: String = buffer.drain(..end + 2).collect();
            for line in raw.lines() {
                let Some(data) = line.strip_prefix("data:") else { continue };
                let data = data.trim();
                if data.is_empty() || data == "[DONE]" {
                    continue;
                }
                let event: Value = serde_json::from_str(data)
                    .map_err(|e| format!("bad Anthropic stream event: {e}"))?;
                if msg.text.is_empty() && event["type"] == "content_block_delta" {
                    msg.first_token_secs = started.elapsed().as_secs_f32();
                }
                apply_event(&event, &mut msg)?;
            }
        }
    }
    Ok(msg)
}

async fn call(app: &AppHandle, api_key: &str, body: Value) -> Result<StreamedMessage, String> {
    if api_key.trim().is_empty() {
        return Err("no Anthropic API key set".to_string());
    }
    let mut attempt: u32 = 1;
    loop {
        let started = Instant::now();
        let mut streaming = body.clone();
        streaming["stream"] = json!(true);
        let sent = http()
            .post(ANTHROPIC_URL)
            .header("x-api-key", api_key.trim())
            .header("anthropic-version", ANTHROPIC_VERSION)
            .json(&streaming)
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
                if !status.is_success() {
                    let text = resp.text().await.unwrap_or_default();
                    return Err(error_message(status, &text));
                }
                let mut msg = read_stream(resp, started).await?;
                msg.total_secs = started.elapsed().as_secs_f32();
                log::info(
                    app,
                    "agent",
                    format!(
                        "API replied in {:.1}s, first token at {:.1}s ({} in / {} out tokens, {:.0} tok/s, stop: {})",
                        msg.total_secs,
                        msg.first_token_secs,
                        msg.input_tokens,
                        msg.output_tokens,
                        msg.tokens_per_sec(),
                        msg.stop_reason
                    ),
                );
                return Ok(msg);
            }
        }
    }
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

    // The one model call. Its only job is naming the links.
    let links_started = Instant::now();
    let (links, selector) = extract_links(app, &api_key, &user).await?;
    let links_secs = links_started.elapsed().as_secs_f32();
    if links.is_empty() {
        return Err("no article links found in this email".to_string());
    }
    log::info(app, "agent", format!("{} link(s) identified:", links.len()));
    for (i, link) in links.iter().enumerate() {
        log::info(
            app,
            "agent",
            format!("  {}. {} — {}", i + 1, log::ellipsize(&link.title, 70), link.url),
        );
    }
    // The link pass is only allowed to *copy* URLs out of the email, so check
    // that it did: a URL that isn't in the email character for character is one
    // the model composed, and nothing downstream would otherwise notice.
    let copied = links.iter().filter(|l| quoted_verbatim(&user, &l.url)).count();
    if copied == links.len() {
        log::info(
            app,
            "agent",
            format!(
                "All {} URL(s) appear verbatim in the email — the model located links, it did not compose them",
                links.len()
            ),
        );
    } else {
        log::warn(
            app,
            "agent",
            format!(
                "only {copied}/{} URL(s) appear verbatim in the email — the rest were rewritten or invented by the model",
                links.len()
            ),
        );
        for link in links.iter().filter(|l| !quoted_verbatim(&user, &l.url)) {
            log::warn(app, "agent", format!("  not in the email: {}", link.url));
        }
    }
    if let Some(sel) = &selector {
        log::info(app, "agent", format!("Using selector from instructions: {sel}"));
    }

    // The scraper takes it from here. We do the fetching, so the URL we
    // retrieve is one we can see.
    let fetch_started = Instant::now();
    log::info(
        app,
        "agent",
        format!(
            "Scraping {} page(s), {MAX_CONCURRENT_FETCHES} at a time — no model call in this phase",
            links.len()
        ),
    );
    let sel = selector.as_deref();
    let articles: Vec<(LinkItem, Result<Article, String>)> =
        futures::stream::iter(links.into_iter().map(|link| async move {
            let article = resolve_and_fetch(app, &link.url, sel).await;
            (link, article)
        }))
        .buffered(MAX_CONCURRENT_FETCHES)
        .collect()
        .await;
    let fetch_secs = fetch_started.elapsed().as_secs_f32();

    let fetched = articles.iter().filter(|(_, r)| r.is_ok()).count();
    let scraped: usize = articles
        .iter()
        .filter_map(|(_, r)| r.as_ref().ok())
        .map(|a| a.markdown.chars().count())
        .sum();
    log::info(
        app,
        "agent",
        format!(
            "{fetched}/{} page(s) fetched — {scraped} chars scraped by the scraper in {fetch_secs:.1}s",
            articles.len()
        ),
    );

    // The entry is built here, in code, out of what the scraper returned. The
    // model is not asked to write it: the article text already exists, and
    // having it retyped a token at a time was the whole of the old runtime.
    if fetched == 0 {
        return Err(format!(
            "none of the {} linked page(s) could be scraped",
            articles.len()
        ));
    }
    let assemble_started = Instant::now();
    let markdown = assemble(&articles);
    let assemble_secs = assemble_started.elapsed().as_secs_f32();
    log::info(
        app,
        "agent",
        format!(
            "Assembled the entry in code from {fetched} scraped page(s) — {} chars of Markdown, no model call",
            markdown.chars().count()
        ),
    );

    let total = started.elapsed().as_secs_f32();
    let pct = |secs: f32| if total > 0.0 { secs / total * 100.0 } else { 0.0 };
    log::info(
        app,
        "agent",
        format!(
            "Finished \"{}\" in {total:.1}s: {} chars of Markdown — \
             find links {links_secs:.1}s ({:.0}%) · scrape {fetch_secs:.1}s ({:.0}%) · assemble {assemble_secs:.1}s ({:.0}%)",
            subject.trim(),
            markdown.chars().count(),
            pct(links_secs),
            pct(fetch_secs),
            pct(assemble_secs),
        ),
    );
    Ok(markdown)
}

/// Pass 1: the model reads the email and names the links, in a fixed JSON shape
/// (structured outputs) rather than free-form text we'd have to parse.
async fn extract_links(
    app: &AppHandle,
    api_key: &str,
    user: &str,
) -> Result<(Vec<LinkItem>, Option<String>), String> {
    let body = json!({
        "model": MODEL,
        "max_tokens": 4000,
        "temperature": 0,
        "system": LINK_PROMPT,
        "output_config": { "format": { "type": "json_schema", "schema": link_schema() } },
        "messages": [{ "role": "user", "content": user }],
    });
    log::info(app, "agent", "Identifying the newsletter's links");
    let msg = call(app, api_key, body).await?;
    if msg.stop_reason == "refusal" {
        return Err("the model declined to read this newsletter".to_string());
    }
    // What this pass was given and what it produced, in full: the email and
    // nothing else in, a JSON link list and nothing else out. No page text has
    // been fetched at this point, so none of it can be in the prompt.
    log::info(
        app,
        "agent",
        format!(
            "Link pass read {} chars of email and wrote {} chars of JSON ({} output tokens) — no page text involved",
            user.chars().count(),
            msg.text.chars().count(),
            msg.output_tokens,
        ),
    );

    parse_link_response(&msg.text)
}

/// Whether a URL the model returned really appears in the email it was given.
/// Emails carry URLs HTML-escaped, so a decoded copy counts as verbatim too.
fn quoted_verbatim(email: &str, url: &str) -> bool {
    email.contains(url) || email.replace("&amp;", "&").contains(url)
}

/// Builds the digest entry: one section per link, each headed by the title the
/// newsletter gave it, followed by the article as the scraper read it.
///
/// Everything here is copied, never composed — which is what the model was
/// being asked to do too, only one token at a time.
fn assemble(articles: &[(LinkItem, Result<Article, String>)]) -> String {
    let mut out = String::new();
    for (link, article) in articles {
        if !out.is_empty() {
            out.push_str("\n---\n\n");
        }
        let title = match link.title.trim() {
            "" => link.url.as_str(),
            t => t,
        };
        out.push_str(&format!("## {title}\n\n"));
        // The source the text actually came from — the resolved article, not
        // the newsletter's redirect wrapper.
        match article {
            Ok(a) => out.push_str(&format!("{}\n\n", a.url)),
            Err(_) => out.push_str(&format!("{}\n\n", link.url)),
        }
        if !link.note.trim().is_empty() {
            out.push_str(&format!("> {}\n\n", normalize(&link.note)));
        }
        match article {
            Ok(a) => {
                out.push_str(a.markdown.trim());
                out.push('\n');
            }
            Err(e) => out.push_str(&format!("(content unavailable — {e})\n")),
        }
    }
    out
}

/// Reads the link pass's JSON back into link items. The schema guarantees the
/// shape, so this only has to drop entries with no URL and normalise blanks.
fn parse_link_response(text: &str) -> Result<(Vec<LinkItem>, Option<String>), String> {
    let parsed: Value = serde_json::from_str(text.trim())
        .map_err(|e| format!("link list wasn't valid JSON: {e}"))?;

    let items = parsed["items"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let url = item["url"].as_str().unwrap_or("").trim().to_string();
            if url.is_empty() {
                return None;
            }
            Some(LinkItem {
                title: item["title"].as_str().unwrap_or("").trim().to_string(),
                url,
                note: item["note"].as_str().unwrap_or("").trim().to_string(),
            })
        })
        .collect();

    let selector = parsed["selector"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    Ok((items, selector))
}

// ---------------------------------------------------------------------------
// Fetching

/// Follows a newsletter's redirect wrapper to the real article, then retries
/// without the query string: the tracking parameters those wrappers append
/// (`?ref=`, `?m=`, campaign ids) can land on an error or interstitial page,
/// where the bare URL serves the article. Falls back to whatever the original
/// URL gave if the trimmed one doesn't work out. Every step is logged, since
/// which URL was actually read is the thing worth being able to check.
async fn resolve_and_fetch(
    app: &AppHandle,
    requested: &str,
    selector: Option<&str>,
) -> Result<Article, String> {
    let started = Instant::now();
    log::info(app, "fetch", format!("GET {}", log::ellipsize(requested, 140)));

    let (landed, text) = fetch_url(requested, selector).await.map_err(|e| {
        log::warn(
            app,
            "fetch",
            format!("{e} after {:.1}s — {}", started.elapsed().as_secs_f32(), log::ellipsize(requested, 100)),
        );
        e
    })?;

    if landed.as_str() != requested {
        log::info(app, "fetch", format!("  redirected to {}", log::ellipsize(landed.as_str(), 140)));
    }

    // Retry on the bare URL when the destination carries a query string.
    if let Some(bare) = without_query(&landed) {
        log::info(app, "fetch", format!("  retrying without query: {}", log::ellipsize(bare.as_str(), 140)));
        match fetch_url(bare.as_str(), selector).await {
            Ok((_, clean_text)) if !clean_text.trim().is_empty() => {
                log::info(
                    app,
                    "fetch",
                    format!(
                        "  used {} — {} chars in {:.1}s",
                        log::ellipsize(bare.as_str(), 100),
                        clean_text.chars().count(),
                        started.elapsed().as_secs_f32()
                    ),
                );
                return Ok(Article { url: bare.to_string(), markdown: clean_text });
            }
            Ok(_) => log::warn(app, "fetch", "  bare URL returned nothing; keeping the original"),
            Err(e) => log::warn(app, "fetch", format!("  bare URL failed ({e}); keeping the original")),
        }
    }

    log::info(
        app,
        "fetch",
        format!(
            "  used {} — {} chars in {:.1}s",
            log::ellipsize(landed.as_str(), 100),
            text.chars().count(),
            started.elapsed().as_secs_f32()
        ),
    );
    Ok(Article { url: landed.to_string(), markdown: text })
}

/// The same URL without its query string or fragment, or None when there was
/// nothing to strip.
fn without_query(url: &url::Url) -> Option<url::Url> {
    if url.query().is_none() && url.fragment().is_none() {
        return None;
    }
    let mut bare = url.clone();
    bare.set_query(None);
    bare.set_fragment(None);
    Some(bare)
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

/// Fetches one URL and returns the URL it actually landed on together with the
/// page's readable text.
async fn fetch_url(url: &str, selector: Option<&str>) -> Result<(url::Url, String), String> {
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

    // Redirects are followed, so the host check has to be repeated on whatever
    // the chain ended at — otherwise a wrapper could point back inside the machine.
    let landed = resp.url().clone();
    if landed.host_str().map(host_blocked).unwrap_or(true) {
        return Err("redirected to a private or loopback address".to_string());
    }
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
    let out = extract(&body, selector)?;
    Ok((landed, truncate_output(out)))
}

/// Tags that carry a page's readable content. `script`, `style` and `nav` are
/// not among them, so their text never reaches the digest.
const CONTENT_TAGS: &str = "p, h1, h2, h3, h4, h5, h6, li, blockquote, figcaption";

/// Reads a page as Markdown. This used to return one flat run of text, because
/// its only reader was a model that would restate it; now the result goes into
/// the digest as it stands, so the page's own structure — headings, lists,
/// quotes — has to survive the trip.
fn extract(html: &str, selector: Option<&str>) -> Result<String, String> {
    let doc = scraper::Html::parse_document(html);
    let content = scraper::Selector::parse(CONTENT_TAGS).expect("static selector");

    let picked: Vec<scraper::ElementRef> = match selector {
        Some(sel) => {
            let parsed = scraper::Selector::parse(sel)
                .map_err(|e| format!("invalid CSS selector '{sel}': {e:?}"))?;
            let roots: Vec<_> = doc.select(&parsed).collect();
            if roots.is_empty() {
                return Err(format!("no elements matched selector '{sel}'"));
            }
            let inner: Vec<_> = roots.iter().flat_map(|r| r.select(&content)).collect();
            // A selector can name the text-bearing element itself, in which
            // case there is nothing further inside it to pick out.
            if inner.is_empty() { roots } else { inner }
        }
        None => doc.select(&content).collect(),
    };

    // These tags nest — a `blockquote` holds `p`s, an `li` can hold anything —
    // and every level matches, so an element already covered by an ancestor
    // would otherwise have its text emitted twice.
    let chosen: std::collections::HashSet<_> = picked.iter().map(|el| el.id()).collect();
    let blocks: Vec<String> = picked
        .iter()
        .filter(|el| !el.ancestors().any(|a| chosen.contains(&a.id())))
        .filter_map(|el| as_markdown(*el))
        .collect();

    if !blocks.is_empty() {
        return Ok(join_blocks(&blocks));
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

/// One content element as a Markdown block, or None when it holds no text.
fn as_markdown(el: scraper::ElementRef) -> Option<String> {
    let text = normalize(&el.text().collect::<Vec<_>>().join(" "));
    if text.is_empty() {
        return None;
    }
    let name = el.value().name();
    Some(match name {
        "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
            // The entry already gives each article an `##` of its own, so the
            // page's own headings hang below that rather than competing with it.
            let depth = name[1..].parse::<usize>().unwrap_or(1);
            format!("{} {text}", "#".repeat((depth + 2).min(6)))
        }
        "li" => format!("- {text}"),
        "blockquote" => format!("> {text}"),
        _ => text,
    })
}

/// Joins blocks with the blank line Markdown needs between them — except
/// between consecutive list items, where a blank line would split one list
/// into several.
fn join_blocks(blocks: &[String]) -> String {
    let mut out = String::new();
    for (i, block) in blocks.iter().enumerate() {
        if i > 0 {
            let same_list = block.starts_with("- ") && blocks[i - 1].starts_with("- ");
            out.push_str(if same_list { "\n" } else { "\n\n" });
        }
        out.push_str(block);
    }
    out
}

fn normalize(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate_output(mut s: String) -> String {
    if s.chars().count() > MAX_ARTICLE_CHARS {
        s = s.chars().take(MAX_ARTICLE_CHARS).collect();
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
        let out = extract(PAGE, Some(".post-content")).unwrap();
        assert!(out.contains("First paragraph of the article."));
        assert!(out.contains("Second paragraph here."));
        assert!(!out.contains("sidebar"));
        assert!(!out.contains("noise")); // script text excluded
    }

    #[test]
    fn readable_text_skips_chrome_and_scripts() {
        let out = extract(PAGE, None).unwrap();
        assert!(out.contains("The Headline"));
        assert!(out.contains("First paragraph of the article."));
        assert!(!out.contains("noise")); // no <script> body
        assert!(!out.contains("color:red")); // no <style> body
    }

    #[test]
    fn missing_selector_errors() {
        assert!(extract(PAGE, Some(".does-not-exist")).is_err());
    }

    /// The scraped page goes into the digest as it stands, so its shape has to
    /// come back as Markdown the layout can read — and each piece of text has
    /// to appear exactly once, though these tags nest inside one another.
    #[test]
    fn scrapes_a_page_into_markdown() {
        let page = r#"<html><body><article>
            <h1>The Headline</h1>
            <p>Opening paragraph.</p>
            <h2>A Section</h2>
            <ul><li>First point</li><li>Second point</li></ul>
            <blockquote><p>A quoted line.</p></blockquote>
            <p>Closing paragraph.</p>
        </article></body></html>"#;

        let out = extract(page, None).unwrap();
        assert_eq!(
            out,
            "### The Headline\n\n\
             Opening paragraph.\n\n\
             #### A Section\n\n\
             - First point\n- Second point\n\n\
             > A quoted line.\n\n\
             Closing paragraph."
        );
        // The `p` inside the blockquote must not also stand on its own.
        assert_eq!(out.matches("A quoted line.").count(), 1);
    }

    /// A selector naming the text-bearing element itself still yields its text.
    #[test]
    fn selector_on_a_leaf_element_still_reads() {
        let page = r#"<html><body><p class="lede">Just the one line.</p></body></html>"#;
        assert_eq!(extract(page, Some(".lede")).unwrap(), "Just the one line.");
    }

    /// One section per link, headed by the newsletter's own title, carrying the
    /// resolved URL rather than the redirect wrapper — and a failed fetch says
    /// so rather than being dropped or filled in.
    #[test]
    fn assembles_an_entry_from_the_scrape() {
        let articles = vec![
            (
                LinkItem {
                    title: "The Greatness Of David Lean".into(),
                    url: "https://thebrowser.com/r/abc?m=1".into(),
                    note: "On Lawrence.".into(),
                },
                Ok(Article {
                    url: "https://example.com/lean".into(),
                    markdown: "### Lean\n\nHe made big films.".into(),
                }),
            ),
            (
                LinkItem {
                    title: "Rain Robbers".into(),
                    url: "https://thebrowser.com/r/def?m=1".into(),
                    note: String::new(),
                },
                Err("fetch failed: HTTP 403 Forbidden".into()),
            ),
        ];

        let out = assemble(&articles);
        assert_eq!(
            out,
            "## The Greatness Of David Lean\n\n\
             https://example.com/lean\n\n\
             > On Lawrence.\n\n\
             ### Lean\n\nHe made big films.\n\
             \n---\n\n\
             ## Rain Robbers\n\n\
             https://thebrowser.com/r/def?m=1\n\n\
             (content unavailable — fetch failed: HTTP 403 Forbidden)\n"
        );
    }

    /// The newsletter case this pipeline exists for: a redirect wrapper lands
    /// on the article with tracking parameters attached, and the bare URL is
    /// what actually serves the piece.
    #[test]
    fn strips_the_query_from_a_resolved_link() {
        let landed = url::Url::parse(
            "https://alexanderlarman.substack.com/p/the-greatness-of-david-lean?ref=thebrowser.com",
        )
        .unwrap();
        assert_eq!(
            without_query(&landed).unwrap().as_str(),
            "https://alexanderlarman.substack.com/p/the-greatness-of-david-lean"
        );

        let fragment = url::Url::parse("https://example.com/piece#section-2").unwrap();
        assert_eq!(without_query(&fragment).unwrap().as_str(), "https://example.com/piece");

        // Nothing to strip — don't spend a second request.
        assert!(without_query(&url::Url::parse("https://example.com/piece").unwrap()).is_none());
    }

    #[test]
    fn reads_back_the_structured_link_list() {
        let (items, selector) = parse_link_response(
            r#"{"items":[
                 {"title":"The Greatness of David Lean","url":"https://thebrowser.com/r/abc?m=1","note":"On Lawrence."},
                 {"title":"No link here","url":"","note":""},
                 {"title":" Padded ","url":" https://example.com/x ","note":" "}
               ],"selector":"article"}"#,
        )
        .unwrap();

        assert_eq!(items.len(), 2, "entries without a URL should be dropped");
        assert_eq!(items[0].url, "https://thebrowser.com/r/abc?m=1");
        assert_eq!(items[1].title, "Padded");
        assert_eq!(items[1].url, "https://example.com/x");
        assert_eq!(items[1].note, "");
        assert_eq!(selector.as_deref(), Some("article"));
    }

    #[test]
    fn empty_link_list_parses_to_no_items() {
        let (items, selector) = parse_link_response(r#"{"items":[],"selector":""}"#).unwrap();
        assert!(items.is_empty());
        assert!(selector.is_none(), "a blank selector means none, not Some(\"\")");
    }

    /// Structured outputs reject a schema whose objects allow extra properties
    /// or leave any property optional, so hold the schema to both rules.
    #[test]
    fn link_schema_meets_structured_output_rules() {
        fn check(node: &Value) {
            if node["type"] == "object" {
                assert_eq!(
                    node["additionalProperties"], false,
                    "every object needs additionalProperties: false — {node}"
                );
                let props: Vec<&String> = node["properties"]
                    .as_object()
                    .expect("object schema has properties")
                    .keys()
                    .collect();
                let required: Vec<String> = node["required"]
                    .as_array()
                    .expect("object schema has required")
                    .iter()
                    .map(|v| v.as_str().unwrap().to_string())
                    .collect();
                for p in props {
                    assert!(required.contains(p), "property {p} must be required");
                }
                for (_, child) in node["properties"].as_object().unwrap() {
                    check(child);
                }
            }
            if node["type"] == "array" {
                check(&node["items"]);
            }
        }
        check(&link_schema());
    }

    /// The link pass is supposed to copy URLs, not compose them; this is the
    /// check that says so in the log.
    #[test]
    fn spots_a_url_that_was_not_in_the_email() {
        let email = r#"<a href="https://thebrowser.com/r/abc?m=1&amp;utm=x">Read</a>"#;
        assert!(quoted_verbatim(email, "https://thebrowser.com/r/abc?m=1&amp;utm=x"));
        // Same link, entity-decoded the way a model tends to write it back.
        assert!(quoted_verbatim(email, "https://thebrowser.com/r/abc?m=1&utm=x"));
        assert!(!quoted_verbatim(email, "https://thebrowser.com/r/invented"));
    }

    #[test]
    fn tokens_per_sec_uses_generation_time_only() {
        let msg = StreamedMessage {
            output_tokens: 1000,
            first_token_secs: 1.0,
            total_secs: 11.0,
            ..StreamedMessage::default()
        };
        assert_eq!(msg.tokens_per_sec(), 100.0);

        // A call that returned everything at once must not divide by zero.
        let instant = StreamedMessage { output_tokens: 5, ..StreamedMessage::default() };
        assert!(instant.tokens_per_sec().is_finite());
    }

    #[test]
    fn folds_a_streamed_message_together() {
        let events = [
            r#"{"type":"message_start","message":{"usage":{"input_tokens":34329,"output_tokens":1}}}"#,
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#,
            r#"{"type":"ping"}"#,
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Ogham"}}"#,
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" and Hildegard"}}"#,
            r#"{"type":"content_block_stop","index":0}"#,
            r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":284}}"#,
            r#"{"type":"message_stop"}"#,
        ];

        let mut msg = StreamedMessage::default();
        for raw in events {
            apply_event(&serde_json::from_str(raw).unwrap(), &mut msg).unwrap();
        }

        assert_eq!(msg.text, "Ogham and Hildegard");
        assert_eq!(msg.stop_reason, "end_turn");
        assert_eq!(msg.input_tokens, 34329);
        assert_eq!(msg.output_tokens, 284);
    }

    #[test]
    fn streamed_error_events_surface() {
        let event: Value = serde_json::from_str(
            r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#,
        )
        .unwrap();
        let err = apply_event(&event, &mut StreamedMessage::default()).unwrap_err();
        assert!(err.contains("Overloaded"), "{err}");
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
