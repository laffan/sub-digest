# Sub Digest

A [Tauri 2](https://v2.tauri.app) app for macOS and iPadOS that turns the
Substack newsletters in your Gmail inbox into a printable PDF booklet — a
little magazine of your recent reading — or an EPUB for your e-reader.

## What it does

1. **Connect Gmail** — sign in with Google (OAuth, read-only scope). You
   provide your own OAuth client ID/secret; tokens are stored locally on the
   device and mail is only ever read, never modified.
2. **Scan** — finds every email your **filters** match, across your whole
   mailbox (archived mail included, not just the inbox) within a timeframe you
   choose — from the last 7 days up to All time, or **Range…** for an explicit
   start and end date (both days included) — and groups it by publication.

   **Filters**, beside the Posts heading, lists what you've saved with a
   checkbox on each — that's where filters are switched on and off — and a scan
   uses the ones you've ticked. **Edit Filters…** at the foot of that list
   opens the editor, where filters are added and removed. One filter is open at
   a time; the rest sit as a line each, name and what they match, so a dozen of
   them still read at a glance.

   A filter is a list of **rules**, each a type and a value:

   | Rule | Matches |
   | --- | --- |
   | **Sender domain** | everything from a publisher — `substack.com`, `ghost.io` |
   | **Sender** | one address, or the name on the From header — `news@example.com`, `The Browser` |
   | **Subject contains** | standing text in the subject line — `Weekly Digest`, `Issue #` |
   | **Search term** | words anywhere in the message |

   Rules of the same type are alternatives; the types a filter uses all have to
   hold. So `substack.com` plus the subject rule `Weekly` finds Substack mail
   whose subject carries "Weekly" and nothing else. Across filters it's an OR:
   each one is its own way in, and each runs as its own Gmail query — so every
   message comes back knowing which filters found it.

   Each filter also decides **how** its mail is read. Tick *Retrieve Links
   with AI agent* on one and everything it finds goes to the agent, with the
   instructions you write there; leave it off and the normal parser handles it.
   That's what makes a filter worth carving out: put the link roundups in their
   own filter — a subject rule is usually enough — switch the agent on for that
   one, and the rest of your mail is untouched. When a message matches several
   filters, an agentic one wins (that's the point of carving it out), and
   otherwise the first in your list. Publications that end up agent-read are
   marked `agent` in the scan list, and so are agentic filters in the Filters
   popup.

   Beside that sits *Remember removed content*. A newsletter is mostly the
   same furniture every week — the masthead image, the standing sign-off, the
   promo that runs every issue — and with this on, whatever you take out of
   one of this filter's posts is taken out of its later ones too. What's
   remembered is the thing itself, not the markup around it: a picture by its
   address (CDN resizing wrappers unwrapped, so the same image at another
   width still counts), a paragraph by its words. Put something back and the
   filter forgets it, so it stops coming out. Dropping a whole article with
   the trash teaches it nothing — that's about this digest, not about the
   publication. The editor says how many things a filter is remembering, with
   a **Forget them** to wipe the lot.

   Filters live on the device. An install that predates them carries its
   sender domains across as one filter, and each publication it had the
   agent switched on for becomes its own agentic filter — Gmail's `from:`
   matches the name on a From header as well as the address, so the
   publication's name is enough to find it. It keeps finding what it found,
   and reading it how it read it.
3. **Select** — check/uncheck whole publications or individual posts, or
   **shift-click** a post to select (or deselect) everything between it and
   your last click, across publications. Posts already fetched and parsed in an
   earlier session are shown at half strength, so what's new stands out. It's a
   marker and nothing else — those posts still select, scan and generate exactly
   as any other, and Settings has a **Clear** to forget them. A publication
   whose mail goes to the **AI agent** is marked `agent` here, so you can see
   what a run will do before starting it. With an Anthropic API key (set in
   Settings), the model identifies the newsletter's article links — title,
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
     date, and body text) into fixed pages. An image is a block of its own,
     with text above and below it and never beside it, and it prints at its own
     size — a small picture stays a small picture rather than being blown up to
     the measure. Only one wider than the column is scaled down to fit it. An optional
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

   Three ways to take material out, all provisional. The **trash** on a row
   removes that whole article. Every element in the preview carries a **✕**
   under the pointer, which takes out just that one — the only practical way to
   drop a single picture, and it needs no tool armed. **Remove content** turns
   the pointer into a crosshair for the rest: drag across the preview and the
   material you cover is marked — hold **⌥** while dragging to put it back. Any
   of them and what's removed turns red rather than disappearing, so it's still
   there and still yours to adjust; **Restore** clears every mark at once. An
   entry with nothing left drops from the digest, and its row says so. Nothing
   is deleted, so stepping back here from Output finds every mark where you
   left it.
3. **Output** — format and its settings, then Generate. **Save PDF…** writes
   the file; **Print…** hands it straight to the system's print dialog, which
   is where the paper size and the double-sided setting a folded booklet needs
   actually live.

A selection can't change under a run that's already going. The preview on the
right shows the real generated PDF, or the EPUB's own markup and stylesheet for
e-books.

A PDF preview is the finished document and stays editable: a rail of page
thumbnails runs down the left, and clicking one scrolls the pages to it, while
**clicking anything on a page itself** — a picture, a paragraph, a heading —
takes that element out of the digest and lays the document out again. The
previous version stays on screen while it does, so the page doesn't vanish from
under the click that changed it. Those removals are the same marks the Organize
step makes, so stepping back finds them there, and a filter set to remember
them will have done.

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
   the iOS document picker — no extra work. **Print…** is desktop only: it
   drives the platform's print flow through a command line, which iOS has no
   equivalent of, so on an iPad it says so and you print the saved file from
   Files instead.

The loopback flow still works in the **iPad simulator**, so you can develop the
whole app there before wiring the iOS client for on-device/TestFlight builds.

> Note: the desktop loopback path is verified here (it compiles and runs on
> Linux/macOS); the iOS deep-link path is fully written and type-checks, but the
> `Info.plist` scheme registration and on-device redirect can only be verified on
> a Mac + iPad, since Xcode isn't available in this build environment.

## Releasing

Two GitHub Actions workflows live in `.github/workflows`:

- **CI** (`ci.yml`) — on every push to `main` and every pull request, builds the
  frontend (`tsc` + Vite) and runs `cargo check` on macOS.
- **Release** (`release.yml`) — builds a **universal** macOS bundle (Apple
  silicon + Intel) and publishes it as a GitHub Release with the `.dmg`
  attached.

To cut a release, go to **Actions → Release → Run workflow**. Leave *version*
blank to use the number already in `tauri.conf.json`, or type one (`0.2.0`) to
build that instead. It publishes a **draft** by default, so you can read it over
before it's public — untick *draft* to publish straight away. Pushing a tag like
`v0.2.0` runs the same build.

The version lives in three files. Keep them in step with:

```sh
node scripts/set-version.mjs 0.2.0   # package.json, tauri.conf.json, Cargo.toml
node scripts/set-version.mjs         # prints the current version
```

The workflow reads the `.env` values from **repository secrets** — set
`VITE_GMAIL_CLIENT_ID`, `VITE_GMAIL_CLIENT_SECRET` and
`VITE_OAUTH_REDIRECT_PORT` (plus the two `VITE_GMAIL_IOS_*` ones if you're
using them) under *Settings → Secrets and variables → Actions*. Vite bakes them
into the bundle at build time exactly as a local `.env` would.

Two things worth knowing about what comes out:

- **The build isn't signed or notarised.** macOS quarantines it, so a first run
  needs `xattr -cr "/Applications/Sub Digest.app"`. Signing it properly means a
  paid Apple Developer account and adding `APPLE_CERTIFICATE`,
  `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`,
  `APPLE_PASSWORD` and `APPLE_TEAM_ID` as secrets — `tauri-action` picks them up
  with no change to the workflow.
- **Anyone who downloads it has your OAuth client secret**, since it's compiled
  into the app. That's inherent to installed-app OAuth — Google treats desktop
  client secrets as non-confidential, and the loopback redirect is what actually
  protects the flow — but it does mean the quota and consent screen are yours.
  There's no iOS job here: an iOS build needs signing certificates and a
  provisioning profile, which is a separate setup.

## How it's built

| Piece | Where | Notes |
| --- | --- | --- |
| Gmail OAuth (PKCE) | `src-tauri/src/oauth.rs` | Shared PKCE/token core + desktop loopback flow (fixed 127.0.0.1 port) |
| iOS deep-link OAuth | `src-tauri/src/gmail.rs`, `src-tauri/src/lib.rs` | Custom-scheme redirect routed back via `tauri-plugin-deep-link`; public client, no secret |
| Gmail API + token refresh | `src-tauri/src/gmail.rs` | Search, header metadata (8-way concurrent), body fetch, HTTPS image proxy; secret omitted for public clients |
| Mail filters | `src/filters.ts`, `src/components/FilterEditorModal.tsx` | The saved filters — what to find, whether the agent reads it, and what it remembers taking out of it — their storage, and the migration from the sender-domain list and per-publication agent settings that came before. Values are normalized on the way in: a pasted `https://ghost.io/blog` becomes `ghost.io`, `Nate <news@example.com>` becomes the address, and a sender's *name* keeps its spaces and capitals, since Gmail matches those too and it's read back in the editor |
| Filters → Gmail queries | `src-tauri/src/gmail.rs` | Domains, addresses and sender names are alternatives on one `from:` (no message is from two senders); subject slices become `subject:("…" OR "…")`, search terms bare phrases, and the kinds are ANDed. Each **enabled filter runs as its own query** rather than one big OR — a search term matches the body, so which filter caught a message can't be worked out from its headers afterwards, and every message has to come back knowing. Ids are unioned first and headers fetched once, so a message two filters found still costs one metadata request. Quotes are what delimits a phrase, so they're stripped from the text rather than escaped, and a `from:` operand that would need quoting is dropped instead — a filter can't break out of its own query. Unit-tested |
| Which filter reads a post | `src/filters.ts` (`decidingFilter`) | A message can match several filters, and one of them has to decide whether the agent runs. An agentic filter wins — carving the roundups out with a filter of their own is exactly what one is for, so it shouldn't lose to the broad filter that happens to catch them too — and otherwise it's the first in the user's own order. The scan list applies the same rule up front, so the `agent` marks there are what a run will actually do |
| Email HTML → content blocks | `src/parse.ts` | Strips Substack chrome (subscribe buttons, footers, tracking pixels); also `markdownToBlocks` for agent output |
| Per-filter AI agent | `src-tauri/src/anthropic.rs` | Optional agent (Claude Haiku 4.5, `temperature: 0`) switched on per filter, for link-roundup newsletters; returns one entry per linked article. **Exactly one model call**, and its only job is naming the links — **structured outputs** (`output_config.format` with a JSON schema) give back title, author, URL and the newsletter's note, all quoted from the email rather than composed. Everything after that is code: the app resolves each link, scrapes the article, and assembles the entry. Nothing in the digest is generated, so the model can't invent text and isn't spending a minute a newsletter retyping what the scraper already has. Every URL it returns is checked against the email character for character, and one that isn't there is logged as a warning. API key set in Settings; runs in Rust (no CORS). Bounded so a stall can't pass for a hang: at most 4 pages fetched at once, 45s per page, 120s for the model call, and 4 minutes for a whole newsletter, after which it gives up and the default parser takes over |
| Link resolution | `src-tauri/src/anthropic.rs` | Newsletter redirect wrappers are followed to the real article, then re-fetched without the query string (tracking parameters can land on an error page where the bare URL serves the piece), falling back to the original if that doesn't pan out. Every URL in the chain is logged, and the address the text actually came from is the one printed under the title |
| Scrape → Markdown | `src-tauri/src/anthropic.rs` | The page's readable tags become Markdown — headings nested under the entry's own, lists as lists, quotes as quotes, images as images — with nested matches emitted once. Image addresses are resolved against the page, and lazy-loaded `data-src`/`srcset` are read, so a placeholder `src` doesn't cost you the picture |
| Body-copy detection | `src-tauri/src/anthropic.rs` | Rather than taking every readable tag on the page, it works out where the piece actually lives: each paragraph's length is credited to all its ancestors, and the **deepest** container still holding ~90% of the best score wins — which narrows `body > div > article` down to the article. Furniture (`nav`/`header`/`footer`/`aside`/`form`, `aria-hidden`, and classes made of words like `comments`, `share`, `subscription`, `sidebar`, `related`) is dropped first, so it can't win on a long comment thread. Class names are matched **word by word**, never as substrings — Substack's own article is `class="newsletter-post"`, which a substring match for "newsletter" would discard wholesale. The container it settled on is named in the log |
| PDF layout engine | `src/pdf/layout.ts` | Column flow, word wrap, widow control, multi-page linked contents, saddle-stitch imposition — built on pdf-lib. Images break the column rather than sit in it: each is drawn at its own size (pixels read as 96 to the inch, points as 72), centred, and starts the next column rather than run off the bottom of this one. Only a picture wider than the measure is scaled down to it, and one taller than 60% of the column is capped at that, so no image takes a column on its own |
| What's drawn where | `src/pdf/layout.ts` (`beginBlock`/`endBlock`) | The layout returns the rectangle every block occupies, which is what makes a generated page clickable. A block that flows across a column break is recorded once per column, so each part of it is its own target; an image's rectangle is narrowed to the picture, so the white beside a small one isn't a hit. The numbers are the content's own, then shifted past the front matter once its page count is known, and moved onto the sheets — offset into the right-hand slot and all — when the booklet is imposed |
| EPUB packaging | `src/epub/build.ts` | EPUB 3 container: package document, navigation document, legacy NCX, one chapter per post; zipped with fflate (`mimetype` stored first, as OCF requires) |
| EPUB markup | `src/epub/xhtml.ts` | Content blocks → XHTML, XML escaping, and the book's stylesheet |
| Image pipeline | `src/images.ts` | Fetch via Rust (no CORS), decode in webview, downscale, re-encode JPEG — shared by both exporters and by the Organize preview, which shows the same re-encoded image it will print. The preview fetches lazily (`IntersectionObserver`, a screen ahead), so a hundred-image digest doesn't stall the step for pictures nobody has scrolled to |
| Preview | `src/components/Preview.tsx` | Renders the actual generated PDF with pdf.js, twice: full size in the column, and again at 150px as a sticky rail of thumbnails that scrolls the pages when clicked. A click on a page is turned back into PDF points from the canvas's own scale and hit-tested against the placements, smallest rectangle winning, so a picture beats the column it sits in. EPUBs render their own markup in a sandboxed frame |
| Strike-out tool | `src/components/ContentPreview.tsx`, `src/types.ts` | A rubber-band drag over the Organize preview marks blocks (⌥ to unmark); a ✕ on each block marks that one; a row's trash marks every block of that entry at once; and so does a click on the generated PDF. They all land in the same place. Marks are keys — entry id plus block index — held beside the content rather than cut out of it, so they survive reordering and stepping back and forth; `withRemovals` applies them on the way to the exporters |
| Remembering removals | `src/remember.ts` | The signature a filter recognises material by, for *Remember removed content*. It's the block's own identity rather than the classes around it: a newsletter template gives every paragraph in the body the same class, so a signature made of those would take out one week's sign-off and next week's article with it. Images reduce to an address with the CDN's resizing wrapper unwrapped and the query string dropped, text to its words folded to lower case; a horizontal rule signs as nothing at all, since remembering one would quietly delete every rule in the digest. Capped at 500 per filter, oldest dropped |
| Print | `src-tauri/src/print.rs` | Writes the PDF to the temp directory (under a bare file name — the UI doesn't get to name a path) and hands it to the platform: on macOS, Preview's own `print … with print dialog`, falling back to simply opening the file if automation is refused; `Start-Process -Verb Print` on Windows; the default viewer on Linux. Deliberately the dialog rather than a job fired at the default printer — this app makes booklets, and the duplex and paper settings are exactly what the dialog is for |
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
- **Print…** writes the digest to the system temp directory so the platform's
  print flow has a file to take, and leaves it there for the printer to finish
  with. It never goes anywhere else.
- The AI agent is entirely opt-in and per-filter. When a filter has it on,
  the content of the mail that filter found is sent to the Anthropic API so
  the model can name the links it recommends. Mail no agentic filter found is
  never sent anywhere. The text of the linked pages is **not** sent — it is
  fetched after that call and goes straight into the digest. The API key is
  stored only on this device. Page fetches only request http(s) URLs and refuse
  private/loopback addresses, both for the link itself and for wherever it
  redirects.
