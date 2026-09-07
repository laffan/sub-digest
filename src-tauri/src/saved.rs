//! The **saved list** input: sign in to a site, read one of its lists, and hand
//! back the articles on it.
//!
//! Nothing here knows what Substack is. A *source* is a recipe — a domain, how
//! you sign in to it, and one or more lists, each a URL and how to read what
//! comes back — and the app ships recipes rather than code per site. That's
//! what makes "log in, pick a list, collect the articles" work for the next
//! site as well as this one.
//!
//! Sign-in is HTTP, all of it, which is the whole reason it works the same on a
//! Mac and on an iPad: no second webview to open, no cookie jar to reach into.
//! Three ways in, in the order a person would try them:
//!
//! * **link** — paste the sign-in link a site mailed you. Following it is what
//!   sets the session cookie, so the app follows it itself and keeps what the
//!   redirect chain hands back.
//! * **password** — post an address and password to the site's own login
//!   endpoint.
//! * **cookie** — paste a session cookie straight in, for a site with neither.
//!
//! What's kept afterwards is the cookie, and it's treated as the password it
//! effectively is: stored beside the Gmail token in the app's data directory,
//! logged by name only, and sent to the source's own domain and nowhere else.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};
use tokio::time::Duration;

use crate::anthropic;
use crate::log;

/// Ceiling on one collection. A list years deep would otherwise be walked to
/// the bottom every time; past this the newest are what you get.
const MAX_ITEMS: usize = 500;
/// Redirect hops followed by hand during sign-in. A magic link goes through two
/// or three; ten is generous and still bounded.
const MAX_REDIRECTS: usize = 10;
const REQUEST_TIMEOUT_SECS: u64 = 45;
/// Sites serve their own web app to browsers and 403 anything that looks like a
/// script, so requests go out looking like the browser the session belongs to.
const BROWSER_UA: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) \
     Chrome/124.0 Safari/537.36";

// ---------------------------------------------------------------------------
// Stored sessions

/// One signed-in source: the cookies it handed back, and who they belong to.
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Session {
    /// The domain the cookies belong to; nothing is sent anywhere else.
    domain: String,
    /// Cookie name → value. Values are never logged.
    cookies: BTreeMap<String, String>,
    /// What to show as the signed-in account — a name, a handle, an address.
    account: String,
}

/// Every signed-in source, by source id. Loaded from disk on first use.
#[derive(Default)]
pub struct SavedState(Mutex<Option<HashMap<String, Session>>>);

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("saved-sessions.json"))
}

/// The stored sessions, reading them off disk the first time they're wanted.
fn sessions(app: &AppHandle, state: &SavedState) -> HashMap<String, Session> {
    let mut guard = state.0.lock().unwrap();
    if guard.is_none() {
        let loaded = store_path(app)
            .ok()
            .and_then(|p| std::fs::read(p).ok())
            .and_then(|bytes| serde_json::from_slice::<HashMap<String, Session>>(&bytes).ok())
            .unwrap_or_default();
        *guard = Some(loaded);
    }
    guard.clone().unwrap_or_default()
}

fn put_session(app: &AppHandle, state: &SavedState, id: &str, session: Option<Session>) {
    let mut all = sessions(app, state);
    match session {
        Some(s) => {
            all.insert(id.to_string(), s);
        }
        None => {
            all.remove(id);
        }
    }
    if let Ok(path) = store_path(app) {
        match serde_json::to_vec_pretty(&all) {
            Ok(bytes) => {
                let _ = std::fs::write(path, bytes);
            }
            Err(_) => { /* nothing worth failing a sign-in over */ }
        }
    }
    *state.0.lock().unwrap() = Some(all);
}

// ---------------------------------------------------------------------------
// Recipes, as the UI sends them

/// A site the app can collect a list from. Everything site-specific lives here
/// rather than in code, so another site is another recipe.
#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRecipe {
    pub id: String,
    #[serde(default)]
    pub name: String,
    /// Cookies are kept for this domain and its subdomains, and sent nowhere else.
    #[serde(default)]
    pub domain: String,
    /// The cookie a pasted bare value is assumed to be.
    #[serde(default)]
    pub cookie_name: String,
    /// Endpoint that mails a sign-in link, posted `{"email": …}`.
    #[serde(default)]
    pub link_request_url: String,
    /// Endpoint that takes an address and password, posted `{"email", "password"}`.
    #[serde(default)]
    pub password_url: String,
    /// A URL that answers "who am I" once the cookies are good.
    #[serde(default)]
    pub probe_url: String,
    /// Where in that answer the account's name is, most specific first.
    #[serde(default)]
    pub probe_fields: Vec<String>,
}

/// One list on a source — the thing you point the app at.
#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListRecipe {
    #[serde(default)]
    pub name: String,
    /// Tried in order until one answers with items. A site that renames an
    /// endpoint doesn't take the list with it.
    #[serde(default)]
    pub urls: Vec<String>,
    /// `json` for a list endpoint, `links` for a page of links.
    #[serde(default)]
    pub kind: String,
    /// Where the array of items is, e.g. `posts`. Blank means find it.
    #[serde(default)]
    pub items_path: String,
    /// `links` only: which anchors to take. Blank means every link on the page.
    #[serde(default)]
    pub link_selector: String,
}

