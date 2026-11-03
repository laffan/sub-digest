# Sub Digest

Collects your recent reading into a printable PDF booklet or an EPUB. The
reading comes from either the newsletters in your Gmail inbox (matched by
filters you set) or a saved list on a site such as Substack. For macOS and
iPadOS.

The Gmail input needs your own Google OAuth client ID and secret; the Saved
List input does not. Setup is described in [README_DETAIL.md](README_DETAIL.md#setup).

## Installation

Download the installer for your system from the
[Releases](../../releases) page: `.dmg` (macOS), `.msi` or `.exe` (Windows),
`.AppImage`, `.deb` or `.rpm` (Linux).

The builds are not code-signed. On macOS, if the app is blocked on first
launch, move it to Applications and run:

```sh
xattr -cr "/Applications/Sub Digest.app"
```

On Windows, choose "More info" then "Run anyway" when SmartScreen warns.

The release builds read the Gmail credentials from repository secrets (`VITE_GMAIL_CLIENT_ID`, `VITE_GMAIL_CLIENT_SECRET`).

### Build from source

Requires [Node.js](https://nodejs.org/), [Rust](https://rustup.rs/) and the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS.

```sh
npm install
npm run tauri build    # installers end up in src-tauri/target/release/bundle/
npm run tauri dev      # run in development
```

For Gmail, copy `.env.example` to `.env` and fill in your credentials before building.

## More detail

[README_DETAIL.md](README_DETAIL.md) covers filters, the saved-list input, OAuth setup, iPadOS and troubleshooting.
