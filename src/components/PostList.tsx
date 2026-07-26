import { useMemo, useRef, useState } from "react";
import { CUSTOM_RANGE, type AgentConfig, type DateRange, type Post, type Publication } from "../types";

interface Props {
  posts: Post[];
  days: number;
  range: DateRange;
  rangeValid: boolean;
  scanning: boolean;
  agentConfigs: Record<string, AgentConfig>;
  /** Posts read in an earlier session — shown at half strength, nothing more. */
  processed: ReadonlySet<string>;
  onDaysChange: (days: number) => void;
  onRangeChange: (range: DateRange) => void;
  onScan: () => void;
  onTogglePost: (id: string) => void;
  onSetPostsSelected: (ids: string[], selected: boolean) => void;
  onTogglePublication: (name: string, selected: boolean) => void;
  onToggleAgent: (name: string, useAgent: boolean) => void;
  onOpenAgentOptions: (name: string) => void;
}

// `days: 0` means no lower bound — search the entire archive.
// `days: CUSTOM_RANGE` swaps the timeframe for an explicit start/end date.
const TIMEFRAMES: { label: string; days: number }[] = [
  { label: "Last 7 days", days: 7 },
  { label: "Last 14 days", days: 14 },
  { label: "Last 30 days", days: 30 },
  { label: "Last 3 months", days: 90 },
  { label: "Last 6 months", days: 183 },
  { label: "Last year", days: 365 },
  { label: "Last 2 years", days: 730 },
  { label: "All time", days: 0 },
  { label: "Range…", days: CUSTOM_RANGE },
];

/** Matches MAX_MESSAGES in the Rust backend. */
const SCAN_LIMIT = 1000;

