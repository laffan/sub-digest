import { useMemo, useState } from "react";
import { activeFilters, filterIsEmpty, filterLabel, filterSummary } from "../filters";
import { TimeframePicker } from "./TimeframePicker";
import type { DateRange, MailFilter } from "../types";

interface Props {
  days: number;
  range: DateRange;
  rangeValid: boolean;
  scanning: boolean;
  /** Every saved filter; a scan uses the enabled ones. */
  filters: MailFilter[];
  /** Whether anything has been found yet, for the hint under the controls. */
  found: number;
  onDaysChange: (days: number) => void;
  onRangeChange: (range: DateRange) => void;
  onToggleFilter: (id: string, enabled: boolean) => void;
  onEditFilters: () => void;
  onScan: () => void;
}

/**
 * The Gmail input: which filters a scan uses, how far back it reaches, and the
 * button that runs it. What it finds is shown by `PostList`, which both inputs
 * share — this panel is only the part that's about mail.
 */
export function MailPanel({
  days,
  range,
  rangeValid,
  scanning,
  filters,
  found,
  onDaysChange,
  onRangeChange,
  onToggleFilter,
  onEditFilters,
  onScan,
}: Props) {
  const [filtersOpen, setFiltersOpen] = useState(false);
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

      <TimeframePicker
        days={days}
        range={range}
        rangeValid={rangeValid}
        onDaysChange={onDaysChange}
        onRangeChange={onRangeChange}
      >
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
      </TimeframePicker>

      {willScanWith.length === 0 && (
        <p className="hint warn">
          {filters.length === 0
            ? "No filters yet — add one under Filters to scan."
            : "No filter is enabled — pick one under Filters to scan."}
        </p>
      )}

      {found === 0 && !scanning && willScanWith.length > 0 && (
        <p className="hint">
          Scan your mail for anything your filters match (archived mail included).
        </p>
      )}
    </section>
  );
}
