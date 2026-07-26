import type { DigestPost } from "../types";
import { formatShortDate } from "../dates";

interface Props {
  posts: DigestPost[];
  /** How many posts have been prepared so far, out of how many were selected. */
  done: number;
  total: number;
  preparing: boolean;
  onMove: (index: number, delta: number) => void;
}

/**
 * The running order of the digest, filling in as each post is prepared. This is
 * the order the PDF and EPUB use, so moving a row here moves it in the output.
 */
export function OrganizePanel({ posts, done, total, preparing, onMove }: Props) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <section className="panel organize">
      <h2 className="col-title">Organize</h2>

      <div className="prepare-status">
        <div className="prepare-line">
          {preparing ? `Preparing ${Math.min(done + 1, total)} of ${total}…` : `${total} posts ready`}
        </div>
        <div className="prepare-track">
          <div className="prepare-bar" style={{ width: `${pct}%` }} />
        </div>
      </div>

      <ol className="toc">
        {posts.map((post, i) => (
          <li className="toc-row" key={`${post.title}-${post.dateMs}`}>
            <span className="toc-num">{i + 1}</span>
            <div className="toc-text">
              <div className="toc-title" title={post.title}>
                {post.title}
              </div>
              <div className="toc-meta">
                {post.publication} · {formatShortDate(post.dateMs)} · {post.blocks.length} blocks
              </div>
            </div>
            <div className="toc-moves">
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
        ))}
      </ol>

      {posts.length > 0 && (
        <p className="hint">Use ↑ ↓ to set the order posts appear in the digest.</p>
      )}
    </section>
  );
}
