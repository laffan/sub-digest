//! The **saved list** input: an in-app browser, and what it brings back.
//!
//! A site's saved posts are behind its login, and no site publishes an API for
//! them. Rather than reverse-engineer a sign-in per site — which is a different
//! shape at every one, and breaks on two-factor, single sign-on and captchas —
//! the app opens the site in a browser of its own, framed by a modal. You sign
//! in the way you always sign in, navigate to the list you want, and press
//! **Use this page**. What that reads is the page in front of you, as rendered:
//! the links on it become the articles the digest is built from.
//!
//! That makes the input site-agnostic without a recipe. A source is a name and
//! an address to open, and anything with a page of links behind a login works —
//! the page decides what's there, and you decide when it's the right page.
//!
//! Two implementations of the same five operations, because a webview is
//! platform machinery:
//!
//! * **Desktop** — a Tauri child webview added to the main window
//!   (`Window::add_child`, the `unstable` multiwebview API), positioned over the
//!   modal's body and moved with it.
//! * **iPadOS** — a native `WKWebView` overlaid at the same rectangle by
//!   `tauri-plugin-saved-browser`, since child webviews are desktop-only.
//!
//! Both run the *same* harvest script — it's defined once here and handed to
//! whichever side is doing the work — and both hand back the same three things:
//! the page's address, the articles on it, and the session cookie. The cookie is
//! kept because a saved post is often subscriber-only: it rides along when the
//! article is on that site's own domain, and nowhere else.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

use crate::anthropic;
use crate::log;

/// The one browser. Only one is ever open, so it needs no more than a name.
const LABEL: &str = "saved-browser";
/// Ceiling on one capture, matching the script's own.
const MAX_ITEMS: usize = 500;
/// How long the harvest script is given to answer before the capture gives up.
const HARVEST_TIMEOUT_SECS: u64 = 20;

/// Reads the page in front of the user as a list of articles.
///
/// Everything it knows, it knows from the rendered document, which is the point:
/// a list that loads as you scroll has loaded by the time you press the button,
/// and a site that renders its list in JavaScript has already rendered it.
///
/// A link is an article when it has words on it and isn't page furniture. The
/// rest is what can be read off the card the link sits in — the date from a
/// `<time>`, a byline from a class that says so — and the card is found by
/// climbing until the thing above stops being one item.
const HARVEST_JS: &str = r##"
(function () {
  var MAX = 500;
  var CHROME = { NAV: 1, HEADER: 1, FOOTER: 1, ASIDE: 1, FORM: 1 };
  function furniture(el) {
    for (var n = el; n && n !== document.body; n = n.parentElement) {
      if (CHROME[n.tagName]) return true;
      if (n.getAttribute && n.getAttribute("aria-hidden") === "true") return true;
    }
    return false;
  }
  function clean(s) { return String(s || "").replace(/\s+/g, " ").trim(); }
  var here = location.href.split("#")[0];
  var seen = {};
  var out = [];
  var anchors = document.querySelectorAll("a[href]");
  for (var i = 0; i < anchors.length && out.length < MAX; i++) {
    var a = anchors[i];
    var href = String(a.href || "");
    if (!/^https?:/i.test(href)) continue;
    href = href.split("#")[0];
    if (href === here) continue;
    if (furniture(a)) continue;
    var title = clean(a.innerText || a.textContent);
    // A card usually wraps its picture and its headline in separate links to
    // the same place. The headline is the one with the words on it.
    if (title.length < 10) continue;
    if (seen[href] !== undefined) {
      var kept = out[seen[href]];
      if (title.length > kept.title.length) kept.title = title.slice(0, 300);
      continue;
    }
    // The card this link sits in: climb while the thing above is still one
    // item, so a date or a byline found in it belongs to this article.
    var card = a;
    while (card.parentElement && card.parentElement !== document.body) {
      var up = card.parentElement;
      if (up.querySelectorAll("a[href]").length > 3) break;
      card = up;
    }
    var when = 0;
    var t = card.querySelector("time[datetime]");
    if (t) {
      var parsed = Date.parse(t.getAttribute("datetime"));
      if (!isNaN(parsed)) when = parsed;
    }
    var author = "";
    var by = card.querySelector('[rel="author"], [class*="author"], [class*="byline"]');
    if (by) author = clean(by.innerText || by.textContent).slice(0, 120);
    seen[href] = out.length;
    out.push({ url: href, title: title.slice(0, 300), author: author, dateMs: when });
  }
  return JSON.stringify({ url: here, title: clean(document.title), items: out });
})()
"##;