export function PostList({
  posts,
  days,
  range,
  rangeValid,
  scanning,
  agentConfigs,
  processed,
  onDaysChange,
  onRangeChange,
  onScan,
  onTogglePost,
  onSetPostsSelected,
  onTogglePublication,
  onToggleAgent,
  onOpenAgentOptions,
}: Props) {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  // The post a shift-click extends the selection from: the last one clicked.
  const anchorId = useRef<string | null>(null);
  // A checkbox's change event carries no modifier keys, and React derives that
  // event from the click — so the click handler stashes shift for it to read.
  const shiftHeld = useRef(false);

  const publications = useMemo<Publication[]>(() => {
    const byName = new Map<string, Post[]>();
    for (const p of posts) {
      const list = byName.get(p.publication) ?? [];
      list.push(p);
      byName.set(p.publication, list);
    }
    return [...byName.entries()]
      .map(([name, ps]) => ({ name, posts: ps }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [posts]);

  // Ids in the order they appear on screen, so a shift-click range covers
  // exactly what the user sees between the two clicks.
  const orderedIds = useMemo(
    () => publications.flatMap((pub) => pub.posts.map((p) => p.id)),
    [publications]
  );

  /** Extends the selection from the anchor to `id`; returns false if it can't. */
  const extendSelection = (id: string, selected: boolean): boolean => {
    const anchor = anchorId.current;
    if (anchor === null || anchor === id) return false;
    const from = orderedIds.indexOf(anchor);
    const to = orderedIds.indexOf(id);
    if (from < 0 || to < 0) return false;
    const [lo, hi] = from < to ? [from, to] : [to, from];
    onSetPostsSelected(orderedIds.slice(lo, hi + 1), selected);
    return true;
  };

  const usingRange = days === CUSTOM_RANGE;

  return (
    <section className="panel posts">
      <h2 className="col-title">Posts</h2>
      <div className="scan-row">
        <select value={days} onChange={(e) => onDaysChange(Number(e.target.value))}>
          {TIMEFRAMES.map((t) => (
            <option key={t.days} value={t.days}>
              {t.label}
            </option>
          ))}
        </select>
        <button className="secondary" disabled={scanning || !rangeValid} onClick={onScan}>
          {scanning ? "Scanning…" : "Scan Mail"}
        </button>
      </div>

      {usingRange && (
        <div className="range-row">
          <label>
            From
            <input
              type="date"
              value={range.start}
              max={range.end || undefined}
              onChange={(e) => onRangeChange({ ...range, start: e.target.value })}
            />
          </label>
          <label>
            To
            <input
              type="date"
              value={range.end}
              min={range.start || undefined}
              onChange={(e) => onRangeChange({ ...range, end: e.target.value })}
            />
          </label>
        </div>
      )}

      {usingRange && !rangeValid && (
        <p className="hint warn">Pick a start and end date (start first) to scan a range.</p>
      )}

      {posts.length === 0 && !scanning && (
        <p className="hint">Scan your mail to discover Substack posts (archived included).</p>
      )}

      {posts.length > 0 && (
        <p className="hint">Shift-click to select through to your last click.</p>
      )}

      {posts.length >= SCAN_LIMIT && (
        <p className="hint">
          Showing the first {SCAN_LIMIT.toLocaleString()} matches — narrow the timeframe to
          reach older ones.
        </p>
      )}

      <div className="pub-list">
        {publications.map((pub) => {
          const all = pub.posts.every((p) => p.selected);
          const some = pub.posts.some((p) => p.selected);
          const agent = agentConfigs[pub.name];
          const useAgent = agent?.useAgent ?? false;
          const menuOpen = openMenu === pub.name;
          return (
            <div className="pub" key={pub.name}>
              <div className="pub-header">
                <label className="pub-check">
                  <input
                    type="checkbox"
                    checked={all}
                    ref={(el) => {
                      if (el) el.indeterminate = some && !all;
                    }}
                    onChange={(e) => onTogglePublication(pub.name, e.target.checked)}
                  />
                  <span className="pub-name">{pub.name}</span>
                </label>
                <span className="pub-count">{pub.posts.length}</span>
                <button
                  className={`pub-menu-btn${useAgent ? " active" : ""}`}
                  aria-label={`Agent menu for ${pub.name}`}
                  aria-expanded={menuOpen}
                  title={useAgent ? "Agent enabled" : "Agent options"}
                  onClick={() => setOpenMenu(menuOpen ? null : pub.name)}
                >
                  <CaretIcon />
                </button>

                {menuOpen && (
                  <>
                    <div className="menu-scrim" onClick={() => setOpenMenu(null)} />
                    <div className="pub-menu" role="menu">
                      <label className="menu-check">
                        <input
                          type="checkbox"
                          checked={useAgent}
                          onChange={(e) => onToggleAgent(pub.name, e.target.checked)}
                        />
                        Use Agent
                      </label>
                      <button
                        className="menu-item"
                        disabled={!useAgent}
                        onClick={() => {
                          setOpenMenu(null);
                          onOpenAgentOptions(pub.name);
                        }}
                      >
                        Agent options…
                      </button>
                    </div>
                  </>
                )}
              </div>
              <ul>
                {pub.posts.map((p) => (
                  <li key={p.id} className={processed.has(p.id) ? "seen" : undefined}>
                    <label
                      title={
                        processed.has(p.id) ? "Already processed in an earlier session" : undefined
                      }
                    >
                      <input
                        type="checkbox"
                        checked={p.selected}
                        onClick={(e) => {
                          shiftHeld.current = e.shiftKey;
                        }}
                        // A shift-click gives every post back to the last one
                        // clicked the state this click produces here — which is
                        // also the state the browser just toggled this box to,
                        // so the checkbox and the range stay in agreement.
                        onChange={() => {
                          const shift = shiftHeld.current;
                          shiftHeld.current = false;
                          if (!shift || !extendSelection(p.id, !p.selected)) {
                            onTogglePost(p.id);
                          }
                          anchorId.current = p.id;
                        }}
                      />
                      <span className="post-title" title={p.subject}>
                        {p.subject}
                      </span>
                      <span className="post-date">
                        {new Date(p.dateMs).toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                        })}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function CaretIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
