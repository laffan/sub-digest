import { useState } from "react";
import { EXAMPLE_URL, isOpenable, normalizeUrl, siteDetail, type SavedSite } from "../sites";

interface Props {
  /** Sites already signed in to, newest first. */
  sites: SavedSite[];
  /** The one picked, by domain. */
  domain: string;
  onDomainChange: (domain: string) => void;
  /** Opens the browser at an address — a known site's, or a newly typed one. */
  onOpen: (url: string) => void;
  onForget: (domain: string) => void;
  /** How many of the page's articles to take, newest first; 0 means all. */
  cap: number;
  onCapChange: (cap: number) => void;
  /** What the last capture said it read, for the line under the button. */
  captured: { count: number; from: string } | null;
}

/**
 * How many articles one capture takes, off the top of the page. A saved list is
 * kept in the order the site keeps it — usually newest first — and that order is
 * the only claim about recency worth trusting here: most sites don't date the
 * rows on a saved page at all.
 */
const CAPS = [10, 20, 30, 50, 100, 0];

function capLabel(cap: number): string {
  return cap === 0 ? "Everything on the page" : `${cap} most recent`;
}

/**
 * The saved-list input: open a site, and bring back what's on the page you land
 * on.
 *
 * There's no sign-in here and nothing to configure. The first time, you give it
 * an address; you sign in inside the browser it opens, press **Use this page**,
 * and the site is in the picker from then on. So the list below is a record of
 * where you've actually been rather than a set of bookmarks to maintain.
 */
export function SavedPanel({
  sites,
  domain,
  onDomainChange,
  onOpen,
  onForget,
  cap,
  onCapChange,
  captured,
}: Props) {
  // With no sites yet there's nothing to pick, so the form *is* the panel.
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState("");

  const site = sites.find((s) => s.domain === domain) ?? sites[0];
  const showForm = adding || sites.length === 0;
  const canOpen = isOpenable(normalizeUrl(url));

  const openTyped = () => {
    if (!canOpen) return;
    onOpen(normalizeUrl(url));
    setUrl("");
    setAdding(false);
  };

  return (
    <section className="panel saved">
      <div className="posts-head">
        <h2 className="col-title">Saved List</h2>
        {sites.length > 0 && (
          <button
            className={`filters-btn${adding ? " active" : ""}`}
            onClick={() => setAdding((v) => !v)}
            aria-expanded={adding}
            title="Sign in to another site"
          >
            {adding ? "Cancel" : "Another site"}
          </button>
        )}
      </div>

      {showForm ? (
        <form
          className="add-source"
          onSubmit={(e) => {
            e.preventDefault();
            openTyped();
          }}
        >
          <label>
            The page your list is on
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={EXAMPLE_URL}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </label>
          <button className="primary wide-btn" type="submit" disabled={!canOpen}>
            Open and sign in
          </button>
          <p className="hint">
            It opens in a browser here. Sign in as you normally would, go to your saved posts, and
            press <strong>Use this page</strong> — the site is remembered once that works.
            Substack's is <code>{EXAMPLE_URL}</code>.
          </p>
        </form>
      ) : (
        <>
          <label>
            Site
            <select value={site?.domain ?? ""} onChange={(e) => onDomainChange(e.target.value)}>
              {sites.map((s) => (
                <option key={s.domain} value={s.domain}>
                  {s.domain}
                </option>
              ))}
            </select>
          </label>
          {site && <p className="hint list-detail">Last read from {siteDetail(site)}</p>}

          <label>
            Take
            <select value={cap} onChange={(e) => onCapChange(Number(e.target.value))}>
              {CAPS.map((n) => (
                <option key={n} value={n}>
                  {capLabel(n)}
                </option>
              ))}
            </select>
          </label>

          <button
            className="primary wide-btn"
            onClick={() => site && onOpen(site.url)}
            disabled={!site}
          >
            Open {site?.domain ?? "the site"}…
          </button>

          {captured ? (
            <p className="hint">
              Read {captured.count} article{captured.count === 1 ? "" : "s"} off{" "}
              <span className="captured-from">{captured.from}</span>. Opening it again replaces
              them.
            </p>
          ) : (
            <p className="hint">
              You're still signed in. Go to the list, scroll far enough back, and press{" "}
              <strong>Use this page</strong>.
            </p>
          )}

          {site && (
            <div className="source-actions">
              <button
                className="link danger"
                onClick={() => onForget(site.domain)}
                title="Forget this site and the session kept for it"
              >
                Forget {site.domain}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
