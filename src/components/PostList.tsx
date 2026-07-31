import { useMemo, useRef, useState } from "react";
import { activeFilters, filterIsEmpty, filterLabel, filterSummary } from "../filters";
import {
  CUSTOM_RANGE,
  type DateRange,
  type MailFilter,
  type Post,
  type Publication,
} from "../types";

interface Props {
  posts: Post[];
  days: number;
  range: DateRange;
  rangeValid: boolean;
  scanning: boolean;
  /** Ids of posts the agent will read, from the filter that found each. */
  agentPosts: ReadonlySet<string>;
  /** Every saved filter; a scan uses the enabled ones. */
  filters: MailFilter[];
  /** Posts read in an earlier session — shown at half strength, nothing more. */
  processed: ReadonlySet<string>;
  onDaysChange: (days: number) => void;
  onRangeChange: (range: DateRange) => void;
  onToggleFilter: (id: string, enabled: boolean) => void;
  onEditFilters: () => void;
  onScan: () => void;
  onTogglePost: (id: string) => void;
  onSetPostsSelected: (ids: string[], selected: boolean) => void;
  onTogglePublication: (name: string, selected: boolean) => void;
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
  agentPosts,
  filters,
  processed,
  onDaysChange,
  onRangeChange,
  onToggleFilter,
  onEditFilters,
  onScan,
  onTogglePost,
  onSetPostsSelected,
  onTogglePublication,
}: Props) {
  const [filtersOpen, setFiltersOpen] = useState(false);
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
  // What a scan would actually use: enabled, and with something to match on.
  const willScanWith = useMemo(() => activeFilters(filters), [filters]);

  return (
    <section className="panel posts">
      <div className="posts-head">
        <h2 className="col-title">Posts</h2>
        <div className="filters-anchor">
          <button
            className={`filters-btn${filtersOpen ? " active" : ""}`}
            onClick={() => setFiltersOpen((v) => !v)}
            aria-expanded={filtersOpen}
            title="Which filters a scan uses"
          >
            Filters
            <span className="filters-count">
              {willScanWith.length}/{filters.length}
            </span>
          </button>

          {filtersOpen && (
            <>
              <div className="menu-scrim" onClick={() => setFiltersOpen(false)} />
              <div className="filter-menu" role="menu">
                {filters.length === 0 ? (
                  <p className="hint filter-menu-empty">No filters yet.</p>
                ) : (
                  <ul className="filter-menu-list">
                    {filters.map((f) => (
                      <li key={f.id}>
                        <label className="menu-check">
                          <input
                            type="checkbox"
                            checked={f.enabled}
                            onChange={(e) => onToggleFilter(f.id, e.target.checked)}
                          />
                          <span className="filter-menu-text">
                            <span className="filter-menu-name">
                              {filterLabel(f)}
                              {f.useAgent && (
                                <span className="agent-tag" title="Read by the AI agent">
                                  agent
                                </span>
                              )}
                            </span>
                            <span className="filter-menu-summary">{filterSummary(f)}</span>
                          </span>
                        </label>
                        {f.enabled && filterIsEmpty(f) && (
                          <span className="filter-menu-warn">nothing to match on</span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                <button
                  className="menu-item edit-filters"
                  onClick={() => {
                    setFiltersOpen(false);
                    onEditFilters();
                  }}
                >
                  Edit Filters…
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="scan-row">
        <select value={days} onChange={(e) => onDaysChange(Number(e.target.value))}>
          {TIMEFRAMES.map((t) => (
            <option key={t.days} value={t.days}>
              {t.label}
            </option>
          ))}
        </select>
        <button
          className="secondary"
          disabled={scanning || !rangeValid || willScanWith.length === 0}
          onClick={onScan}
          title={
            willScanWith.length === 0 ? "Enable a filter to scan with" : "Search your whole mailbox"
          }
        >
          {scanning ? "Scanning…" : "Scan Mail"}
        </button>
      </div>

      {willScanWith.length === 0 && (
        <p className="hint warn">
          {filters.length === 0
            ? "No filters yet — add one under Filters to scan."
            : "No filter is enabled — pick one under Filters to scan."}
        </p>
      )}

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

      {posts.length === 0 && !scanning && willScanWith.length > 0 && (
        <p className="hint">
          Scan your mail for anything your filters match (archived mail included).
        </p>
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
          // How many of these the agent will read, rather than the parser.
          const agentic = pub.posts.filter((p) => agentPosts.has(p.id)).length;
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
                {agentic > 0 && (
                  <span
                    className="agent-tag"
                    title={
                      agentic === pub.posts.length
                        ? "Read by the AI agent"
                        : `${agentic} of ${pub.posts.length} read by the AI agent`
                    }
                  >
                    agent{agentic < pub.posts.length ? ` ${agentic}` : ""}
                  </span>
                )}
                <span className="pub-count">{pub.posts.length}</span>
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