// ---------------------------------------------------------------------------
// Stored sessions

/// The sites captured from, by domain, each with the `Cookie:` header its
/// capture left behind. The domain is the key because the site is what you
/// signed in to: a capture made on `substack.com` is the session that reads a
/// post on `acx.substack.com`, and nothing else needs to know which button was
/// pressed to get it. A site with no cookies is still an entry — a public list
/// needs no session, and it should still be a site you can go back to.
///
/// Values are never logged.
type Sites = HashMap<String, String>;

/// Loaded from disk on first use.
#[derive(Default)]
pub struct SavedState(Mutex<Option<Sites>>);

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("saved-sessions.json"))
}

fn sites(app: &AppHandle, state: &SavedState) -> Sites {
    let mut guard = state.0.lock().unwrap();
    if guard.is_none() {
        let loaded = store_path(app)
            .ok()
            .and_then(|p| std::fs::read(p).ok())
            .and_then(|bytes| serde_json::from_slice::<Sites>(&bytes).ok())
            .unwrap_or_default();
        *guard = Some(loaded);
    }
    guard.clone().unwrap_or_default()
}

fn put_site(app: &AppHandle, state: &SavedState, domain: &str, cookie: Option<String>) {
    let mut all = sites(app, state);
    match cookie {
        Some(c) => all.insert(domain.to_string(), c),
        None => all.remove(domain),
    };
    if let Ok(path) = store_path(app) {
        if let Ok(bytes) = serde_json::to_vec_pretty(&all) {
            let _ = std::fs::write(path, bytes);
        }
    }
    *state.0.lock().unwrap() = Some(all);
}

/// Whether a host is the site's domain, or under it.
fn host_matches(host: &str, domain: &str) -> bool {
    let host = host.trim_start_matches('.').to_ascii_lowercase();
    let domain = domain.trim_start_matches('.').to_ascii_lowercase();
    !domain.is_empty() && (host == domain || host.ends_with(&format!(".{domain}")))
}

/// The registrable-looking part of a URL's host, which is the domain a session
/// is kept for: `substack.com` from `acx.substack.com`, and from `www.` too.
fn session_domain(url: &url::Url) -> String {
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    let labels: Vec<&str> = host.split('.').collect();
    if labels.len() > 2 {
        labels[labels.len() - 2..].join(".")
    } else {
        host
    }
}

// ---------------------------------------------------------------------------
// What a capture brings back

/// One article on the page, ready to become a post in the digest.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedItem {
    /// Stable for one article, so the already-read marker recognises it again.
    pub id: String,
    pub title: String,
    pub url: String,
    pub author: String,
    pub publication: String,
    /// 0 when the page didn't date it.
    pub date_ms: i64,
}

/// What the app gets back from **Use this page**.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capture {
    /// The site it came from — the domain the session is kept under, and the
    /// name the site goes by in the picker from here on.
    pub domain: String,
    /// The address the list was read from, for the line that says where.
    pub page_url: String,
    pub page_title: String,
    pub items: Vec<SavedItem>,
}

/// The harvest script's own output, before the domain-level tidying below.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPage {
    #[serde(default)]
    url: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    items: Vec<RawItem>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawItem {
    #[serde(default)]
    url: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    author: String,
    #[serde(default)]
    date_ms: i64,
}

/// What to call a publication the page didn't name: the site the article is on.
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

/// Reads the script's answer, which arrives as a JSON string — and on some
/// platforms as a JSON string *of* a JSON string, since the runtime serializes
/// whatever the script evaluated to. One unwrap covers both.
fn parse_harvest(raw: &str) -> Result<RawPage, String> {
    // An empty answer is what a script that threw comes back as, since there's
    // no value to serialize. Saying so beats "expected value at line 1".
    if raw.trim().is_empty() {
        return Err("the page didn't answer — it may still be loading".to_string());
    }
    let value: serde_json::Value = serde_json::from_str(raw.trim())
        .map_err(|e| format!("the page's answer wasn't readable: {e}"))?;
    let value = match value {
        serde_json::Value::String(inner) => serde_json::from_str(&inner)
            .map_err(|e| format!("the page's answer wasn't readable: {e}"))?,
        other => other,
    };
    serde_json::from_value(value).map_err(|e| format!("unexpected answer from the page: {e}"))
}

