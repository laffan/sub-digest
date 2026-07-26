import { useRef, useState } from "react";
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
  onReorder: (from: number, to: number) => void;
  onFocus: (id: string) => void;
  onToggleRemoving: () => void;
  onRestoreAll: () => void;
  onToggleEntry: (post: DigestPost) => void;
}

/** A drag in progress: where it started, and where the row would land. */
interface Drag {
  from: number;
  /** Insertion point in the current list, 0…length. */
  to: number;
}

/** How far the pointer must travel before a press counts as a drag, not a click. */
const DRAG_THRESHOLD = 4;

/**
 * The running order of the digest, filling in as each entry is prepared. This
 * is the order the PDF and EPUB use, so dragging a row here moves it in the
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
  onReorder,
  onFocus,
  onToggleRemoving,
  onRestoreAll,
  onToggleEntry,
}: Props) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const listRef = useRef<HTMLOListElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  // The press that might become a drag. Held in a ref so moving the pointer
  // doesn't re-render until it's travelled far enough to mean it.
  const pressRef = useRef<{ x: number; y: number; from: number; pointerId: number } | null>(null);

  /** Which slot the row would drop into, from where the pointer is. */
  const insertionAt = (clientY: number): number => {
    const rows = listRef.current?.querySelectorAll<HTMLElement>("li.toc-row");
    if (!rows) return 0;
    for (let i = 0; i < rows.length; i++) {
      const box = rows[i].getBoundingClientRect();
      if (clientY < box.top + box.height / 2) return i;
    }
    return rows.length;
  };

  /**
   * A press on the grip always starts a drag; a press anywhere else on the row
   * only does with a mouse, so a finger can still scroll the list.
   */
  const press = (e: React.PointerEvent, index: number, fromGrip: boolean) => {
    if (!fromGrip && e.pointerType !== "mouse") return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    pressRef.current = { x: e.clientX, y: e.clientY, from: index, pointerId: e.pointerId };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const move = (e: React.PointerEvent) => {
    const start = pressRef.current;
    if (!start || start.pointerId !== e.pointerId) return;
    if (!drag && Math.hypot(e.clientX - start.x, e.clientY - start.y) < DRAG_THRESHOLD) return;
    setDrag({ from: start.from, to: insertionAt(e.clientY) });
  };

  const release = (e: React.PointerEvent) => {
    const start = pressRef.current;
    pressRef.current = null;
    if (!start || start.pointerId !== e.pointerId) return;
    if (!drag) {
      // It never became a drag, so it was a click: show the entry instead.
      onFocus(posts[start.from].id);
      return;
    }
    const { from, to } = drag;
    setDrag(null);
    // `to` indexes the list as it stands, so landing just after the row it came
    // from — or on itself — changes nothing.
    if (to !== from && to !== from + 1) onReorder(from, to > from ? to - 1 : to);
  };

  const cancel = () => {
    pressRef.current = null;
    setDrag(null);
  };

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

      <ol className={`toc${drag ? " dragging" : ""}`} ref={listRef}>
        {posts.map((post, i) => {
          const kept = keptBlocks(post);
          const gone = kept === 0;
          const classes = [
            "toc-row",
            gone ? "emptied" : "",
            drag?.from === i ? "lifted" : "",
            drag?.to === i ? "drop-before" : "",
            drag?.to === posts.length && i === posts.length - 1 ? "drop-after" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <li
              className={classes}
              key={post.id}
              onPointerDown={(e) => press(e, i, false)}
              onPointerMove={move}
              onPointerUp={release}
              onPointerCancel={cancel}
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
              <div className="toc-actions">
                <button
                  className="grip"
                  aria-label={`Reorder "${post.title}"`}
                  title="Drag to reorder"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    press(e, i, true);
                  }}
                  onPointerMove={move}
                  onPointerUp={release}
                  onPointerCancel={cancel}
                  onClick={(e) => e.stopPropagation()}
                >
                  <GripIcon />
                </button>
                <button
                  className={`trash-btn${gone ? " active" : ""}`}
                  aria-pressed={gone}
                  aria-label={
                    gone ? `Put "${post.title}" back` : `Remove "${post.title}" from the output`
                  }
                  title={gone ? "Put this article back" : "Remove this article from the output"}
                  // Never let the row read this as a press of its own.
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleEntry(post);
                  }}
                >
                  <TrashIcon />
                </button>
              </div>
            </li>
          );
        })}
      </ol>

      {posts.length > 0 && (
        <p className="hint">
          Drag an entry to set where it lands in the digest; click one to find it in the preview.
        </p>
      )}
    </section>
  );
}

function GripIcon() {
  return (
    <svg width="12" height="14" viewBox="0 0 12 14" aria-hidden="true">
      <g fill="currentColor">
        <circle cx="4" cy="3" r="1.2" />
        <circle cx="8" cy="3" r="1.2" />
        <circle cx="4" cy="7" r="1.2" />
        <circle cx="8" cy="7" r="1.2" />
        <circle cx="4" cy="11" r="1.2" />
        <circle cx="8" cy="11" r="1.2" />
      </g>
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="12" height="14" viewBox="0 0 14 16" fill="none" aria-hidden="true">
      <path
        d="M2 4h10M5.5 4V2.5h3V4M3.5 4l.6 9.5h5.8L10.5 4M6 6.5v5M8 6.5v5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
