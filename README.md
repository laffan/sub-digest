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
2. Configure the OAuth consent screen (External is fine; add your own Gmail
   address as a test user while the app is in "Testing" status).
3. Create credentials → **OAuth client ID** → application type **Desktop
   app**. Copy the client ID and client secret.
4. Paste both into the left column of the app and click **Connect Gmail**.
   Sign-in happens in your browser and redirects back to the app on
   `127.0.0.1` (loopback), per Google's installed-app flow.

The requested scope is `gmail.readonly` only.

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
| Gmail OAuth (PKCE + loopback) | `src-tauri/src/oauth.rs` | Opens system browser, ephemeral 127.0.0.1 port |
| Gmail API + token refresh | `src-tauri/src/gmail.rs` | Search, header metadata (8-way concurrent), body fetch, HTTPS image proxy |
| Email HTML → content blocks | `src/parse.ts` | Strips Substack chrome (subscribe buttons, footers, tracking pixels) |
| Layout engine | `src/pdf/layout.ts` | Column flow, word wrap, widow control, image scaling, cover page, saddle-stitch imposition — built on pdf-lib |
| Image pipeline | `src/pdf/images.ts` | Fetch via Rust (no CORS), decode in webview, downscale, re-encode JPEG |
| Preview | `src/components/Preview.tsx` | Renders the actual generated PDF with pdf.js |

Generated PDFs use the PDF standard fonts (Times, Helvetica, Courier), so
files stay small; text outside WinAnsi (emoji, CJK) is dropped from output.

## Privacy

- Read-only Gmail scope; nothing is written to your mailbox.
- OAuth tokens are stored in the app's local data directory only.
- Email content and images are fetched directly from Google/Substack CDNs and
  never leave the device.
