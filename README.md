# Sub Digest

A [Tauri 2](https://v2.tauri.app) app for macOS and iPadOS that turns the
Substack newsletters in your Gmail inbox into a printable PDF booklet — a
little magazine of your recent reading — or an EPUB for your e-reader.

## What it does

1. **Connect Gmail** — sign in with Google (OAuth, read-only scope). You
   provide your own OAuth client ID/secret; tokens are stored locally on the
   device and mail is only ever read, never modified.
2. **Scan** — finds every email from your configured sender domains
   (`substack.com` by default) across your whole mailbox (archived mail
   included, not just the inbox) within a timeframe you choose — from the last
   7 days up to All time, or **Range…** for an explicit start and end date
   (both days included) — and groups it by publication. The **gear** by the
   title opens a Settings modal where you add or remove domains (e.g.
   `ghost.io`, `beehiiv.com`, or a specific sender like `news@example.com`).
3. **Select** — check/uncheck whole publications or individual posts, or
   **shift-click** a post to select (or deselect) everything between it and
   your last click, across publications. Posts already fetched and parsed in an
   earlier session are shown at half strength, so what's new stands out. It's a
   marker and nothing else — those posts still select, scan and generate exactly
   as any other, and Settings has a **Clear** to forget them. Each publication has a dropdown (the
   caret by its name) to enable a per-newsletter **AI agent** and give it
   instructions — built for link roundups, where the digest should carry the
   linked articles rather than a page of links. With an Anthropic API key (set
   in Settings), the model identifies the newsletter's article links — title,
   author and URL, all lifted from the email's own words — and stops there;
   **the app fetches each one** and builds an entry out of the scraped text.
   Each linked article becomes its own entry, under its own title and byline,
   so a roundup arrives as the pieces it recommended rather than as the email
   that listed them. The scraper works out which part of each page holds the
   body copy and takes only that, with its images, so an entry arrives close to
   what you wanted rather than trailing a comment section and a subscribe box —
   and the log names the container it read, so a page that comes out wrong tells
   you which selector to pin in the instructions. Every word is scraped, never written, so the
   agent costs one short model call per newsletter rather than a minute of it
   retyping the articles. A newsletter with no article links is noted in the
   log and falls through to the normal parser.
4. **Generate** — pick **PDF** or **EPUB** at the top of the middle column;
   both take the same posts in the order set in **Organize**.

   - **PDF** — a custom layout engine flows the posts (publication name, title,
     date, and body text) into fixed pages, with images floated to alternating
     sides at up to half-column width so text wraps around them. An optional
     cover carries a table of contents listing **every** post — title,
     publication, date and page number, running onto further contents pages
     when one isn't enough — and each entry is a clickable link to the page the
     post starts on. Then page numbers, and optional 2-up saddle-stitch
     imposition so you can print, fold, and staple a booklet (the contents
     links are rebuilt on the imposed sheets, so they still work). The PDF's
     title is the date span of the included posts.
   - **EPUB** — a reflowable EPUB 3 e-book, one chapter per post, with a
     navigation document (plus a legacy NCX for older readers) listing every
     post with its publication and date, so the whole digest is one tap away in
     the reader's contents. An optional title page opens the book, followed by
     the contents page itself. Page size, margins, columns and type size belong
     to the reading device, so the e-book leaves them to it; the font family
     and line height carry over as the book's stylesheet. Text stays UTF-8, so
     emoji and CJK survive here even though the PDF drops them.

The window has one working column beside the preview, and it moves through
three steps in order, each with a link back:

1. **Select** — the account and the discovered posts.
2. **Organize** — every selected post is fetched and parsed here, one at a
   time, with progress at the top of the column and the running order below it.
   Each row is one entry in the digest — for agent-processed newsletters, one
   of the articles it linked to, listed under that article's title, byline and
   address. **Drag** a row (by its grip, or from anywhere on it with a mouse)
   to set where it lands in the digest; the order starts chronological.
   **Clicking** a row scrolls the preview to it. The content accrues on the
   right as each post is read — images and all, fetched as you scroll to them —
   so you can see what was actually captured before generating anything.

   Two ways to take material out, both provisional. The **trash** on a row
   removes that whole article. **Remove content** turns the pointer into a
   crosshair: drag across the preview and the material you cover is marked —
   hold **⌥** while dragging to put it back. Either way what's removed turns
   red rather than disappearing, so it's still there and still yours to
   adjust; **Restore** clears every mark at once. An entry with nothing left
   drops from the digest, and its row says so. Nothing is deleted, so stepping
   back here from Output finds every mark where you left it.
3. **Output** — format and its settings, then Generate.

A selection can't change under a run that's already going. The preview on the
right shows the real generated PDF, or the EPUB's own markup and stylesheet for
e-books.

The **log** button next to the gear opens a pane across the foot of the window:
Gmail queries and match counts, every generation step, and the agent's own
running commentary — each model turn with its timing and token counts, every
page it fetches, retries, and anything that fails. It's the place to look when
a newsletter comes out wrong. **Copy** puts the whole log on the clipboard.

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
storage/refresh, Gmail API, parser, and both export engines are identical to
desktop.

Building for iPad needs a Mac with Xcode:

```sh
npm run tauri ios init
npm run ios:dev            # simulator or device
npm run ios:build          # produce the .app / .ipa
npm run ios:deploy         # build, then install on a connected device via ios-deploy
```

`ios:deploy` runs `tauri ios build` and then hands the freshly built `.app`
bundle to [`ios-deploy`](https://github.com/ios-control/ios-deploy)
(`brew install ios-deploy`), which installs and launches it on a connected
iPad. `scripts/ios-app-path.mjs` locates the newest device build under
`src-tauri/gen/apple/build`.

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

3. **"Save PDF…" / "Save EPUB…"** uses `tauri-plugin-dialog`, which presents
   the iOS document picker — no extra work.

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
| Email HTML → content blocks | `src/parse.ts` | Strips Substack chrome (subscribe buttons, footers, tracking pixels); also `markdownToBlocks` for agent output |
| Per-newsletter AI agent | `src-tauri/src/anthropic.rs` | Optional agent (Claude Haiku 4.5, `temperature: 0`) for link-roundup newsletters; returns one entry per linked article. **Exactly one model call**, and its only job is naming the links — **structured outputs** (`output_config.format` with a JSON schema) give back title, author, URL and the newsletter's note, all quoted from the email rather than composed. Everything after that is code: the app resolves each link, scrapes the article, and assembles the entry. Nothing in the digest is generated, so the model can't invent text and isn't spending a minute a newsletter retyping what the scraper already has. Every URL it returns is checked against the email character for character, and one that isn't there is logged as a warning. API key set in Settings; runs in Rust (no CORS). Bounded so a stall can't pass for a hang: at most 4 pages fetched at once, 45s per page, 120s for the model call, and 4 minutes for a whole newsletter, after which it gives up and the default parser takes over |
| Link resolution | `src-tauri/src/anthropic.rs` | Newsletter redirect wrappers are followed to the real article, then re-fetched without the query string (tracking parameters can land on an error page where the bare URL serves the piece), falling back to the original if that doesn't pan out. Every URL in the chain is logged, and the address the text actually came from is the one printed under the title |
| Scrape → Markdown | `src-tauri/src/anthropic.rs` | The page's readable tags become Markdown — headings nested under the entry's own, lists as lists, quotes as quotes, images as images — with nested matches emitted once. Image addresses are resolved against the page, and lazy-loaded `data-src`/`srcset` are read, so a placeholder `src` doesn't cost you the picture |
| Body-copy detection | `src-tauri/src/anthropic.rs` | Rather than taking every readable tag on the page, it works out where the piece actually lives: each paragraph's length is credited to all its ancestors, and the **deepest** container still holding ~90% of the best score wins — which narrows `body > div > article` down to the article. Furniture (`nav`/`header`/`footer`/`aside`/`form`, `aria-hidden`, and classes made of words like `comments`, `share`, `subscription`, `sidebar`, `related`) is dropped first, so it can't win on a long comment thread. Class names are matched **word by word**, never as substrings — Substack's own article is `class="newsletter-post"`, which a substring match for "newsletter" would discard wholesale. The container it settled on is named in the log |
| PDF layout engine | `src/pdf/layout.ts` | Column flow, per-line word wrap around alternating floated images, widow control, multi-page linked contents, saddle-stitch imposition — built on pdf-lib |
| EPUB packaging | `src/epub/build.ts` | EPUB 3 container: package document, navigation document, legacy NCX, one chapter per post; zipped with fflate (`mimetype` stored first, as OCF requires) |
| EPUB markup | `src/epub/xhtml.ts` | Content blocks → XHTML, XML escaping, and the book's stylesheet |
| Image pipeline | `src/images.ts` | Fetch via Rust (no CORS), decode in webview, downscale, re-encode JPEG — shared by both exporters and by the Organize preview, which shows the same re-encoded image it will print. The preview fetches lazily (`IntersectionObserver`, a screen ahead), so a hundred-image digest doesn't stall the step for pictures nobody has scrolled to |
| Preview | `src/components/Preview.tsx` | Renders the actual generated PDF with pdf.js; EPUBs render their own markup in a sandboxed frame |
| Strike-out tool | `src/components/ContentPreview.tsx`, `src/types.ts` | A rubber-band drag over the Organize preview marks blocks (⌥ to unmark); a row's trash marks every block of that entry at once, so both land in the same place. Marks are keys — entry id plus block index — held beside the content rather than cut out of it, so they survive reordering and stepping back and forth; `withRemovals` applies them on the way to the exporters |
| Reordering | `src/components/OrganizePanel.tsx` | Pointer events rather than HTML5 drag-and-drop, which touch devices don't fire — so the same code reorders under a mouse on the Mac and a finger on the iPad. A press only becomes a drag past a 4px threshold, leaving a plain click free to mean "show me this entry" |
| Already-read marker | `src/processed.ts` | Message ids of posts that have been fetched and parsed, in `localStorage`, capped at 5,000 (oldest dropped). The set used for shading is read **once at startup**, so a post read a minute ago doesn't grey out under the user mid-run — it shows up the next time they scan. Purely cosmetic: nothing consults it to skip, filter or deselect |
| Log | `src/log.ts`, `src-tauri/src/log.rs` | Module-level store in the UI (any layer can write without prop drilling); the backend feeds it over a Tauri `log` event |
| API transport | `src-tauri/src/anthropic.rs` | Responses are streamed (SSE), on a fresh HTTP/1.1 connection per request with no pooling — a silent request is what an idle-connection timeout kills, and a pooled or multiplexed connection carries that failure to the next call. First-token timing is logged, so a slow call can be told apart from a stalled one |

Generated PDFs use the PDF standard fonts (Times, Helvetica, Courier), so
files stay small; text outside WinAnsi (emoji, CJK) is dropped from output.
EPUBs are UTF-8 and name font *families* rather than embedding fonts, so
nothing is dropped and the files stay small too.

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
- The record of which posts you've already processed is message ids on this
  device, nothing more — no subjects, no content — and Settings clears it.
- Email content and images are fetched directly from Google/Substack CDNs and
  never leave the device.
- The AI agent is entirely opt-in and per-newsletter. When enabled, that
  newsletter's own content is sent to the Anthropic API so the model can name
  the links it recommends. The text of the linked pages is **not** sent — it is
  fetched after that call and goes straight into the digest. The API key is
  stored only on this device. Page fetches only request http(s) URLs and refuse
  private/loopback addresses, both for the link itself and for wherever it
  redirects.
