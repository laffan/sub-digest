//! Gmail API access: token storage/refresh and the commands the UI calls.

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use futures::{stream, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::{oneshot, Notify};
use tokio::time::{timeout, Duration};

use crate::oauth;

const GMAIL: &str = "https://gmail.googleapis.com/gmail/v1/users/me";
const MAX_MESSAGES: usize = 1000;
const METADATA_CONCURRENCY: usize = 8;
const MAX_IMAGE_BYTES: usize = 15 * 1024 * 1024;
const CONNECT_TIMEOUT_SECS: u64 = 300;
/// Default iOS redirect scheme (the app's bundle id) when `.env` doesn't set one.
const DEFAULT_IOS_SCHEME: &str = "com.subdigest.app";

#[derive(Default)]
pub struct AuthState(Mutex<Option<StoredAuth>>);

/// Tracks the in-flight OAuth attempt so a new attempt (or an explicit cancel)
/// can abort the previous one — freeing the loopback port on desktop, or
/// resolving the pending deep-link wait on iOS.
#[derive(Default)]
pub struct ConnectState {
    /// Cancel handle for a loopback (desktop) attempt.
    cancel: Mutex<Option<Arc<Notify>>>,
    /// Delivery channel for a deep-link (iOS) attempt awaiting its redirect.
    pending: Mutex<Option<Pending>>,
}

/// A deep-link attempt waiting for the OS to route the redirect back in.
struct Pending {
    csrf: String,
    tx: oneshot::Sender<Result<String, String>>,
}

/// Aborts whatever attempt is currently in flight (both strategies).
fn abort_previous(connect: &ConnectState) {
    if let Some(prev) = connect.cancel.lock().unwrap().take() {
        prev.notify_waiters();
    }
    if let Some(prev) = connect.pending.lock().unwrap().take() {
        let _ = prev.tx.send(Err("sign-in cancelled".to_string()));
    }
}

/// Called from the deep-link handler (see `lib.rs`) when the OS hands the app a
/// custom-scheme URL. Matches it to the pending attempt and delivers the code.
pub fn deliver_deep_link(app: &AppHandle, url: &str) {
    let query = url.split_once('?').map(|(_, q)| q).unwrap_or("");
    if query.is_empty() {
        return;
    }
    let (mut code, mut state, mut error) = (None, None, None);
    for (k, v) in url::form_urlencoded::parse(query.as_bytes()) {
        match k.as_ref() {
            "code" => code = Some(v.into_owned()),
            "state" => state = Some(v.into_owned()),
            "error" => error = Some(v.into_owned()),
            _ => {}
        }
    }

    let connect = app.state::<ConnectState>();
    let Some(pending) = connect.pending.lock().unwrap().take() else {
        return; // no attempt waiting; ignore stray links
    };
    if state.as_deref() != Some(pending.csrf.as_str()) {
        let _ = pending.tx.send(Err("OAuth state mismatch".to_string()));
        return;
    }
    let outcome = match (error, code) {
        (Some(err), _) => Err(format!("Google sign-in error: {err}")),
        (None, Some(code)) => Ok(code),
        (None, None) => Err("no authorization code in redirect".to_string()),
    };
    let _ = pending.tx.send(outcome);
}

#[derive(Clone, Serialize, Deserialize)]
pub struct StoredAuth {
    client_id: String,
    client_secret: String,
    refresh_token: String,
    email: String,
    #[serde(default)]
    access_token: String,
    #[serde(default)]
    expires_at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostMeta {
    id: String,
    from: String,
    subject: String,
    date_ms: i64,
}

fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent("SubDigest/0.1")
            .build()
            .expect("failed to build http client")
    })
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn auth_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("auth.json"))
}

