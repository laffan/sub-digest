import { CREDIT_HEADING, coverCredit } from "../met";
import type { CoverArtwork, ExportFormat } from "../types";

interface Props {
  /** Whether the digest opens with a cover and contents at all. */
  enabled: boolean;
  onEnabledChange: (on: boolean) => void;
  theme: string;
  onThemeChange: (theme: string) => void;
  searching: boolean;
  /** The theme the pieces on screen came back from, once a search has run. */
  searched: string;
  resultCount: number;
  cover: CoverArtwork | null;
  onSearch: () => void;
  onClear: () => void;
  format: ExportFormat;
}

/**
 * The Cover step: think up a theme for the issue, and that word is what the
 * Metropolitan Museum's open collection is searched with. The grid of what it
 * found is in the preview beside this, each one shown as the cover it would
 * make; this column is the search, and the credit for whichever was chosen.
 */
export function CoverPanel({
  enabled,
  onEnabledChange,
  theme,
  onThemeChange,
  searching,
  searched,
  resultCount,
  cover,
  onSearch,
  onClear,
  format,
}: Props) {
  return (
    <section className="panel cover-panel">
      <h2 className="col-title">Cover</h2>

      <label className="check">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onEnabledChange(e.target.checked)}
        />
        Cover and contents
      </label>
      <p className="hint">
        {format === "pdf"
          ? "The digest opens on a picture, and the contents follow inside it."
          : "The book opens on a picture, and the contents follow it. A reading device owns " +
            "its own page shape, so the e-book uses the whole picture rather than the crop " +
            "shown here."}
      </p>

      <form
        className="theme-row"
        onSubmit={(e) => {
          e.preventDefault();
          onSearch();
        }}
      >
        <input
          type="search"
          placeholder="Theme of this issue"
          value={theme}
          disabled={!enabled}
          onChange={(e) => onThemeChange(e.target.value)}
          aria-label="Theme of this issue"
        />
        <button
          className="secondary"
          type="submit"
          disabled={!enabled || searching || theme.trim().length === 0}
        >
          {searching ? "Searching…" : "Search"}
        </button>
      </form>

      <p className="hint">
        A word or two for what this issue is about — <em>harvest</em>, <em>night work</em>,{" "}
        <em>machines at rest</em>. It's the term the{" "}
        <span className="nowrap">Metropolitan Museum's</span> open collection is searched with,
        and every piece it can offer is one anyone is free to print.
      </p>

      {searched && !searching && (
        <p className="hint">
          {resultCount === 0
            ? `Nothing open-access came back for “${searched}”. Try another word.`
            : `${resultCount} piece${resultCount === 1 ? "" : "s"} for “${searched}”. Pick one ` +
              `from the grid; each is shown as the cover it would make.`}
        </p>
      )}

      {cover && (
        <div className="cover-chosen">
          <p className="credit-head">{CREDIT_HEADING}</p>
          {coverCredit(cover).map((line, i) => (
            <p key={i} className={`credit-${line.weight}`}>
              {line.text}
            </p>
          ))}
          {cover.objectUrl && <p className="cover-url">{cover.objectUrl}</p>}
          <button className="tool-btn" onClick={onClear}>
            Use no picture
          </button>
        </div>
      )}
    </section>
  );
}