/// Turns the script's answer into the articles the digest will be built from.
fn capture_from(page: RawPage, domain: String) -> Capture {
    let mut items = Vec::new();
    for raw in page.items.into_iter().take(MAX_ITEMS) {
        let Ok(url) = url::Url::parse(&raw.url) else {
            continue;
        };
        if !matches!(url.scheme(), "http" | "https") {
            continue;
        }
        items.push(SavedItem {
            id: format!("saved:{url}"),
            title: raw.title,
            author: raw.author,
            publication: publication_from_url(&url),
            date_ms: raw.date_ms,
            url: url.to_string(),
        });
    }
    Capture {
        domain,
        page_url: page.url,
        page_title: page.title,
        items,
    }
}

// ---------------------------------------------------------------------------
// The browser: desktop

/// A URL the app is willing to open or fetch: http(s), and not somewhere inside
/// this machine.
fn checked_url(raw: &str) -> Result<url::Url, String> {
    let parsed = url::Url::parse(raw.trim()).map_err(|e| format!("bad URL: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("only http(s) addresses can be opened".to_string());
    }
    if parsed.host_str().map(anthropic::host_blocked).unwrap_or(true) {
        return Err("refusing to open a private or loopback address".to_string());
    }
    Ok(parsed)
}

#[cfg(desktop)]
mod desktop {
    use super::*;
    use tauri::{LogicalPosition, LogicalSize};

    /// Rewrites popup-style link opening into same-webview navigation. A Tauri
    /// webview swallows `window.open`, and a site's own "open in new tab" links
    /// would otherwise do nothing at all inside the modal.
    const NEUTER_POPUPS: &str = r#"
(function () {
  var go = function (u) { try { if (u) window.location.href = String(u); } catch (e) {} };
  try { window.open = function (u) { go(u); return null; }; } catch (e) {}
  document.addEventListener("click", function (e) {
    var a = e.target && e.target.closest ? e.target.closest("a[target]") : null;
    if (a && a.href && a.getAttribute("target") === "_blank") {
      e.preventDefault();
      go(a.href);
    }
  }, true);
})();
"#;

    /// Where the HTML sits inside the window's own coordinate space.
    ///
    /// A child webview is placed relative to the window; the rectangle the modal
    /// reports comes from `getBoundingClientRect`, which is relative to the
    /// *page*. Those two agree only when the main webview starts at the window's
    /// origin — and it doesn't when the window has a full-size content view, as
    /// a Mac's does: the page begins below the title bar, so a rectangle taken
    /// from it lands that much too high and the browser is drawn over the
    /// modal's own header.
    ///
    /// So rather than assume either way, ask: the main webview's own position is
    /// the offset, measured through the same code path that will place the
    /// child. It's zero when the two spaces already agree, which makes this a
    /// correction where one is needed and nothing at all where it isn't. (The
    /// iPad half does the same thing with `hostWebView.frame.origin`.)
    fn viewport_offset(app: &AppHandle) -> (f64, f64) {
        let Some(main) = app.get_webview("main") else {
            return (0.0, 0.0);
        };
        let Ok(position) = main.position() else {
            return (0.0, 0.0);
        };
        let scale = app
            .get_window("main")
            .and_then(|w| w.scale_factor().ok())
            .unwrap_or(1.0);
        let scale = if scale > 0.0 { scale } else { 1.0 };
        (
            (position.x as f64 / scale).max(0.0),
            (position.y as f64 / scale).max(0.0),
        )
    }

    pub fn open(app: &AppHandle, url: url::Url, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
        close(app);
        let window = app
            .get_window("main")
            .ok_or("the main window has gone missing")?;
        let (dx, dy) = viewport_offset(app);
        if dx != 0.0 || dy != 0.0 {
            log::info(
                app,
                "saved",
                format!("Placing the browser at {}, {} (the page sits {dx}, {dy} inside the window)", x + dx, y + dy),
            );
        }
        let builder = tauri::webview::WebviewBuilder::new(LABEL, tauri::WebviewUrl::External(url))
            .initialization_script(NEUTER_POPUPS);
        window
            .add_child(
                builder,
                LogicalPosition::new(x + dx, y + dy),
                LogicalSize::new(w.max(50.0), h.max(50.0)),
            )
            .map_err(|e| format!("could not open the browser: {e}"))?;
        Ok(())
    }

    pub fn set_bounds(app: &AppHandle, x: f64, y: f64, w: f64, h: f64) {
        if let Some(webview) = app.get_webview(LABEL) {
            let (dx, dy) = viewport_offset(app);
            // One `set_bounds` rather than a position then a size: each of those
            // is a round trip that reads the current rectangle back and rewrites
            // it, so sending them separately puts the webview somewhere neither
            // call meant for as long as it takes the second to arrive.
            let _ = webview.set_bounds(tauri::Rect {
                position: LogicalPosition::new(x + dx, y + dy).into(),
                size: LogicalSize::new(w.max(50.0), h.max(50.0)).into(),
            });
        }
    }

    pub fn back(app: &AppHandle) {
        if let Some(webview) = app.get_webview(LABEL) {
            let _ = webview.eval("history.back()");
        }
    }

    pub fn close(app: &AppHandle) {
        if let Some(webview) = app.get_webview(LABEL) {
            let _ = webview.close();
        }
    }

    /// Runs the harvest script in the browser and reads the site's cookies for
    /// whatever page it's showing.
    pub async fn capture(app: &AppHandle) -> Result<(RawPage, url::Url, String), String> {
        let webview = app.get_webview(LABEL).ok_or("the browser isn't open")?;
        let page_url = webview
            .url()
            .map_err(|e| format!("could not read the page's address: {e}"))?;

        // `eval_with_callback` answers through a callback that may be called
        // more than once in principle, so the sender is taken the first time.
        let (tx, rx) = tokio::sync::oneshot::channel::<String>();
        let slot = std::sync::Arc::new(Mutex::new(Some(tx)));
        webview
            .eval_with_callback(HARVEST_JS, move |result| {
                if let Some(tx) = slot.lock().unwrap().take() {
                    let _ = tx.send(result);
                }
            })
            .map_err(|e| format!("could not read the page: {e}"))?;

        let raw = tokio::time::timeout(
            tokio::time::Duration::from_secs(HARVEST_TIMEOUT_SECS),
            rx,
        )
        .await
        .map_err(|_| "the page didn't answer in time".to_string())?
        .map_err(|_| "the browser closed before the page answered".to_string())?;

        // Cookies come from the runtime's own store rather than the document:
        // a session cookie is HttpOnly, so the page can't see it and neither
        // could the script above.
        let cookie = webview
            .cookies_for_url(page_url.clone())
            .map(|cookies| {
                cookies
                    .iter()
                    .map(|c| format!("{}={}", c.name(), c.value()))
                    .collect::<Vec<_>>()
                    .join("; ")
            })
            .unwrap_or_default();

        Ok((parse_harvest(&raw)?, page_url, cookie))
    }
}

// ---------------------------------------------------------------------------
// The browser: iPadOS

#[cfg(not(desktop))]
mod mobile {
    use super::*;
    use tauri_plugin_saved_browser::{BoundsArgs, OpenArgs, SavedBrowser};

    fn plugin(app: &AppHandle) -> State<'_, SavedBrowser<tauri::Wry>> {
        app.state::<SavedBrowser<tauri::Wry>>()
    }

    pub fn open(app: &AppHandle, url: url::Url, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
        plugin(app).open(OpenArgs { url: url.to_string(), x, y, w, h })
    }

    pub fn set_bounds(app: &AppHandle, x: f64, y: f64, w: f64, h: f64) {
        let _ = plugin(app).set_bounds(BoundsArgs { x, y, w, h });
    }

    pub fn back(app: &AppHandle) {
        let _ = plugin(app).back();
    }

    pub fn close(app: &AppHandle) {
        let _ = plugin(app).close();
    }

    /// The same script, run by the native webview, which hands back the page's
    /// answer and its cookies together — the cookie store is the webview's own,
    /// so an HttpOnly session cookie is readable there and only there.
    pub async fn capture(app: &AppHandle) -> Result<(RawPage, url::Url, String), String> {
        let answer = plugin(app).capture(HARVEST_JS)?;
        let page = parse_harvest(&answer.json)?;
        let url = checked_url(&page.url)?;
        Ok((page, url, answer.cookie))
    }
}

