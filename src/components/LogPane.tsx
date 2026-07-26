import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { clearLog, logAsText, timestamp, useLog } from "../log";

interface Props {
  onClose: () => void;
}

/** The log drawer across the foot of the window: progress, errors, agent chatter. */
export function LogPane({ onClose }: Props) {
  const entries = useLog();
  const listRef = useRef<HTMLDivElement>(null);
  // Follow the tail, unless the user has scrolled up to read something.
  const pinned = useRef(true);
  const [copied, setCopied] = useState(false);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [entries]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(logAsText());
      setCopied(true);
    } catch {
      // Clipboard access can be refused; the text is on screen either way.
      setCopied(false);
    }
  };

  return (
    <section className="log-pane" aria-label="Log">
      <header className="log-header">
        <span className="log-title">Log</span>
        <span className="log-count">{entries.length}</span>
        <div className="log-actions">
          <button className="link" onClick={copy} disabled={entries.length === 0}>
            {copied ? "Copied" : "Copy"}
          </button>
          <button className="link" onClick={clearLog} disabled={entries.length === 0}>
            Clear
          </button>
          <button className="icon-btn small" onClick={onClose} aria-label="Hide log" title="Hide log">
            <CloseIcon />
          </button>
        </div>
      </header>
      <div className="log-lines" ref={listRef} onScroll={onScroll}>
        {entries.length === 0 ? (
          <p className="log-empty">
            Nothing logged yet. Scanning, generation and agent activity show up here.
          </p>
        ) : (
          entries.map((e) => (
            <div className={`log-line ${e.level}`} key={e.id}>
              <span className="log-time">{timestamp(e.ts)}</span>
              <span className="log-source">{e.source}</span>
              <span className="log-message">{e.message}</span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M6 6l12 12M18 6L6 18"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
