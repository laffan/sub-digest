import { useEffect, useRef, useState } from "react";
import { imageObjectUrl } from "../images";
import { PAGE_POINTS, type CoverArtwork, type FontFamily, type PageSizeName } from "../types";

interface Props {
  /** Whether the digest opens with a cover at all; off, there's nothing to pick. */
  enabled: boolean;
  results: CoverArtwork[];
  searching: boolean;
  /** The theme these came back from; empty before the first search. */
  searched: string;
  chosen: CoverArtwork | null;
  onChoose: (art: CoverArtwork) => void;
  /** The page the cover will be printed on, so the crop shown is the real one. */
  pageSize: PageSizeName;
  /** The digest's own font, so the masthead here is the one that will print. */
  font: FontFamily;
  /** The line under the wordmark: the issue's date span and what's in it. */
  issueLine: string;
}

/** The webview's nearest equivalent of the PDF's three standard fonts. */
const FONT_STACKS: Record<FontFamily, string> = {
  Times: '"Times New Roman", Times, serif',
  Helvetica: '"Helvetica Neue", Helvetica, Arial, sans-serif',
  Courier: '"Courier New", Courier, monospace',
};

/**
 * The pieces a theme turned up, each shown as the cover it would make: cropped
 * to the page the digest prints on, with the masthead over the top of it. What
 * you pick is what comes out, so there's nothing to imagine.
 */
export function CoverGallery({
  enabled,
  results,
  searching,
  searched,
  chosen,
  onChoose,
  pageSize,
  font,
  issueLine,
}: Props) {
  const [w, h] = PAGE_POINTS[pageSize];

  if (!enabled) {
    return (
      <div className="preview-empty">
        <p>No cover</p>
        <p className="hint">
          The digest starts on its first post, with no contents. Tick “Cover and contents”
          to open it on a picture instead.
        </p>
      </div>
    );
  }

  if (searching) {
    return (
      <div className="preview-empty">
        <p>Searching the Met</p>
        <p className="hint">Finding open-access pieces for “{searched}”.</p>
      </div>
    );
  }

  if (results.length === 0) {
    return (
      <div className="preview-empty">
        <p>{searched ? `Nothing for “${searched}”` : "A picture for the cover"}</p>
        <p className="hint">
          {searched
            ? "The museum has no open-access piece under that word. Try another."
            : "Think up a theme for this issue and search the Metropolitan Museum's collection " +
              "for it. What it finds appears here, each one cropped to the page and mastheaded, " +
              "so you're choosing the finished cover."}
        </p>
      </div>
    );
  }

  return (
    <div className="cover-gallery" style={{ fontFamily: FONT_STACKS[font] }}>
      {results.map((art) => {
        const picked = chosen?.objectId === art.objectId;
        return (
          <figure className="cover-cell" key={art.objectId}>
            <button
              type="button"
              className={`cover-option${picked ? " chosen" : ""}`}
              style={{ aspectRatio: `${w} / ${h}` }}
              aria-pressed={picked}
              onClick={() => onChoose(art)}
              title={picked ? "This is the cover" : "Make this the cover"}
            >
              <CoverImage src={art.thumbUrl} />
              <span className="cover-logo">
                <span className="cover-kicker">S U B S T A C K</span>
                <span className="cover-wordmark">Digest</span>
                <span className="cover-hr" />
                <span className="cover-issue">{issueLine}</span>
              </span>
            </button>
            <figcaption className="cover-caption">
              <span className="cover-caption-title">{art.title || "Untitled"}</span>
              <span className="cover-caption-meta">
                {[art.artist || "Unknown artist", art.date].filter(Boolean).join(" · ")}
              </span>
            </figcaption>
          </figure>
        );
      })}
    </div>
  );
}

/**
 * A candidate's picture, fetched through the backend once it's nearly on
 * screen — the same route the digest's own images take, so what the grid can
 * show is what the cover can print.
 */
function CoverImage({ src }: { src: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let live = true;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        observer.disconnect();
        imageObjectUrl(src)
          .then((got) => {
            if (!live) return;
            if (got) setUrl(got);
            else setFailed(true);
          })
          .catch(() => live && setFailed(true));
      },
      { rootMargin: "400px" }
    );
    observer.observe(el);
    return () => {
      live = false;
      observer.disconnect();
    };
  }, [src]);

  return (
    <span className="cover-frame" ref={ref}>
      {url ? (
        <img src={url} alt="" />
      ) : (
        <span className="cover-loading">{failed ? "unavailable" : "…"}</span>
      )}
    </span>
  );
}
