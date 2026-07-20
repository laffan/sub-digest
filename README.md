# Sub Digest

A [Tauri 2](https://v2.tauri.app) app for macOS and iPadOS that turns the
Substack newsletters in your Gmail inbox into a printable PDF booklet — a
little magazine of your recent reading.

## What it does

1. **Connect Gmail** — sign in with Google (OAuth, read-only scope). You
   provide your own OAuth client ID/secret; tokens are stored locally on the
   device and mail is only ever read, never modified.
2. **Scan** — finds every email from `substack.com` within a timeframe you
   choose (7–90 days) and groups it by publication.
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

The project is set up for Tauri's iOS target (`bundle.iOS` is configured and
the crate builds as a static lib). To build for iPad you need a Mac with
Xcode:

```sh
npm run tauri ios init
npm run tauri ios dev      # simulator or device
npm run tauri ios build
```

Two iOS-specific notes:

- Google OAuth: create an additional OAuth client of type **iOS** in the
  Google Cloud Console. Google's loopback redirect works in the iPad
  simulator, but on a physical device you should register the reverse-client-ID
  custom URL scheme and use it as the redirect; wiring that scheme through
  `tauri-plugin-deep-link` is the intended extension point
  (`src-tauri/src/oauth.rs` is the only file that would change).
- "Save PDF…" uses the platform file dialog via `tauri-plugin-dialog`, which
  presents the iOS document picker.

## How it's built

| Piece | Where | Notes |
| --- | --- | --- |
| Gmail OAuth (PKCE + loopback) | `src-tauri/src/oauth.rs` | Opens system browser, fixed 127.0.0.1 port |
| Gmail API + token refresh | `src-tauri/src/gmail.rs` | Search, header metadata (8-way concurrent), body fetch, HTTPS image proxy |
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
