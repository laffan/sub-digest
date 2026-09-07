import type { ReactNode } from "react";
import { CUSTOM_RANGE, type DateRange } from "../types";

interface Props {
  days: number;
  range: DateRange;
  rangeValid: boolean;
  onDaysChange: (days: number) => void;
  onRangeChange: (range: DateRange) => void;
  /** The button that runs the collection, on the same line as the timeframe. */
  children?: ReactNode;
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

/**
 * How far back a session reaches. It belongs to the session rather than to any
 * one input: a timeframe means the same thing whether it's being applied to a
 * mailbox or to a list kept on a site, so both inputs take it from here.
 */
export function TimeframePicker({
  days,
  range,
  rangeValid,
  onDaysChange,
  onRangeChange,
  children,
}: Props) {
  const usingRange = days === CUSTOM_RANGE;

  return (
    <>
      <div className="scan-row">
        <select
          value={days}
          onChange={(e) => onDaysChange(Number(e.target.value))}
          aria-label="Timeframe"
        >
          {TIMEFRAMES.map((t) => (
            <option key={t.days} value={t.days}>
              {t.label}
            </option>
          ))}
        </select>
        {children}
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
        <p className="hint warn">Pick a start and end date (start first) to collect a range.</p>
      )}
    </>
  );
}
