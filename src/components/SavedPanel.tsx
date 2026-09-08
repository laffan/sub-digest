import { useState } from "react";
import { domainFromUrl, sourceIsUsable, sourceLabel, type SavedSource } from "../sources";
import { TimeframePicker } from "./TimeframePicker";
import type { DateRange } from "../types";

interface Props {
  sources: SavedSource[];
  sourceId: string;
  onSourceChange: (id: string) => void;
  onAddSource: (name: string, url: string) => void;
  onRemoveSource: (id: string) => void;
  /** The domain this site has a session kept for, or null. */
  session: string | null;
  onForgetSession: () => void;
  onOpenBrowser: () => void;
  /** What the last capture said it read, for the line under the button. */
  captured: { count: number; from: string } | null;
  days: number;
  range: DateRange;
  rangeValid: boolean;
  onDaysChange: (days: number) => void;
  onRangeChange: (range: DateRange) => void;
}

/**
 * The saved-list input: pick a site, open it, and bring back what's on the page
 * you land on.
 *
 * There is no sign-in here, which is the point — signing in happens in the
 * browser the button opens, the way it happens everywhere else. What this panel
 * holds is the short list of sites you go to and the timeframe the articles are
 * held to.
 */
export function SavedPanel({
  sources,
  sourceId,
  onSourceChange,
  onAddSource,
  onRemoveSource,
  session,
  onForgetSession,
  onOpenBrowser,
  captured,
  days,
  range,
  rangeValid,
  onDaysChange,
  onRangeChange,
}: Props) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");

  const source = sources.find((s) => s.id === sourceId) ?? sources[0];
  const canAdd = /^https?:\/\/\S+$/i.test(url.trim());

  const add = () => {
    if (!canAdd) return;
    onAddSource(name.trim() || domainFromUrl(url), url.trim());
    setName("");
    setUrl("");
    setAdding(false);
  };

  return (
    <section className="panel saved">
      <div className="posts-head">
        <h2 className="col-title">Saved List</h2>
        <button
          className={`filters-btn${adding ? " active" : ""}`}
          onClick={() => setAdding((v) => !v)}
          aria-expanded={adding}
          title="Add another site"
        >
          {adding ? "Cancel" : "Add site"}
        </button>
      </div>

      {adding ? (
        <form
          className="add-source"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <label>
            The list's address
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/reading-list"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </label>
          <label>
            What to call it
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={domainFromUrl(url) || "Example"}
              spellCheck={false}
            />
          </label>
          <button className="secondary wide-btn" type="submit" disabled={!canAdd}>
            Add
          </button>
          <p className="hint">
            Any page of links behind a login. It's only where the browser opens — you can navigate
            anywhere from there.
          </p>
        </form>
      ) : sources.length === 0 ? (
        <p className="hint">No sites yet — add the page your saved list lives on.</p>
      ) : (
        <>
          <label>
            Site
            <select value={source?.id ?? ""} onChange={(e) => onSourceChange(e.target.value)}>
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {sourceLabel(s)}
                </option>
              ))}
            </select>
          </label>

          <button
            className="primary wide-btn"
            onClick={onOpenBrowser}
            disabled={!source || !sourceIsUsable(source)}
            title={
              source && sourceIsUsable(source)
                ? `Open ${sourceLabel(source)} and pick a list`
                : "This site has no address to open"
            }
          >
            Open {source ? sourceLabel(source) : "the site"}…
          </button>

          {captured ? (
            <p className="hint">
              Read {captured.count} article{captured.count === 1 ? "" : "s"} off{" "}
              <span className="captured-from">{captured.from}</span>. Open it again to add a
              different list — a new capture replaces this one.
            </p>
          ) : (
            <p className="hint">
              Sign in there as you normally would, go to your saved posts, and press{" "}
              <strong>Use this page</strong>. What's on the page is what comes back.
            </p>
          )}

          <TimeframePicker
            days={days}
            range={range}
            rangeValid={rangeValid}
            onDaysChange={onDaysChange}
            onRangeChange={onRangeChange}
          />
          <p className="hint">
            Articles the page dated are held to this; ones it didn't date are always kept.
          </p>

          <div className="source-actions">
            {session && (
              <button
                className="link"
                onClick={onForgetSession}
                title={`Discard the ${session} session kept for fetching articles`}
              >
                Forget the {session} session
              </button>
            )}
            {source && (
              <button className="link danger" onClick={() => onRemoveSource(source.id)}>
                Remove this site
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