/// One article on a list, ready to become a post in the digest.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedItem {
    /// Stable for one article, so the already-read marker recognises it again.
    pub id: String,
    pub title: String,
    pub url: String,
    pub author: String,
    pub publication: String,
    /// 0 when the list didn't date it.
    pub date_ms: i64,
}

// ---------------------------------------------------------------------------
// Cookies

/// Whether a host is the source's domain, or under it.
fn host_matches(host: &str, domain: &str) -> bool {
    let host = host.trim_start_matches('.').to_ascii_lowercase();
    let domain = domain.trim_start_matches('.').to_ascii_lowercase();
    !domain.is_empty() && (host == domain || host.ends_with(&format!(".{domain}")))
}

/// The `Cookie:` header for a jar, or None when it's empty.
fn cookie_header(jar: &BTreeMap<String, String>) -> Option<String> {
    if jar.is_empty() {
        return None;
    }
    Some(
        jar.iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join("; "),
    )
}

/// Folds a response's `set-cookie` headers into a jar. Only the `name=value`
/// pair matters here: the app is the browser, so path and expiry have nothing
/// to act on, and a cookie cleared by the server (an empty or deleted value) is
/// removed rather than kept as a dead entry.
fn take_cookies(headers: &reqwest::header::HeaderMap, jar: &mut BTreeMap<String, String>) {
    for value in headers.get_all(reqwest::header::SET_COOKIE) {
        let Ok(raw) = value.to_str() else { continue };
        let pair = raw.split(';').next().unwrap_or("").trim();
        let Some((name, value)) = pair.split_once('=') else {
            continue;
        };
        let (name, value) = (name.trim(), value.trim());
        if name.is_empty() {
            continue;
        }
        let cleared = value.is_empty()
            || value == "deleted"
            || raw.to_ascii_lowercase().contains("max-age=0");
        if cleared {
            jar.remove(name);
        } else {
            jar.insert(name.to_string(), value.to_string());
        }
    }
}

/// Reads a pasted cookie: a whole `Cookie:` line, one `name=value`, or a bare
/// value, which is assumed to be the source's own session cookie.
fn parse_pasted_cookie(raw: &str, default_name: &str) -> Result<BTreeMap<String, String>, String> {
    let text = raw
        .trim()
        .trim_start_matches("Cookie:")
        .trim_start_matches("cookie:")
        .trim();
    if text.is_empty() {
        return Err("paste the session cookie to sign in with".to_string());
    }
    let mut jar = BTreeMap::new();
    if text.contains('=') {
        for part in text.split(';') {
            if let Some((name, value)) = part.trim().split_once('=') {
                let (name, value) = (name.trim(), value.trim());
                if !name.is_empty() && !value.is_empty() {
                    jar.insert(name.to_string(), value.to_string());
                }
            }
        }
    } else {
        let name = if default_name.trim().is_empty() {
            "session"
        } else {
            default_name.trim()
        };
        jar.insert(name.to_string(), text.to_string());
    }
    if jar.is_empty() {
        return Err("that doesn't look like a cookie — expected name=value".to_string());
    }
    Ok(jar)
}

// ---------------------------------------------------------------------------
// Requests

/// Client for the sign-in dance. Redirects are followed by hand, because a
/// magic link sets its cookie somewhere in the middle of the chain and reqwest
/// would only hand back the last response.
fn no_redirect() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(20))
            .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
            .build()
            .expect("failed to build http client")
    })
}

