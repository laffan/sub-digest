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
use tokio::sync::Notify;

use crate::oauth;

const GMAIL: &str = "https://gmail.googleapis.com/gmail/v1/users/me";
const MAX_MESSAGES: usize = 500;
const METADATA_CONCURRENCY: usize = 8;
const MAX_IMAGE_BYTES: usize = 15 * 1024 * 1024;

#[derive(Default)]
pub struct AuthState(Mutex<Option<StoredAuth>>);

/// Holds the cancel handle for an in-flight OAuth attempt, so a new attempt
/// (or an explicit cancel) can abort the previous one and free the port.
#[derive(Default)]
pub struct ConnectState(Mutex<Option<Arc<Notify>>>);

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

    let resp = http()
        .post(oauth::TOKEN_URL)
        .form(&[
            ("client_id", auth.client_id.as_str()),
            ("client_secret", auth.client_secret.as_str()),
            ("refresh_token", auth.refresh_token.as_str()),
            ("grant_type", "refresh_token"),
        ])
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
pub async fn gmail_connect(
    app: AppHandle,
    state: State<'_, AuthState>,
    connect: State<'_, ConnectState>,
    client_id: String,
    client_secret: String,
    redirect_port: u16,
) -> Result<String, String> {
    let client_id = client_id.trim().to_string();
    let client_secret = client_secret.trim().to_string();
    if client_id.is_empty() || client_secret.is_empty() {
        return Err(
            "Gmail OAuth credentials are missing. Add VITE_GMAIL_CLIENT_ID and \
             VITE_GMAIL_CLIENT_SECRET to a .env file (see .env.example) and restart."
                .to_string(),
        );
    }
    let port = if redirect_port == 0 { 8788 } else { redirect_port };

    // Cancel any prior in-flight attempt (freeing the port) and register ours.
    let cancel = Arc::new(Notify::new());
    {
        let mut guard = connect.0.lock().unwrap();
        if let Some(prev) = guard.take() {
            prev.notify_waiters();
        }
        *guard = Some(cancel.clone());
    }

    let result = oauth::authorize(&app, http(), &client_id, &client_secret, port, cancel.clone()).await;

    // Clear our handle if it's still the current one.
    {
        let mut guard = connect.0.lock().unwrap();
        if guard.as_ref().is_some_and(|c| Arc::ptr_eq(c, &cancel)) {
            *guard = None;
        }
    }
    let tokens = result?;

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

#[tauri::command]
pub fn gmail_cancel_connect(connect: State<'_, ConnectState>) {
    if let Some(cancel) = connect.0.lock().unwrap().take() {
        cancel.notify_waiters();
    }
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
) -> Result<Vec<PostMeta>, String> {
    let token = access_token(&app, &state).await?;
    let query = format!("from:substack.com after:{}", after_ms / 1000);

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

#[tauri::command]
pub async fn save_pdf(path: String, bytes_b64: String) -> Result<(), String> {
    let bytes = STANDARD
        .decode(bytes_b64)
        .map_err(|e| format!("bad pdf payload: {e}"))?;
    std::fs::write(&path, bytes).map_err(|e| format!("could not write {path}: {e}"))
}
