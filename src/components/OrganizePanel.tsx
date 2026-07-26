import { byline, type DigestPost } from "../types";
import { formatShortDate } from "../dates";

interface Props {
  posts: DigestPost[];
  /** How many emails have been prepared so far, out of how many were selected. */
  done: number;
  total: number;
  preparing: boolean;
  /** Whether the strike-out tool is armed in the preview. */
  removing: boolean;
  removedCount: number;
  /** Blocks of this entry that survive into the output. */
  keptBlocks: (post: DigestPost) => number;
  onMove: (index: number, delta: number) => void;
  onFocus: (id: string) => void;
  onToggleRemoving: () => void;
  onRestoreAll: () => void;
}

/**
 * The running order of the digest, filling in as each entry is prepared. This
 * is the order the PDF and EPUB use, so moving a row here moves it in the
 * output — and the rows are the articles themselves, not the emails that
 * carried them, so a link roundup arrives as its pieces.
 */
export function OrganizePanel({
  posts,
  done,
  total,
  preparing,
  removing,
  removedCount,
  keptBlocks,
  onMove,
  onFocus,
  onToggleRemoving,
  onRestoreAll,
}: Props) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <section className="panel organize">
      <h2 className="col-title">Organize</h2>

      <div className="prepare-status">
        <div className="prepare-line">
          {preparing
            ? `Preparing ${Math.min(done + 1, total)} of ${total}…`
            : `${posts.length} entr${posts.length === 1 ? "y" : "ies"} ready`}
        </div>
        <div className="prepare-track">
          <div className="prepare-bar" style={{ width: `${pct}%` }} />
        </div>
      </div>

      {posts.length > 0 && (
        <div className="organize-tools">
          <button
            className={`tool-btn${removing ? " active" : ""}`}
            onClick={onToggleRemoving}
            aria-pressed={removing}
            title="Drag across the preview to strike material out; hold ⌥ to put it back"
          >
            {removing ? "Done removing" : "Remove content"}
          </button>
          {removedCount > 0 && (
            <button className="tool-btn" onClick={onRestoreAll}>
              Restore {removedCount}
            </button>
          )}
        </div>
      )}

      <ol className="toc">
        {posts.map((post, i) => {
          const kept = keptBlocks(post);
          return (
            <li
              className={`toc-row${kept === 0 ? " emptied" : ""}`}
              key={post.id}
              onClick={() => onFocus(post.id)}
              title="Show this in the preview"
            >
              <span className="toc-num">{i + 1}</span>
              <div className="toc-text">
                <div className="toc-title">{post.title}</div>
                <div className="toc-meta">
                  {byline(post)} · {formatShortDate(post.dateMs)} ·{" "}
                  {kept === post.blocks.length
                    ? `${kept} blocks`
                    : `${kept}/${post.blocks.length} blocks`}
                </div>
                {post.sourceUrl && <div className="toc-url">{post.sourceUrl}</div>}
              </div>
              <div className="toc-moves" onClick={(e) => e.stopPropagation()}>
                <button
                  className="move-btn"
                  aria-label={`Move "${post.title}" up`}
                  disabled={i === 0}
                  onClick={() => onMove(i, -1)}
                >
                  ↑
                </button>
                <button
                  className="move-btn"
                  aria-label={`Move "${post.title}" down`}
                  disabled={i === posts.length - 1}
                  onClick={() => onMove(i, 1)}
                >
                  ↓
                </button>
              </div>
            </li>
          );
        })}
      </ol>

      {posts.length > 0 && (
        <p className="hint">
          Click an entry to find it in the preview; ↑ ↓ set the order they appear in the digest.
        </p>
      )}
    </section>
  );
}