/// A URL the app is willing to talk to: http(s), and not somewhere inside this
/// machine. The same rule the article scraper applies, for the same reason.
fn checked_url(raw: &str) -> Result<url::Url, String> {
    let parsed = url::Url::parse(raw.trim()).map_err(|e| format!("bad URL: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("only http(s) URLs can be used".to_string());
    }
    if parsed.host_str().map(anthropic::host_blocked).unwrap_or(true) {
        return Err("refusing to reach a private or loopback address".to_string());
    }
    Ok(parsed)
}

/// One request, with the jar sent and whatever it hands back folded in.
async fn request(
    method: reqwest::Method,
    url: &url::Url,
    body: Option<&Value>,
    jar: &mut BTreeMap<String, String>,
) -> Result<(reqwest::StatusCode, reqwest::header::HeaderMap, String), String> {
    let mut req = no_redirect()
        .request(method, url.clone())
        .header("user-agent", BROWSER_UA)
        .header("accept", "application/json, text/html;q=0.9, */*;q=0.8");
    if let Some(header) = cookie_header(jar) {
        req = req.header("cookie", header);
    }
    if let Some(json) = body {
        req = req.json(json);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("request failed: {}", anthropic::describe(&e)))?;
    let status = resp.status();
    let headers = resp.headers().clone();
    take_cookies(&headers, jar);
    let text = resp.text().await.unwrap_or_default();
    Ok((status, headers, text))
}

/// Follows a URL by hand, collecting the cookies every hop sets. This is the
/// magic-link flow: the token is spent by the request the app makes, and the
/// session it hands back is what gets kept.
async fn follow(
    app: &AppHandle,
    start: &url::Url,
    jar: &mut BTreeMap<String, String>,
) -> Result<(), String> {
    let mut next = start.clone();
    for hop in 0..MAX_REDIRECTS {
        let (status, headers, body) = request(reqwest::Method::GET, &next, None, jar).await?;
        if !status.is_redirection() {
            if status.is_success() {
                return Ok(());
            }
            return Err(format!("the site answered HTTP {status}: {}", first_line(&body)));
        }
        let location = headers
            .get(reqwest::header::LOCATION)
            .and_then(|v| v.to_str().ok())
            .ok_or("the site redirected without saying where")?;
        let resolved = next
            .join(location)
            .map_err(|e| format!("bad redirect target: {e}"))?;
        next = checked_url(resolved.as_str())?;
        log::info(
            app,
            "saved",
            format!("  → {} (hop {})", log::ellipsize(next.as_str(), 120), hop + 1),
        );
    }
    Err("the sign-in link redirected too many times".to_string())
}

/// The first useful line of an error body, for a message a person can act on.
fn first_line(body: &str) -> String {
    // A JSON error is far more use than the HTML page around it.
    if let Ok(value) = serde_json::from_str::<Value>(body) {
        for key in ["error", "message", "errors"] {
            if let Some(found) = value.get(key) {
                let text = match found {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                };
                if !text.is_empty() {
                    return log::ellipsize(&text, 200);
                }
            }
        }
    }
    log::ellipsize(body.trim(), 200)
}

// ---------------------------------------------------------------------------
// Reading a list

/// Walks a dotted path, where a numeric segment indexes an array:
/// `publishedBylines.0.name`.
fn dig<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    let mut at = value;
    for segment in path.split('.') {
        if segment.is_empty() {
            continue;
        }
        at = match segment.parse::<usize>() {
            Ok(index) => at.get(index)?,
            Err(_) => at.get(segment)?,
        };
    }
    Some(at)
}

/// The first of `keys` this item carries — looked for on the item itself, then
/// one level down. List endpoints nest the thing you want as often as not
/// (`{post: {title}}`, `{item: {…}}`), and which of the two a site does isn't
/// worth a line of configuration.
fn field<'a>(item: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    for key in keys {
        if let Some(found) = dig(item, key) {
            if !found.is_null() {
                return Some(found);
            }
        }
    }
    for (_, nested) in item.as_object()?.iter() {
        if nested.is_object() {
            for key in keys {
                if let Some(found) = dig(nested, key) {
                    if !found.is_null() {
                        return Some(found);
                    }
                }
            }
        }
    }
    None
}