fn persist(app: &AppHandle, auth: &StoredAuth) -> Result<(), String> {
    let path = auth_path(app)?;
    let json = serde_json::to_vec_pretty(auth).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

/// Loads persisted auth into state if state is empty; returns a snapshot.
fn snapshot(app: &AppHandle, state: &AuthState) -> Option<StoredAuth> {
    let mut guard = state.0.lock().unwrap();
    if guard.is_none() {
        if let Ok(path) = auth_path(app) {
            if let Ok(bytes) = std::fs::read(path) {
                if let Ok(auth) = serde_json::from_slice::<StoredAuth>(&bytes) {
                    *guard = Some(auth);
                }
            }
        }
    }
    guard.clone()
}

/// Returns a valid access token, refreshing it if it expires within a minute.
async fn access_token(app: &AppHandle, state: &State<'_, AuthState>) -> Result<String, String> {
    let auth = snapshot(app, state).ok_or("not connected to Gmail")?;
    if !auth.access_token.is_empty() && auth.expires_at > now() + 60 {
        return Ok(auth.access_token);
    }

    // Public (iOS) clients have no secret; only send one when present.
    let mut form: Vec<(&str, &str)> = vec![
        ("client_id", auth.client_id.as_str()),
        ("refresh_token", auth.refresh_token.as_str()),
        ("grant_type", "refresh_token"),
    ];
    if !auth.client_secret.is_empty() {
        form.push(("client_secret", auth.client_secret.as_str()));
    }
    let resp = http()
        .post(oauth::TOKEN_URL)
        .form(&form)
        .send()
        .await
        .map_err(|e| format!("token refresh failed: {e}"))?;
    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("token refresh rejected: {body}"));
    }
    #[derive(Deserialize)]
    struct Refresh {
        access_token: String,
        expires_in: u64,
    }
    let r: Refresh = resp.json().await.map_err(|e| e.to_string())?;

    let updated = {
        let mut guard = state.0.lock().unwrap();
        let stored = guard.as_mut().ok_or("not connected to Gmail")?;
        stored.access_token = r.access_token.clone();
        stored.expires_at = now() + r.expires_in;
        stored.clone()
    };
    let _ = persist(app, &updated);
    Ok(r.access_token)
}

async fn api_get(token: &str, url: &str) -> Result<Value, String> {
    let resp = http()
        .get(url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("Gmail request failed: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Gmail API error {status}: {body}"));
    }
    resp.json().await.map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Commands

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn gmail_connect(
    app: AppHandle,
    state: State<'_, AuthState>,
    connect: State<'_, ConnectState>,
    client_id: String,
    client_secret: String,
    ios_client_id: String,
    ios_redirect_scheme: String,
    redirect_port: u16,
) -> Result<String, String> {
    // iOS uses a public client (custom-scheme redirect, PKCE, no secret); every
    // other platform uses the desktop loopback client with its secret.
    let use_ios = cfg!(target_os = "ios");
    let (client_id, client_secret) = if use_ios {
        (ios_client_id.trim().to_string(), String::new())
    } else {
        (client_id.trim().to_string(), client_secret.trim().to_string())
    };
    if client_id.is_empty() {
        return Err(if use_ios {
            "Gmail OAuth is missing an iOS client id. Set VITE_GMAIL_IOS_CLIENT_ID \
             in .env (see .env.example) and rebuild."
                .to_string()
        } else {
            "Gmail OAuth credentials are missing. Add VITE_GMAIL_CLIENT_ID and \
             VITE_GMAIL_CLIENT_SECRET to a .env file (see .env.example) and restart."
                .to_string()
        });
    }

    // A new attempt supersedes any prior one (frees the port / cancels the wait).
    abort_previous(&connect);

    let tokens = if use_ios {
        let scheme = {
            let s = ios_redirect_scheme.trim();
            if s.is_empty() { DEFAULT_IOS_SCHEME } else { s }
        };
        connect_via_deep_link(&app, &connect, &client_id, scheme).await?
    } else {
        let port = if redirect_port == 0 { 8788 } else { redirect_port };
        let cancel = Arc::new(Notify::new());
        *connect.cancel.lock().unwrap() = Some(cancel.clone());
        let result =
            oauth::authorize_loopback(&app, http(), &client_id, &client_secret, port, cancel.clone())
                .await;
        // Clear our handle if it's still the current one.
        {
            let mut guard = connect.cancel.lock().unwrap();
            if guard.as_ref().is_some_and(|c| Arc::ptr_eq(c, &cancel)) {
                *guard = None;
            }
        }
        result?
    };

    let profile = api_get(&tokens.access_token, &format!("{GMAIL}/profile")).await?;
    let email = profile["emailAddress"]
        .as_str()
        .unwrap_or("(unknown)")
        .to_string();

    let auth = StoredAuth {
        client_id,
        client_secret,
        refresh_token: tokens.refresh_token,
        email: email.clone(),
        access_token: tokens.access_token,
        expires_at: now() + tokens.expires_in,
    };
    persist(&app, &auth)?;
    *state.0.lock().unwrap() = Some(auth);
    Ok(email)
}

