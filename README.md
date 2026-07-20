# Sub Digest

A [Tauri 2](https://v2.tauri.app) app for macOS and iPadOS that turns the
Substack newsletters in your Gmail inbox into a printable PDF booklet — a
little magazine of your recent reading.

## What it does

1. **Connect Gmail** — sign in with Google (OAuth, read-only scope). You
   provide your own OAuth client ID/secret; tokens are stored locally on the
   device and mail is only ever read, never modified.
2. **Scan** — finds every email from `substack.com` across your whole mailbox
   (archived mail included, not just the inbox) within a timeframe you choose —
   from the last 7 days up to All time — and groups it by publication.
3. **Select** — check/uncheck whole publications or individual posts.
4. **Generate** — a custom layout engine flows the posts (publication name,
   title, date, body text, and images scaled to fit) in chronological order
   into a PDF, with an optional cover that carries the table of contents
   (each post with its page number), page numbers, and optional 2-up
   saddle-stitch imposition so you can print, fold, and staple a booklet.

The window has three columns: account + discovered posts on the left, PDF
settings (page size, margins, columns, font, font size, line height, images,
imposition) in the middle, and a live preview of the generated PDF on the
right.

## Setup

### Prerequisites

- [Rust](https://rustup.rs) (stable)
- Node.js 20+
- Tauri platform prerequisites for your OS: see
  <https://v2.tauri.app/start/prerequisites/>

### Google OAuth credentials

The app uses the Gmail API with your own OAuth client:

1. In the [Google Cloud Console](https://console.cloud.google.com), create a
   project and **enable the Gmail API**.
2. Configure the OAuth consent screen (**External** is fine). Leave the
   publishing status as **Testing**, and under **Test users** add the Gmail
   address you'll sign in with. This step is required: `gmail.readonly` is a
   *restricted* scope, so in Testing mode Google only lets registered test
   users authorize — anyone else is blocked with `Error 403: access_denied`.
   Also confirm `.../auth/gmail.readonly` appears under **Data access /
   Scopes**.
3. Create credentials → **OAuth client ID**. Either application type works:
   - **Desktop app** — simplest; loopback redirects are accepted
     automatically.
   - **Web application** — you must add the redirect URI below under
     **Authorized redirect URIs**.
4. **Register the redirect URI.** The app uses a *fixed* loopback port so
   there's a single, stable URI to register. Add exactly:

   ```
   http://127.0.0.1:8788
   ```

   (or `http://127.0.0.1:<port>` if you override `VITE_OAUTH_REDIRECT_PORT`).
   Registering this exact URI is what resolves the `Error 400:
   redirect_uri_mismatch` you get with a Web-application client.
5. Copy the client ID and secret into your `.env` (next section).

The requested scope is `gmail.readonly` only.

On the **first** sign-in Google shows a **"Google hasn't verified this app"**
screen. That's expected for a personal, unverified app — click **Advanced →
Go to Sub Digest (unsafe)** and continue. (Verification is only needed to
release restricted scopes publicly, not for your own test-user account.)

### Configure `.env`

Credentials live in a `.env` file at the project root, not in the UI:

```sh
cp .env.example .env
```

Then fill in:

```sh
VITE_GMAIL_CLIENT_ID=your-client-id.apps.googleusercontent.com
VITE_GMAIL_CLIENT_SECRET=your-client-secret
VITE_OAUTH_REDIRECT_PORT=8788   # optional; must match the registered URI
```

These are read at build/dev time by Vite. `.env` is git-ignored; restart the
dev server after changing it. In the app's left column you'll then see a
**Connect Gmail** button (and a reminder of the exact redirect URI to
register).

### Run (macOS desktop)

```sh
npm install
npm run tauri dev      # development
npm run tauri build    # produce a .app / .dmg
```

### iPadOS

iOS sign-in is implemented: instead of the desktop loopback redirect, the app
uses a **custom URL scheme** that iOS routes back into the app via
`tauri-plugin-deep-link`. The backend (`src-tauri/src/gmail.rs`) picks the iOS
flow automatically when running on iOS — the shared PKCE core, token
storage/refresh, Gmail API, parser, and PDF engine are identical to desktop.

Building for iPad needs a Mac with Xcode:

```sh
npm run tauri ios init
npm run tauri ios dev      # simulator or device
npm run tauri ios build
```

Three iOS-specific setup steps (done once, on the Mac):

1. **Create an iOS OAuth client** in the same Google Cloud project (type
   **iOS**, Bundle ID `com.subdigest.app`). It shares the consent screen and
   test users you already configured. Put its client id in `.env` as
   `VITE_GMAIL_IOS_CLIENT_ID` (iOS clients are public — no secret).

2. **Register the redirect scheme in the iOS `Info.plist`.** After
   `tauri ios init`, add to `src-tauri/gen/apple/<app>_iOS/Info.plist` so iOS
   hands the redirect back to the app:

   ```xml
   <key>CFBundleURLTypes</key>
   <array>
     <dict>
       <key>CFBundleURLSchemes</key>
       <array>
         <string>com.subdigest.app</string>
       </array>
     </dict>
   </array>
   ```

   This must match `VITE_GMAIL_IOS_REDIRECT_SCHEME` (default `com.subdigest.app`,
   the bundle id). The redirect URI Google receives is
   `com.subdigest.app:/oauth2redirect`. If you'd rather use the reverse-client-id
   scheme, set both the plist entry and the env var to
   `com.googleusercontent.apps.<your-ios-client-id>`.

3. **"Save PDF…"** uses `tauri-plugin-dialog`, which presents the iOS document
   picker — no extra work.

The loopback flow still works in the **iPad simulator**, so you can develop the
whole app there before wiring the iOS client for on-device/TestFlight builds.

> Note: the desktop loopback path is verified here (it compiles and runs on
> Linux/macOS); the iOS deep-link path is fully written and type-checks, but the
> `Info.plist` scheme registration and on-device redirect can only be verified on
> a Mac + iPad, since Xcode isn't available in this build environment.

## How it's built

| Piece | Where | Notes |
| --- | --- | --- |
| Gmail OAuth (PKCE) | `src-tauri/src/oauth.rs` | Shared PKCE/token core + desktop loopback flow (fixed 127.0.0.1 port) |
| iOS deep-link OAuth | `src-tauri/src/gmail.rs`, `src-tauri/src/lib.rs` | Custom-scheme redirect routed back via `tauri-plugin-deep-link`; public client, no secret |
| Gmail API + token refresh | `src-tauri/src/gmail.rs` | Search, header metadata (8-way concurrent), body fetch, HTTPS image proxy; secret omitted for public clients |
| Email HTML → content blocks | `src/parse.ts` | Strips Substack chrome (subscribe buttons, footers, tracking pixels) |
| Layout engine | `src/pdf/layout.ts` | Column flow, word wrap, widow control, image scaling, cover page, saddle-stitch imposition — built on pdf-lib |
| Image pipeline | `src/pdf/images.ts` | Fetch via Rust (no CORS), decode in webview, downscale, re-encode JPEG |
| Preview | `src/components/Preview.tsx` | Renders the actual generated PDF with pdf.js |

Generated PDFs use the PDF standard fonts (Times, Helvetica, Courier), so
files stay small; text outside WinAnsi (emoji, CJK) is dropped from output.

## Troubleshooting sign-in

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Error 400: redirect_uri_mismatch` | The redirect URI isn't registered on a Web-application client | Add `http://127.0.0.1:8788` (or your port) under the client's **Authorized redirect URIs**, or use a **Desktop app** client |
| `Error 403: access_denied` | Your account isn't a **Test user** on the consent screen (required for the restricted `gmail.readonly` scope in Testing mode) | Add your Gmail address under **OAuth consent screen → Test users**, then retry |
| "Google hasn't verified this app" | Personal app hasn't gone through Google verification (normal) | **Advanced → Go to Sub Digest (unsafe)** to continue |
| "Google did not return a refresh token" | The app was previously authorized | Remove it at [myaccount.google.com/permissions](https://myaccount.google.com/permissions) and connect again |
| App stays on "Waiting for Google…" | Sign-in was blocked on Google's side (e.g. access_denied) and never redirected back | Click **Cancel** (frees the port), resolve the error above, then **Connect Gmail** again |

## Privacy

- Read-only Gmail scope; nothing is written to your mailbox.
- OAuth tokens are stored in the app's local data directory only.
- Email content and images are fetched directly from Google/Substack CDNs and
  never leave the device.