fn text_field(item: &Value, keys: &[&str]) -> String {
    match field(item, keys) {
        Some(Value::String(s)) => s.trim().to_string(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

const TITLE_KEYS: &[&str] = &["title", "post.title", "name", "headline", "subject"];
const URL_KEYS: &[&str] = &[
    "canonical_url",
    "canonicalUrl",
    "url",
    "link",
    "permalink",
    "web_url",
    "post.canonical_url",
];
const AUTHOR_KEYS: &[&str] = &[
    "publishedBylines.0.name",
    "published_bylines.0.name",
    "author.name",
    "author",
    "byline",
    "creator",
    "user.name",
];
const PUBLICATION_KEYS: &[&str] = &[
    "publication.name",
    "pub.name",
    "publication_name",
    "site.name",
    "source",
    "feed.title",
];
const DATE_KEYS: &[&str] = &[
    "post_date",
    "published_at",
    "publishedAt",
    "date",
    "created_at",
    "createdAt",
    "timestamp",
    "saved_at",
    "savedAt",
];

/// Days from 1970-01-01 to a civil date (Howard Hinnant's algorithm), which is
/// all that stands between an ISO timestamp and epoch millis. Bringing in a
/// date library for one function isn't worth the dependency.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Epoch millis from what a list endpoint calls a date: an ISO 8601 timestamp,
/// or a number of seconds or milliseconds. 0 when it isn't a date at all.
fn parse_date(value: Option<&Value>) -> i64 {
    let Some(value) = value else { return 0 };
    if let Some(n) = value.as_i64() {
        // Seconds until they'd be a date past the year 2286, then milliseconds.
        return if n.abs() < 100_000_000_000 { n * 1000 } else { n };
    }
    let Some(text) = value.as_str() else { return 0 };
    let text = text.trim();
    if let Ok(n) = text.parse::<i64>() {
        return parse_date(Some(&Value::from(n)));
    }
    if text.len() < 10 {
        return 0;
    }
    let num = |from: usize, to: usize| -> Option<i64> {
        text.get(from..to).and_then(|s| s.parse::<i64>().ok())
    };
    let (Some(y), Some(mo), Some(d)) = (num(0, 4), num(5, 7), num(8, 10)) else {
        return 0;
    };
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
        return 0;
    }
    let (h, mi, s) = (
        num(11, 13).unwrap_or(0),
        num(14, 16).unwrap_or(0),
        num(17, 19).unwrap_or(0),
    );
    let seconds = days_from_civil(y, mo, d) * 86_400 + h * 3600 + mi * 60 + s;
    seconds * 1000
}

/// What to call a publication the list didn't name: the site the article is on.
/// `foo.substack.com` is the publication `foo`; anything else is its host.
fn publication_from_url(url: &url::Url) -> String {
    let host = url.host_str().unwrap_or("").trim_start_matches("www.");
    match host.split_once('.') {
        Some((label, rest)) if rest.matches('.').count() >= 1 && !label.is_empty() => {
            label.to_string()
        }
        _ => host.to_string(),
    }
}

/// The array of items in a list response. Named when the recipe names it,
/// found otherwise: the longest array of objects within a few levels, which is
/// what a list endpoint's payload is under whatever key this site chose.
fn find_items(value: &Value, path: &str) -> Option<Vec<Value>> {
    if !path.trim().is_empty() {
        return dig(value, path.trim())
            .and_then(|v| v.as_array())
            .map(|a| a.to_vec());
    }
    fn walk(value: &Value, depth: usize, best: &mut Option<Vec<Value>>) {
        if depth > 3 {
            return;
        }
        if let Some(array) = value.as_array() {
            if array.first().map(|v| v.is_object()).unwrap_or(false)
                && best.as_ref().map(|b| array.len() > b.len()).unwrap_or(true)
            {
                *best = Some(array.to_vec());
            }
        }
        match value {
            Value::Object(map) => {
                for (_, nested) in map {
                    walk(nested, depth + 1, best);
                }
            }
            Value::Array(items) => {
                for nested in items.iter().take(5) {
                    walk(nested, depth + 1, best);
                }
            }
            _ => {}
        }
    }
    let mut best = None;
    walk(value, 0, &mut best);
    best
}

/// Turns one JSON item into an article, or nothing when it carries no address —
/// a list endpoint returns rows of every kind, and only the ones pointing at
/// something readable are of any use here.
fn item_from_json(item: &Value, base: &url::Url) -> Option<SavedItem> {
    let raw = text_field(item, URL_KEYS);
    if raw.trim().is_empty() {
        return None;
    }
    let url = base.join(raw.trim()).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    let title = text_field(item, TITLE_KEYS);
    let publication = {
        let named = text_field(item, PUBLICATION_KEYS);
        if named.is_empty() {
            publication_from_url(&url)
        } else {
            named
        }
    };
    Some(SavedItem {
        id: format!("saved:{url}"),
        title: if title.is_empty() {
            url.path().trim_matches('/').replace(['-', '_'], " ")
        } else {
            title
        },
        author: text_field(item, AUTHOR_KEYS),
        publication,
        date_ms: parse_date(field(item, DATE_KEYS)),
        url: url.to_string(),
    })
}

/// A page of links as a list: every anchor the selector matches, its text as
/// the title. It's the fallback shape for a site with no list endpoint — and
/// the one a person can point at anything, since a selector is all it takes.
fn items_from_links(html: &str, selector: &str, base: &url::Url) -> Result<Vec<SavedItem>, String> {
    let doc = scraper::Html::parse_document(html);
    let selector = anchor_selector(selector);
    let parsed = scraper::Selector::parse(&selector)
        .map_err(|_| format!("that isn't a CSS selector: {selector}"))?;

    let mut out: Vec<SavedItem> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for anchor in doc.select(&parsed) {
        let Some(href) = anchor.value().attr("href") else {
            continue;
        };
        let Ok(url) = base.join(href.trim()) else {
            continue;
        };
        if !matches!(url.scheme(), "http" | "https") {
            continue;
        }
        let mut url = url;
        url.set_fragment(None);
        if !seen.insert(url.to_string()) {
            continue;
        }
        let text = anchor.text().collect::<String>();
        let title = text.split_whitespace().collect::<Vec<_>>().join(" ");
        let title = if title.is_empty() {
            anchor.value().attr("title").unwrap_or("").trim().to_string()
        } else {
            title
        };
        // A bare navigation link ("Home", "Next") isn't an article; the ones
        // worth collecting carry a headline.
        if title.chars().count() < 8 {
            continue;
        }
        out.push(SavedItem {
            id: format!("saved:{url}"),
            title,
            author: String::new(),
            publication: publication_from_url(&url),
            date_ms: 0,
            url: url.to_string(),
        });
    }
    Ok(out)
}

/// What to select for a page of links. A container is the useful thing to write
/// — "the list is in `ul.saved`" — so anything that doesn't already name anchors
/// is read as one, and the links inside it are what's taken. The *last* simple
/// selector decides, so `div.a-column` is a container and `a.post-link` isn't.
fn anchor_selector(raw: &str) -> String {
    let sel = raw.trim();
    if sel.is_empty() {
        return "a[href]".to_string();
    }
    let last = sel
        .rsplit([' ', '>', '+', '~'])
        .find(|part| !part.is_empty())
        .unwrap_or("");
    let names_anchors = last == "a"
        || last.starts_with("a.")
        || last.starts_with("a#")
        || last.starts_with("a[")
        || last.starts_with("a:");
    if names_anchors {
        sel.to_string()
    } else {
        format!("{sel} a[href]")
    }
}

/// Sets a list URL's `limit` to what the app actually wants, when it has one.
/// A list endpoint's default page is usually twenty; asking for the number the
/// user asked for beats paging blind.
fn with_limit(url: &url::Url, limit: usize) -> url::Url {
    if !url.query_pairs().any(|(k, _)| k == "limit") {
        return url.clone();
    }
    let pairs: Vec<(String, String)> = url
        .query_pairs()
        .map(|(k, v)| {
            if k == "limit" {
                (k.into_owned(), limit.to_string())
            } else {
                (k.into_owned(), v.into_owned())
            }
        })
        .collect();
    let mut out = url.clone();
    out.query_pairs_mut().clear().extend_pairs(pairs);
    out
}

// ---------------------------------------------------------------------------
// Commands

/// Asks a site to mail a sign-in link. The app never sees the link — the user
/// pastes it back — so all this does is start the flow from inside the app
/// rather than making them go and find the site's own sign-in page.
#[tauri::command]
pub async fn saved_request_link(
    app: AppHandle,
    source: SourceRecipe,
    email: String,
) -> Result<String, String> {
    let email = email.trim().to_string();
    if email.is_empty() {
        return Err("enter the address the account is under".to_string());
    }
    if source.link_request_url.trim().is_empty() {
        return Err(format!("{} has no sign-in-link endpoint set", source.name));
    }
    let url = checked_url(&source.link_request_url)?;
    let mut jar = BTreeMap::new();
    log::info(
        &app,
        "saved",
        format!("Asking {} to mail a sign-in link to {email}", source.name),
    );
    let (status, _, body) = request(
        reqwest::Method::POST,
        &url,
        Some(&serde_json::json!({ "email": email, "redirect": "/" })),
        &mut jar,
    )
    .await?;
    if !status.is_success() {
        return Err(format!(
            "{} refused to send a link (HTTP {status}): {}",
            source.name,
            first_line(&body)
        ));
    }
    Ok(format!(
        "Sent. Open the mail from {}, copy the sign-in link without tapping it, and paste it here.",
        source.name
    ))
}

/// Signs in to a source and keeps the session. Returns the account it landed on.
#[tauri::command]
pub async fn saved_sign_in(
    app: AppHandle,
    state: State<'_, SavedState>,
    source: SourceRecipe,
    method: String,
    email: String,
    password: String,
    link: String,
    cookie: String,
) -> Result<String, String> {
    if source.domain.trim().is_empty() {
        return Err("this source has no domain set".to_string());
    }
    let mut jar: BTreeMap<String, String> = BTreeMap::new();

    match method.as_str() {
        "link" => {
            let url = checked_url(&link)?;
            if !url.host_str().map(|h| host_matches(h, &source.domain)).unwrap_or(false) {
                return Err(format!(
                    "that link isn't on {} — paste the one {} mailed you",
                    source.domain, source.name
                ));
            }
            log::info(
                &app,
                "saved",
                format!("Following the sign-in link on {}", url.host_str().unwrap_or("")),
            );
            follow(&app, &url, &mut jar).await?;
        }
        "password" => {
            if source.password_url.trim().is_empty() {
                return Err(format!("{} has no password sign-in endpoint set", source.name));
            }
            if email.trim().is_empty() || password.is_empty() {
                return Err("enter both an address and a password".to_string());
            }
            let url = checked_url(&source.password_url)?;
            log::info(
                &app,
                "saved",
                format!("Signing in to {} as {}", source.name, email.trim()),
            );
            let (status, _, body) = request(
                reqwest::Method::POST,
                &url,
                Some(&serde_json::json!({
                    "email": email.trim(),
                    "password": password,
                    "captcha_response": "",
                    "redirect": "/",
                })),
                &mut jar,
            )
            .await?;
            if !status.is_success() {
                return Err(format!(
                    "{} rejected the sign-in (HTTP {status}): {}",
                    source.name,
                    first_line(&body)
                ));
            }
        }
        "cookie" => {
            jar = parse_pasted_cookie(&cookie, &source.cookie_name)?;
            log::info(
                &app,
                "saved",
                format!(
                    "Using a pasted session cookie for {} ({})",
                    source.name,
                    jar.keys().cloned().collect::<Vec<_>>().join(", ")
                ),
            );
        }
        other => return Err(format!("unknown sign-in method: {other}")),
    }

    if jar.is_empty() {
        return Err(format!(
            "{} didn't hand back a session. If the link had already been opened \
             elsewhere it's spent — ask for a new one.",
            source.name
        ));
    }
    log::info(
        &app,
        "saved",
        format!(
            "{} set {} cookie(s): {}",
            source.name,
            jar.len(),
            jar.keys().cloned().collect::<Vec<_>>().join(", ")
        ),
    );

    let account = verify(&app, &source, &mut jar).await?;
    put_session(
        &app,
        &state,
        &source.id,
        Some(Session {
            domain: source.domain.trim().to_string(),
            cookies: jar,
            account: account.clone(),
        }),
    );
    log::info(&app, "saved", format!("Signed in to {} as {account}", source.name));
    Ok(account)
}

/// Checks the session against the source's own "who am I" URL, and reads the
/// account's name out of the answer. A source with no probe is taken on trust
/// until a list is asked for.
async fn verify(
    app: &AppHandle,
    source: &SourceRecipe,
    jar: &mut BTreeMap<String, String>,
) -> Result<String, String> {
    let probe = source.probe_url.trim();
    if probe.is_empty() {
        log::info(
            app,
            "saved",
            format!("{} has no address to check a session against — taking it on trust", source.name),
        );
        return Ok(source.name.clone());
    }
    let url = checked_url(probe)?;
    log::info(
        app,
        "saved",
        format!("Checking the session against {}", log::ellipsize(url.as_str(), 120)),
    );
    let (status, _, body) = request(reqwest::Method::GET, &url, None, jar).await?;
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(format!(
            "{} didn't accept that session (HTTP {status}). Sign in again.",
            source.name
        ));
    }
    if !status.is_success() {
        return Err(format!(
            "{} answered HTTP {status} when asked who's signed in: {}",
            source.name,
            first_line(&body)
        ));
    }
    let value: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    let keys: Vec<&str> = source.probe_fields.iter().map(|s| s.as_str()).collect();
    let name = if keys.is_empty() {
        String::new()
    } else {
        text_field(&value, &keys)
    };
    Ok(if name.is_empty() { source.name.clone() } else { name })
}

/// The account a source is signed in as, or None. Cheap — it reads what's
/// stored rather than going back to the site on every render.
#[tauri::command]
pub fn saved_status(
    app: AppHandle,
    state: State<'_, SavedState>,
    source_id: String,
) -> Option<String> {
    sessions(&app, &state).get(&source_id).map(|s| s.account.clone())
}

#[tauri::command]
pub fn saved_sign_out(app: AppHandle, state: State<'_, SavedState>, source_id: String) {
    put_session(&app, &state, &source_id, None);
}

/// Collects one list: the articles on it, newest first, within the session's
/// date window.
#[tauri::command]
pub async fn saved_collect(
    app: AppHandle,
    state: State<'_, SavedState>,
    source: SourceRecipe,
    list: ListRecipe,
    limit: usize,
    after_ms: i64,
    before_ms: i64,
) -> Result<Vec<SavedItem>, String> {
    let mut session = sessions(&app, &state)
        .get(&source.id)
        .cloned()
        .ok_or_else(|| format!("not signed in to {}", source.name))?;
    let limit = limit.clamp(1, MAX_ITEMS);
    let candidates: Vec<String> = list.urls.iter().filter(|u| !u.trim().is_empty()).cloned().collect();
    if candidates.is_empty() {
        return Err(format!("\"{}\" has no address to read", list.name));
    }

    let mut last_error = String::new();
    for candidate in &candidates {
        let url = match checked_url(candidate) {
            Ok(u) => with_limit(&u, limit),
            Err(e) => {
                last_error = e;
                continue;
            }
        };
        if !url.host_str().map(|h| host_matches(h, &session.domain)).unwrap_or(false) {
            last_error = format!("{url} isn't on {} — the session doesn't cover it", session.domain);
            continue;
        }
        log::info(
            &app,
            "saved",
            format!("{} → GET {}", list.name, log::ellipsize(url.as_str(), 140)),
        );
        let mut jar = session.cookies.clone();
        let (status, _, body) = request(reqwest::Method::GET, &url, None, &mut jar).await?;
        // A site that rotates its session cookie hands the new one back here,
        // and the stored one is dead the moment it does.
        if jar != session.cookies {
            log::info(&app, "saved", format!("{} rotated its session; keeping the new one", source.name));
            session.cookies = jar.clone();
            put_session(&app, &state, &source.id, Some(session.clone()));
        }
        if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
            return Err(format!(
                "{} wouldn't hand over \"{}\" (HTTP {status}) — the session has expired. Sign in again.",
                source.name, list.name
            ));
        }
        if !status.is_success() {
            last_error = format!("HTTP {status} from {url}: {}", first_line(&body));
            log::warn(&app, "saved", format!("  {last_error}"));
            continue;
        }

        let items = if list.kind == "links" {
            items_from_links(&body, &list.link_selector, &url)?
        } else {
            match serde_json::from_str::<Value>(&body) {
                Ok(value) => {
                    let Some(rows) = find_items(&value, &list.items_path) else {
                        last_error = format!("nothing that looks like a list of items came back from {url}");
                        log::warn(&app, "saved", format!("  {last_error}"));
                        continue;
                    };
                    log::info(&app, "saved", format!("  {} row(s) in the response", rows.len()));
                    rows.iter().filter_map(|row| item_from_json(row, &url)).collect()
                }
                Err(e) => {
                    last_error = format!("{url} didn't answer with JSON ({e})");
                    log::warn(&app, "saved", format!("  {last_error}"));
                    continue;
                }
            }
        };

        if items.is_empty() {
            last_error = format!("no articles on \"{}\" at {url}", list.name);
            log::warn(&app, "saved", format!("  {last_error}"));
            continue;
        }

        // A list keeps everything it was ever given, so the window is what the
        // user asked for; an item the list didn't date can't be excluded by one.
        let mut kept: Vec<SavedItem> = items
            .into_iter()
            .filter(|item| {
                item.date_ms == 0
                    || ((after_ms <= 0 || item.date_ms >= after_ms)
                        && (before_ms <= 0 || item.date_ms < before_ms))
            })
            .collect();
        kept.sort_by_key(|i| -i.date_ms);
        kept.truncate(limit);
        log::info(
            &app,
            "saved",
            format!(
                "{}: {} article{} collected",
                list.name,
                kept.len(),
                if kept.len() == 1 { "" } else { "s" }
            ),
        );
        return Ok(kept);
    }

    Err(if last_error.is_empty() {
        format!("could not read \"{}\"", list.name)
    } else {
        format!("could not read \"{}\": {last_error}", list.name)
    })
}