#[tauri::command]
pub async fn gmail_status(
    app: AppHandle,
    state: State<'_, AuthState>,
) -> Result<Option<String>, String> {
    let Some(auth) = snapshot(&app, &state) else {
        return Ok(None);
    };
    // Verify the stored refresh token still works before reporting connected.
    match access_token(&app, &state).await {
        Ok(_) => Ok(Some(auth.email)),
        Err(_) => Ok(None),
    }
}

/// iOS flow: open the browser, then await the custom-scheme redirect that the
/// OS routes back into the app via `deliver_deep_link`.
async fn connect_via_deep_link(
    app: &AppHandle,
    connect: &ConnectState,
    client_id: &str,
    scheme: &str,
) -> Result<oauth::TokenResponse, String> {
    let (verifier, challenge) = oauth::pkce();
    let csrf = oauth::random_state();
    let redirect_uri = format!("{scheme}:/oauth2redirect");
    let auth_url = oauth::build_auth_url(client_id, &redirect_uri, &challenge, &csrf);

    let (tx, rx) = oneshot::channel::<Result<String, String>>();
    *connect.pending.lock().unwrap() = Some(Pending { csrf, tx });

    app.opener()
        .open_url(auth_url.as_str(), None::<&str>)
        .map_err(|e| format!("could not open browser: {e}"))?;

    let code = match timeout(Duration::from_secs(CONNECT_TIMEOUT_SECS), rx).await {
        Err(_) => {
            connect.pending.lock().unwrap().take();
            return Err("timed out waiting for Google sign-in (5 minutes)".to_string());
        }
        // Sender dropped because a newer attempt or cancel superseded this one.
        Ok(Err(_)) => return Err("sign-in cancelled".to_string()),
        Ok(Ok(inner)) => inner?,
    };

    oauth::exchange_code(http(), client_id, "", &redirect_uri, &code, &verifier).await
}

#[tauri::command]
pub fn gmail_cancel_connect(connect: State<'_, ConnectState>) {
    abort_previous(&connect);
}

#[tauri::command]
pub async fn gmail_disconnect(app: AppHandle, state: State<'_, AuthState>) -> Result<(), String> {
    *state.0.lock().unwrap() = None;
    if let Ok(path) = auth_path(&app) {
        let _ = std::fs::remove_file(path);
    }
    Ok(())
}