#[cfg(desktop)]
use desktop as browser;
#[cfg(not(desktop))]
use mobile as browser;

// ---------------------------------------------------------------------------
// Commands

/// Opens the in-app browser at `url`, covering the rectangle the modal reports.
#[tauri::command]
pub async fn saved_open(
    app: AppHandle,
    url: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    let target = checked_url(&url)?;
    log::info(&app, "saved", format!("Opening {target}"));
    browser::open(&app, target, x, y, w, h)
}

/// Keeps the browser glued to the modal's body as the window changes shape.
#[tauri::command]
pub async fn saved_bounds(app: AppHandle, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    browser::set_bounds(&app, x, y, w, h);
    Ok(())
}

#[tauri::command]
pub async fn saved_back(app: AppHandle) -> Result<(), String> {
    browser::back(&app);
    Ok(())
}

#[tauri::command]
pub async fn saved_close(app: AppHandle) -> Result<(), String> {
    browser::close(&app);
    Ok(())
}

/// **Use this page**: reads the list in front of the user, and keeps the site —
/// and the session that made it readable — for next time.
#[tauri::command]
pub async fn saved_capture(
    app: AppHandle,
    state: State<'_, SavedState>,
    // No site is named by the caller: which site this is, is whichever one the
    // browser ended up on. Signing in and navigating are the same act as
    // choosing, so there is nothing to pick beforehand.
) -> Result<Capture, String> {
    let (page, page_url, cookie) = browser::capture(&app).await?;
    let domain = session_domain(&page_url);
    if domain.is_empty() {
        return Err("that page isn't on a site the app can keep".to_string());
    }

    if cookie.is_empty() {
        // A public list needs no session, and a site already signed in to
        // shouldn't lose one because this capture happened to hand back nothing.
        let known = sites(&app, &state).get(&domain).cloned();
        if known.as_deref().unwrap_or("").is_empty() {
            log::warn(
                &app,
                "saved",
                format!("{domain} handed back no cookies — a subscriber-only article may not read"),
            );
        }
        put_site(&app, &state, &domain, Some(known.unwrap_or_default()));
    } else {
        let names: Vec<&str> = cookie
            .split(';')
            .filter_map(|pair| pair.trim().split('=').next())
            .filter(|name| !name.is_empty())
            .collect();
        log::info(
            &app,
            "saved",
            format!("Kept the session for {domain} ({})", names.join(", ")),
        );
        put_site(&app, &state, &domain, Some(cookie));
    }

    let capture = capture_from(page, domain);
    log::info(
        &app,
        "saved",
        format!(
            "Read {} article{} off {}",
            capture.items.len(),
            if capture.items.len() == 1 { "" } else { "s" },
            log::ellipsize(&capture.page_url, 120)
        ),
    );
    Ok(capture)
}