/// Fetches one saved article and returns it as Markdown — the same scrape the
/// AI agent's link roundups go through, so a saved post and a linked one arrive
/// as the same kind of thing. The session cookie rides along when the article
/// is on the source's own domain, which is what gets a subscriber-only post
/// back as the text you're entitled to rather than a paywall notice.
#[tauri::command]
pub async fn saved_fetch(
    app: AppHandle,
    state: State<'_, SavedState>,
    source_id: String,
    url: String,
) -> Result<String, String> {
    let target = checked_url(&url)?;
    let host = target.host_str().unwrap_or("");
    let cookie = sessions(&app, &state)
        .get(&source_id)
        .filter(|s| host_matches(host, &s.domain))
        .and_then(|s| cookie_header(&s.cookies));
    let article = anthropic::fetch_article(&app, target.as_str(), None, cookie.as_deref()).await?;
    Ok(article.markdown)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn base() -> url::Url {
        url::Url::parse("https://substack.com/api/v1/inbox/top").unwrap()
    }

    #[test]
    fn cookies_only_go_to_their_own_domain() {
        assert!(host_matches("substack.com", "substack.com"));
        assert!(host_matches("acx.substack.com", "substack.com"));
        assert!(!host_matches("substack.com.evil.example", "substack.com"));
        assert!(!host_matches("notsubstack.com", "substack.com"));
        assert!(!host_matches("substack.com", ""));
    }

    #[test]
    fn a_cleared_cookie_is_removed_rather_than_kept() {
        let mut jar = BTreeMap::new();
        let mut headers = reqwest::header::HeaderMap::new();
        headers.append(
            reqwest::header::SET_COOKIE,
            "connect.sid=abc123; Path=/; HttpOnly".parse().unwrap(),
        );
        headers.append(
            reqwest::header::SET_COOKIE,
            "stale=x; Path=/; Max-Age=0".parse().unwrap(),
        );
        take_cookies(&headers, &mut jar);
        assert_eq!(jar.get("connect.sid").map(String::as_str), Some("abc123"));
        assert!(!jar.contains_key("stale"));
    }

    #[test]
    fn a_pasted_cookie_is_read_however_it_was_copied() {
        let whole = parse_pasted_cookie("Cookie: connect.sid=a; substack.sid=b", "connect.sid").unwrap();
        assert_eq!(whole.len(), 2);
        assert_eq!(whole["substack.sid"], "b");

        let bare = parse_pasted_cookie("  s%3Aabc.def  ", "connect.sid").unwrap();
        assert_eq!(bare["connect.sid"], "s%3Aabc.def");

        assert!(parse_pasted_cookie("   ", "connect.sid").is_err());
    }

    /// The list's array is found wherever the site chose to put it.
    #[test]
    fn the_items_array_is_found_without_being_named() {
        let payload = json!({
            "meta": { "cursor": "x" },
            "posts": [{ "title": "One" }, { "title": "Two" }],
        });
        let rows = find_items(&payload, "").expect("should have found the posts");
        assert_eq!(rows.len(), 2);
        // …and a named path wins over the search.
        let named = find_items(&json!({"a": [{"x": 1}], "b": [{"y": 1}, {"y": 2}]}), "a").unwrap();
        assert_eq!(named.len(), 1);
    }

    #[test]
    fn a_json_row_becomes_an_article() {
        let row = json!({
            "id": 42,
            "title": "The Onion Problem",
            "canonical_url": "https://acx.substack.com/p/onions",
            "post_date": "2026-07-19T08:30:00.000Z",
            "publishedBylines": [{ "name": "Scott Alexander" }],
            "publication": { "name": "Astral Codex Ten" },
        });
        let item = item_from_json(&row, &base()).expect("row should have become an item");
        assert_eq!(item.title, "The Onion Problem");
        assert_eq!(item.author, "Scott Alexander");
        assert_eq!(item.publication, "Astral Codex Ten");
        assert_eq!(item.url, "https://acx.substack.com/p/onions");
        // 2026-07-19T08:30:00Z
        assert_eq!(item.date_ms, 1_784_449_800_000);
    }

    /// List endpoints nest the post as often as not; which one a site does
    /// isn't worth a line of configuration.
    #[test]
    fn a_nested_post_is_read_the_same_as_a_flat_one() {
        let row = json!({
            "type": "saved",
            "post": {
                "title": "Nested",
                "canonical_url": "https://example.com/p/nested",
                "post_date": "2026-01-02"
            }
        });
        let item = item_from_json(&row, &base()).expect("nested row should have become an item");
        assert_eq!(item.title, "Nested");
        assert_eq!(item.url, "https://example.com/p/nested");
        assert_eq!(item.publication, "example.com");
    }

    #[test]
    fn a_row_with_no_address_is_not_an_article() {
        assert!(item_from_json(&json!({ "title": "No link here" }), &base()).is_none());
    }

    #[test]
    fn dates_arrive_as_seconds_millis_or_iso() {
        assert_eq!(parse_date(Some(&json!(1_784_449_800))), 1_784_449_800_000);
        assert_eq!(parse_date(Some(&json!(1_784_449_800_000i64))), 1_784_449_800_000);
        assert_eq!(parse_date(Some(&json!("2026-07-19T08:30:00Z"))), 1_784_449_800_000);
        assert_eq!(parse_date(Some(&json!("2026-07-19"))), 1_784_419_200_000);
        assert_eq!(parse_date(Some(&json!("last tuesday"))), 0);
        assert_eq!(parse_date(None), 0);
    }

    #[test]
    fn a_page_of_links_becomes_a_list() {
        let html = r#"<html><body>
            <nav><a href="/">Home</a></nav>
            <ul class="saved">
              <li><a href="/p/the-long-way-round">The Long Way Round</a></li>
              <li><a href="https://other.example/p/elsewhere">Something Else Entirely</a></li>
              <li><a href="/p/the-long-way-round">The Long Way Round</a></li>
              <li><a href="mailto:someone@example.com">Write to someone about this</a></li>
            </ul></body></html>"#;
        let items = items_from_links(html, "ul.saved", &url::Url::parse("https://x.example/saved").unwrap())
            .expect("selector should have parsed");
        // "Home" is too short to be a headline; the duplicate and the mailto go.
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].url, "https://x.example/p/the-long-way-round");
        assert_eq!(items[1].publication, "other.example");
    }

    /// A container is what a person writes; naming anchors is what a person
    /// writes when they mean anchors. Telling them apart is the last selector.
    #[test]
    fn a_container_selector_takes_the_links_inside_it() {
        assert_eq!(anchor_selector(""), "a[href]");
        assert_eq!(anchor_selector("ul.saved"), "ul.saved a[href]");
        assert_eq!(anchor_selector("div.a-column"), "div.a-column a[href]");
        assert_eq!(anchor_selector("a.post-link"), "a.post-link");
        assert_eq!(anchor_selector(".saved > a"), ".saved > a");
        assert_eq!(anchor_selector("a[href]"), "a[href]");
    }

    #[test]
    fn the_limit_replaces_the_one_already_on_the_url() {
        let url = url::Url::parse("https://substack.com/api/v1/inbox/top?surface=inbox_saved&limit=20").unwrap();
        assert_eq!(
            with_limit(&url, 100).as_str(),
            "https://substack.com/api/v1/inbox/top?surface=inbox_saved&limit=100"
        );
        // A URL with no limit is left exactly as it was written.
        let plain = url::Url::parse("https://example.com/saved").unwrap();
        assert_eq!(with_limit(&plain, 100).as_str(), plain.as_str());
    }

    #[test]
    fn a_publication_falls_back_to_the_site_it_is_on() {
        let sub = url::Url::parse("https://acx.substack.com/p/x").unwrap();
        assert_eq!(publication_from_url(&sub), "acx");
        let plain = url::Url::parse("https://example.com/p/x").unwrap();
        assert_eq!(publication_from_url(&plain), "example.com");
        let www = url::Url::parse("https://www.example.com/p/x").unwrap();
        assert_eq!(publication_from_url(&www), "example.com");
    }
}