#[tauri::command]
pub async fn gmail_search(
    app: AppHandle,
    state: State<'_, AuthState>,
    after_ms: i64,
    before_ms: i64,
    domains: Vec<String>,
) -> Result<Vec<PostMeta>, String> {
    let token = access_token(&app, &state).await?;

    // Sanitize to bare domains/addresses and OR them together.
    let cleaned: Vec<String> = domains
        .iter()
        .map(|d| d.trim().trim_start_matches('@').to_lowercase())
        .filter(|d| !d.is_empty() && !d.contains(' '))
        .collect();
    if cleaned.is_empty() {
        return Err("no sender domains configured".to_string());
    }
    let from = if cleaned.len() == 1 {
        format!("from:{}", cleaned[0])
    } else {
        format!("from:({})", cleaned.join(" OR "))
    };

    // `messages.list` with `q` searches all mail (archived included), minus
    // spam/trash. A non-positive bound means "open ended" on that side: no
    // `after_ms` is All time, no `before_ms` is up to now.
    let mut query = from;
    if after_ms > 0 {
        query.push_str(&format!(" after:{}", after_ms / 1000));
    }
    if before_ms > 0 {
        query.push_str(&format!(" before:{}", before_ms / 1000));
    }

    // Page through matching message ids
    let mut ids: Vec<String> = Vec::new();
    let mut page_token = String::new();
    loop {
        let mut url = url::Url::parse(&format!("{GMAIL}/messages")).unwrap();
        url.query_pairs_mut()
            .append_pair("q", &query)
            .append_pair("maxResults", "100");
        if !page_token.is_empty() {
            url.query_pairs_mut().append_pair("pageToken", &page_token);
        }
        let page = api_get(&token, url.as_str()).await?;
        if let Some(messages) = page["messages"].as_array() {
            ids.extend(
                messages
                    .iter()
                    .filter_map(|m| m["id"].as_str().map(String::from)),
            );
        }
        match page["nextPageToken"].as_str() {
            Some(next) if ids.len() < MAX_MESSAGES => page_token = next.to_string(),
            _ => break,
        }
    }
    ids.truncate(MAX_MESSAGES);

    // Fetch headers for each id with bounded concurrency
    let metas: Vec<Result<PostMeta, String>> = stream::iter(ids.into_iter().map(|id| {
        let token = token.clone();
        async move {
            let url = format!(
                "{GMAIL}/messages/{id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject"
            );
            let msg = api_get(&token, &url).await?;
            let header = |name: &str| -> String {
                msg["payload"]["headers"]
                    .as_array()
                    .and_then(|hs| {
                        hs.iter().find(|h| {
                            h["name"].as_str().unwrap_or("").eq_ignore_ascii_case(name)
                        })
                    })
                    .and_then(|h| h["value"].as_str())
                    .unwrap_or("")
                    .to_string()
            };
            let date_ms = msg["internalDate"]
                .as_str()
                .and_then(|s| s.parse::<i64>().ok())
                .unwrap_or(0);
            Ok(PostMeta {
                id,
                from: header("From"),
                subject: header("Subject"),
                date_ms,
            })
        }
    }))
    .buffer_unordered(METADATA_CONCURRENCY)
    .collect()
    .await;

    let mut out: Vec<PostMeta> = metas.into_iter().collect::<Result<_, _>>()?;
    out.sort_by_key(|m| -m.date_ms);
    Ok(out)
}

#[tauri::command]
pub async fn gmail_get_body(
    app: AppHandle,
    state: State<'_, AuthState>,
    id: String,
) -> Result<String, String> {
    let token = access_token(&app, &state).await?;
    let msg = api_get(&token, &format!("{GMAIL}/messages/{id}?format=full")).await?;
    let payload = &msg["payload"];

    if let Some(html) = find_body(payload, "text/html") {
        return Ok(html.trim_start().to_string());
    }
    if let Some(text) = find_body(payload, "text/plain") {
        return Ok(text);
    }
    Err("no readable body in this message".to_string())
}

/// Depth-first search of a MIME tree for a part of the given type.
fn find_body(part: &Value, mime: &str) -> Option<String> {
    if part["mimeType"].as_str() == Some(mime) {
        if let Some(data) = part["body"]["data"].as_str() {
            // Gmail uses base64url, with or without padding
            if let Ok(bytes) = URL_SAFE_NO_PAD.decode(data.trim_end_matches('=')) {
                return Some(String::from_utf8_lossy(&bytes).into_owned());
            }
        }
    }
    part["parts"]
        .as_array()
        .into_iter()
        .flatten()
        .find_map(|p| find_body(p, mime))
}

#[tauri::command]
pub async fn fetch_image(image_url: String) -> Result<String, String> {
    let parsed = url::Url::parse(&image_url).map_err(|e| format!("bad image url: {e}"))?;
    if parsed.scheme() != "https" {
        return Err("only https images are fetched".to_string());
    }
    let resp = http()
        .get(parsed)
        .send()
        .await
        .map_err(|e| format!("image fetch failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("image fetch failed: HTTP {}", resp.status()));
    }
    if let Some(len) = resp.content_length() {
        if len as usize > MAX_IMAGE_BYTES {
            return Err("image too large".to_string());
        }
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err("image too large".to_string());
    }
    Ok(STANDARD.encode(&bytes))
}

/// Writes a generated document (PDF or EPUB) to a user-chosen path.
#[tauri::command]
pub async fn save_file(path: String, bytes_b64: String) -> Result<(), String> {
    let bytes = STANDARD
        .decode(bytes_b64)
        .map_err(|e| format!("bad document payload: {e}"))?;
    std::fs::write(&path, bytes).map_err(|e| format!("could not write {path}: {e}"))
}
