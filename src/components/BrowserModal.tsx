import { useCallback, useEffect, useRef, useState } from "react";
import { savedBack, savedBounds, savedClose, savedOpen } from "../saved";

interface Props {
  /** Where the browser opens. */
  url: string;
  /** True while the page is being read, which is not instant on a long list. */
  capturing: boolean;
  /** What the last attempt to read the page had to say, if it didn't take. */
  notice: string | null;
  /** **Use this page**: read the list in front of the user. */
  onCapture: () => void;
  onClose: () => void;
}

/**
 * The in-app browser, framed.
 *
 * This modal is chrome and nothing else: the page itself is a real webview
 * owned by the backend, overlaid on the rectangle the body below occupies and
 * moved with it. That's why the body is empty — there is nothing to render into
 * it, and anything drawn there would be underneath the browser anyway.
 *
 * The point of it is that signing in is the site's business rather than ours.
 * Password manager, two-factor, single sign-on, a captcha: whatever the site
 * asks for happens in a real browser, and the app waits until you say the page
 * in front of you is the one you meant.
 */
export function BrowserModal({ url, capturing, notice, onCapture, onClose }: Props) {
  // The site it opened at. Where the user navigates from there is theirs to
  // see in the page itself; this is a label, not an address bar.
  const name = (() => {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return url;
    }
  })();
  const bodyRef = useRef<HTMLDivElement>(null);
  const [opened, setOpened] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = useCallback(() => {
    void savedClose().catch(() => {});
    onClose();
  }, [onClose]);

  // Open the browser over the body area, once.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    savedOpen(url, { x: r.left, y: r.top, w: r.width, h: r.height })
      .then(() => setOpened(true))
      .catch((e) => setError(String(e)));
    return () => {
      void savedClose().catch(() => {});
    };
    // Opening is a one-off: the browser navigates itself from here on, and
    // reopening it on every render would throw away where the user had got to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the browser glued to the body rect.
  useEffect(() => {
    if (!opened) return;
    const el = bodyRef.current;
    if (!el) return;
    const sync = () => {
      const r = el.getBoundingClientRect();
      void savedBounds({ x: r.left, y: r.top, w: r.width, h: r.height }).catch(() => {});
    };
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    window.addEventListener("resize", sync);
    sync();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", sync);
    };
  }, [opened]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  return (
    <div className="modal-backdrop">
      <div className="modal modal-browser" role="dialog" aria-modal="true" aria-label={name}>
        <div className="browser-head">
          <span className="browser-title" title={url}>
            {name}
          </span>
          <button
            className="secondary"
            onClick={() => void savedBack().catch(() => {})}
            disabled={!opened || capturing}
          >
            ← Back
          </button>
          <button
            className="primary"
            onClick={onCapture}
            disabled={!opened || capturing}
            title="Take the articles listed on the page you're looking at"
          >
            {capturing ? "Reading…" : "Use this page"}
          </button>
          <button className="icon-btn" onClick={close} aria-label="Close the browser">
            ✕
          </button>
        </div>

        <div className="browser-body" ref={bodyRef}>
          {!opened && !error && <p className="hint browser-placeholder">Opening…</p>}
          {error && (
            <div className="browser-placeholder">
              <p className="error">{error}</p>
              <p className="hint">
                The in-app browser couldn't open. Sign in to the site in your own browser and use
                the Gmail input instead, or try again.
              </p>
            </div>
          )}
        </div>

        {notice ? (
          <p className="browser-foot error">{notice}</p>
        ) : (
          <p className="browser-foot hint">
            Sign in, then go to the list you want — scroll to the bottom if it loads as you go,
            since what's read is what the page is showing. Then <strong>Use this page</strong>.
          </p>
        )}
      </div>
    </div>
  );
}
