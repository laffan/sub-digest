//! Google OAuth 2.0 installed-app flow with PKCE and a loopback redirect.
//!
//! Binds an ephemeral port on 127.0.0.1, opens the consent screen in the
//! system browser, and waits for Google to redirect back with the
//! authorization code, which is then exchanged for tokens.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::RngCore;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::Notify;
use tokio::time::{sleep, timeout, Duration};

pub const SCOPE: &str = "https://www.googleapis.com/auth/gmail.readonly";
pub const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const WAIT_SECS: u64 = 300;

#[derive(Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: String,
    pub expires_in: u64,
}

pub async fn authorize(
    app: &AppHandle,
    http: &reqwest::Client,
    client_id: &str,
    client_secret: &str,
    port: u16,
    cancel: Arc<Notify>,
) -> Result<TokenResponse, String> {
    let verifier = random_token(64);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let csrf = random_token(24);

    // A fixed loopback port gives one stable redirect URI to register in the
    // Google Cloud Console, which is what Web-application OAuth clients require.
    let listener = bind_with_retry(port).await?;
    let redirect_uri = format!("http://127.0.0.1:{port}");

    let mut auth_url = url::Url::parse(AUTH_URL).unwrap();
    auth_url
        .query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("scope", SCOPE)
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent")
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &csrf);

    app.opener()
        .open_url(auth_url.as_str(), None::<&str>)
        .map_err(|e| format!("could not open browser: {e}"))?;

    // Race the redirect against an explicit cancel (e.g. the user aborting, or
    // a fresh connect attempt) so a blocked sign-in that never redirects back
    // doesn't hold the loopback port for the full timeout. Dropping
    // `wait_for_code` on cancel releases the listener immediately.
    let code = tokio::select! {
        biased;
        _ = cancel.notified() => return Err("sign-in cancelled".to_string()),
        r = timeout(Duration::from_secs(WAIT_SECS), wait_for_code(listener, &csrf)) => {
            r.map_err(|_| "timed out waiting for Google sign-in (5 minutes)".to_string())??
        }
    };

    let resp = http
        .post(TOKEN_URL)
        .form(&[
            ("code", code.as_str()),
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("redirect_uri", redirect_uri.as_str()),
            ("grant_type", "authorization_code"),
            ("code_verifier", verifier.as_str()),
        ])
        .send()
        .await
        .map_err(|e| format!("token exchange failed: {e}"))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("token exchange rejected: {body}"));
    }
    let tokens: TokenResponse = resp
        .json()
        .await
        .map_err(|e| format!("bad token response: {e}"))?;
    if tokens.refresh_token.is_empty() {
        return Err(
            "Google did not return a refresh token. Remove the app's access at \
             myaccount.google.com/permissions and connect again."
                .to_string(),
        );
    }
    Ok(tokens)
}

/// Binds the fixed loopback port, briefly retrying so a just-cancelled prior
/// attempt has a moment to release it before we give up.
async fn bind_with_retry(port: u16) -> Result<TcpListener, String> {
    let mut last = String::new();
    for attempt in 0..8 {
        match TcpListener::bind(("127.0.0.1", port)).await {
            Ok(listener) => return Ok(listener),
            Err(e) => {
                last = e.to_string();
                if attempt < 7 {
                    sleep(Duration::from_millis(150)).await;
                }
            }
        }
    }
    Err(format!(
        "could not open loopback port {port}: {last}. Close whatever is using \
         it, or set VITE_OAUTH_REDIRECT_PORT to a free port."
    ))
}

/// Accepts connections until one carries the OAuth redirect, then answers it.
async fn wait_for_code(listener: TcpListener, csrf: &str) -> Result<String, String> {
    loop {
        let (mut stream, _) = listener
            .accept()
            .await
            .map_err(|e| format!("loopback accept failed: {e}"))?;

        let mut buf = vec![0u8; 8192];
        let n = stream.read(&mut buf).await.unwrap_or(0);
        let request = String::from_utf8_lossy(&buf[..n]);
        let first_line = request.lines().next().unwrap_or_default();

        // Expect: GET /?code=...&state=... HTTP/1.1
        let path = first_line.split_whitespace().nth(1).unwrap_or("");
        let full = format!("http://127.0.0.1{path}");
        let parsed = match url::Url::parse(&full) {
            Ok(u) => u,
            Err(_) => {
                let _ = respond(&mut stream, 404, "Not found").await;
                continue;
            }
        };
        let get = |k: &str| {
            parsed
                .query_pairs()
                .find(|(key, _)| key == k)
                .map(|(_, v)| v.into_owned())
        };

        if let Some(err) = get("error") {
            let _ = respond(&mut stream, 200, "Sign-in was cancelled. You can close this tab.").await;
            return Err(format!("Google sign-in error: {err}"));
        }
        match get("code") {
            Some(code) if get("state").as_deref() == Some(csrf) => {
                let _ = respond(
                    &mut stream,
                    200,
                    "Sub Digest is connected. You can close this tab and return to the app.",
                )
                .await;
                return Ok(code);
            }
            Some(_) => {
                let _ = respond(&mut stream, 400, "State mismatch; please try again.").await;
                return Err("OAuth state mismatch".to_string());
            }
            None => {
                // favicon requests etc. — keep waiting
                let _ = respond(&mut stream, 404, "Not found").await;
            }
        }
    }
}

async fn respond(
    stream: &mut tokio::net::TcpStream,
    status: u16,
    message: &str,
) -> std::io::Result<()> {
    let reason = if status == 200 { "OK" } else { "Not Found" };
    let body = format!(
        "<!doctype html><meta charset=\"utf-8\"><title>Sub Digest</title>\
         <body style=\"font-family:sans-serif;display:grid;place-items:center;height:90vh\">\
         <p>{message}</p></body>"
    );
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/html; charset=utf-8\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(response.as_bytes()).await?;
    stream.shutdown().await
}

fn random_token(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    URL_SAFE_NO_PAD.encode(buf)
}