/// The sites captured from, so the picker offers what you've actually signed in
/// to rather than a list of addresses you once typed.
#[tauri::command]
pub fn saved_sites(app: AppHandle, state: State<'_, SavedState>) -> Vec<String> {
    let mut domains: Vec<String> = sites(&app, &state).into_keys().collect();
    domains.sort();
    domains
}

/// Forgets a site and its session. The browser's own cookies are not touched —
/// opening it again signs in the way the site expects.
#[tauri::command]
pub fn saved_forget(app: AppHandle, state: State<'_, SavedState>, domain: String) {
    put_site(&app, &state, &domain, None);
}

/// Fetches one saved article as Markdown — the same scrape the AI agent's link
/// roundups go through. The session rides along when the article is on a site
/// that has one, which is what gets a subscriber-only post back as the text
/// you're entitled to rather than a paywall notice.
#[tauri::command]
pub async fn saved_fetch(
    app: AppHandle,
    state: State<'_, SavedState>,
    url: String,
) -> Result<String, String> {
    let target = checked_url(&url)?;
    let host = target.host_str().unwrap_or("");
    // Whichever signed-in site covers this host, if any. An article on a site
    // you never signed in to is fetched as anyone would fetch it.
    let cookie = sites(&app, &state)
        .into_iter()
        .find(|(domain, cookie)| !cookie.is_empty() && host_matches(host, domain))
        .map(|(_, cookie)| cookie);
    let article = anthropic::fetch_article(&app, target.as_str(), None, cookie.as_deref()).await?;
    Ok(article.markdown)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cookies_only_go_to_their_own_domain() {
        assert!(host_matches("substack.com", "substack.com"));
        assert!(host_matches("acx.substack.com", "substack.com"));
        assert!(!host_matches("substack.com.evil.example", "substack.com"));
        assert!(!host_matches("notsubstack.com", "substack.com"));
        assert!(!host_matches("substack.com", ""));
    }

    /// A session is kept for the site, not for the page it was captured on —
    /// otherwise a capture made on `substack.com` wouldn't read a post on
    /// `acx.substack.com`, which is where every Substack post actually lives.
    #[test]
    fn a_session_belongs_to_the_site_rather_than_the_page() {
        let url = |s: &str| url::Url::parse(s).unwrap();
        assert_eq!(session_domain(&url("https://substack.com/saved")), "substack.com");
        assert_eq!(session_domain(&url("https://acx.substack.com/p/x")), "substack.com");
        assert_eq!(session_domain(&url("https://www.example.com/x")), "example.com");
        assert_eq!(session_domain(&url("https://example.com/x")), "example.com");
    }

    #[test]
    fn a_publication_falls_back_to_the_site_it_is_on() {
        let url = |s: &str| url::Url::parse(s).unwrap();
        assert_eq!(publication_from_url(&url("https://acx.substack.com/p/x")), "acx");
        assert_eq!(publication_from_url(&url("https://example.com/p/x")), "example.com");
        assert_eq!(publication_from_url(&url("https://www.example.com/p/x")), "example.com");
    }

    /// The runtime serializes whatever the script evaluated to, which on some
    /// platforms wraps the string the script returned in another one.
    #[test]
    fn the_pages_answer_is_read_however_the_runtime_wrapped_it() {
        let payload = r#"{"url":"https://x.example/saved","title":"Saved","items":[]}"#;
        let bare = parse_harvest(payload).expect("plain JSON should read");
        assert_eq!(bare.url, "https://x.example/saved");

        let wrapped = serde_json::to_string(payload).unwrap();
        let nested = parse_harvest(&wrapped).expect("a JSON string of JSON should read");
        assert_eq!(nested.title, "Saved");

        assert!(parse_harvest("not json at all").is_err());
        // A script that threw leaves nothing to serialize.
        assert!(parse_harvest("   ").is_err());
    }

    #[test]
    fn harvested_links_become_articles() {
        let page = RawPage {
            url: "https://substack.com/saved".into(),
            title: "Saved".into(),
            items: vec![
                RawItem {
                    url: "https://acx.substack.com/p/onions".into(),
                    title: "The Onion Problem".into(),
                    author: "Scott Alexander".into(),
                    date_ms: 1_784_449_800_000,
                },
                // Nothing readable lives behind these, so they're not articles.
                RawItem { url: "javascript:void(0)".into(), ..Default::default() },
                RawItem { url: "not a url".into(), ..Default::default() },
            ],
        };
        let capture = capture_from(page, "substack.com".to_string());
        assert_eq!(capture.items.len(), 1);
        let item = &capture.items[0];
        assert_eq!(item.id, "saved:https://acx.substack.com/p/onions");
        assert_eq!(item.publication, "acx");
        assert_eq!(item.author, "Scott Alexander");
        assert_eq!(item.date_ms, 1_784_449_800_000);
    }

    #[test]
    fn the_app_refuses_to_open_anything_but_a_public_web_page() {
        assert!(checked_url("https://substack.com/saved").is_ok());
        assert!(checked_url("file:///etc/passwd").is_err());
        assert!(checked_url("http://127.0.0.1:8788/").is_err());
        assert!(checked_url("http://localhost/").is_err());
        assert!(checked_url("nonsense").is_err());
    }
}
