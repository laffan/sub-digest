import { createElement, useCallback, useEffect, useRef, useState } from "react";
import { blockKey, byline, type Block, type DigestPost } from "../types";
import { imageObjectUrl } from "../images";
import { formatLongDate } from "../dates";

interface Props {
  posts: DigestPost[];
  preparing: boolean;
  /** Whether the strike-out tool is armed. */
  removing: boolean;
  removed: ReadonlySet<string>;
  /** An entry to scroll to; the counter makes a repeated click a fresh request. */
  focus: { id: string; n: number } | null;
  onMark: (keys: string[], remove: boolean) => void;
}

/** A drag in progress, in viewport coordinates. */
interface Band {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** ⌥ held: the drag puts material back instead of striking it out. */
  restore: boolean;
}

const rectOf = (b: Band): DOMRect =>
  new DOMRect(
    Math.min(b.x0, b.x1),
    Math.min(b.y0, b.y1),
    Math.abs(b.x1 - b.x0),
    Math.abs(b.y1 - b.y0)
  );

const overlaps = (a: DOMRect, b: DOMRect): boolean =>
  a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;

/**
 * The parsed content as it accrues, one entry at a time. This is what the
 * exporters will lay out — the point is to see what was actually captured
 * (and in what order) before spending time generating a document.
 *
 * It's also where material is struck out: with the tool armed, dragging across
 * a run of blocks marks them, and they turn red rather than disappearing.
 * Nothing is deleted here — the marks are applied on the way to the output, so
 * coming back to this step finds everything still in place to adjust.
 */
export function ContentPreview({ posts, preparing, removing, removed, focus, onMark }: Props) {
  const endRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [band, setBand] = useState<Band | null>(null);
  // Blocks the drag is currently over. Held here rather than committed on every
  // mouse move so a drag can be adjusted before it counts for anything. The ref
  // shadows the state so the mouseup handler can read the final set without
  // reaching for it from inside a state updater.
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const pendingRef = useRef<Set<string>>(new Set());
  const restoreRef = useRef(false);
  const originRef = useRef<{ x: number; y: number } | null>(null);

  const setPendingKeys = useCallback((keys: Set<string>) => {
    pendingRef.current = keys;
    setPending(keys);
  }, []);

  // Follow along as entries land, but only while they're still arriving — once
  // it's done the reader owns the scroll position.
  useEffect(() => {
    if (preparing) endRef.current?.scrollIntoView({ block: "end" });
  }, [posts, preparing]);

  // Clicking a row in the running order brings that entry into view here.
  useEffect(() => {
    if (!focus) return;
    const el = containerRef.current?.querySelector<HTMLElement>(
      `[data-post-id="${CSS.escape(focus.id)}"]`
    );
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [focus]);

  const blocksUnder = useCallback((rect: DOMRect): string[] => {
    const root = containerRef.current;
    if (!root) return [];
    return Array.from(root.querySelectorAll<HTMLElement>("[data-block-key]"))
      .filter((el) => overlaps(el.getBoundingClientRect(), rect))
      .map((el) => el.dataset.blockKey!);
  }, []);

  const startDrag = (e: React.MouseEvent) => {
    if (!removing || e.button !== 0) return;
    e.preventDefault(); // no text selection under the crosshair
    const start: Band = {
      x0: e.clientX,
      y0: e.clientY,
      x1: e.clientX,
      y1: e.clientY,
      restore: e.altKey,
    };
    restoreRef.current = e.altKey;
    originRef.current = { x: e.clientX, y: e.clientY };
    setBand(start);
    // A plain click counts too: the block under the cursor is the whole target.
    setPendingKeys(new Set(blocksUnder(rectOf(start))));
  };

  const dragging = band !== null;
  useEffect(() => {
    if (!dragging) return;
    const move = (e: MouseEvent) => {
      const origin = originRef.current;
      if (!origin) return;
      const next: Band = {
        x0: origin.x,
        y0: origin.y,
        x1: e.clientX,
        y1: e.clientY,
        // Read live, so ⌥ can be taken up or let go mid-drag.
        restore: e.altKey,
      };
      restoreRef.current = e.altKey;
      setBand(next);
      setPendingKeys(new Set(blocksUnder(rectOf(next))));
    };
    const finish = () => {
      const keys = [...pendingRef.current];
      if (keys.length > 0) onMark(keys, !restoreRef.current);
      setPendingKeys(new Set());
      setBand(null);
      originRef.current = null;
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", finish);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", finish);
    };
  }, [dragging, blocksUnder, onMark, setPendingKeys]);

  if (posts.length === 0) {
    return (
      <div className="preview-empty">
        <p>Reading your posts</p>
        <p className="hint">Each one appears here as it's fetched and parsed.</p>
      </div>
    );
  }

  const marked = (key: string) => (pending.has(key) ? !band?.restore : removed.has(key));

  return (
    <div
      className={`content-preview${removing ? " removing" : ""}`}
      ref={containerRef}
      onMouseDown={startDrag}
    >
      {posts.map((post, i) => (
        <article className="cp-post" key={post.id} data-post-id={post.id}>
          <p className="cp-pub">
            {i + 1}. {byline(post)}
          </p>
          <h2 className="cp-title">{post.title}</h2>
          <p className="cp-date">{formatLongDate(post.dateMs)}</p>
          {post.sourceUrl && <p className="cp-source">{post.sourceUrl}</p>}
          {post.blocks.map((block, b) => {
            const key = blockKey(post.id, b);
            return (
              <div
                className={`cp-block${marked(key) ? " struck" : ""}`}
                data-block-key={key}
                key={b}
              >
                <BlockView block={block} />
              </div>
            );
          })}
        </article>
      ))}
      {preparing && <p className="cp-working">Preparing the next post…</p>}
      <div ref={endRef} />
      {band && (
        <div
          className={`cp-band${band.restore ? " restoring" : ""}`}
          style={{
            left: rectOf(band).left,
            top: rectOf(band).top,
            width: rectOf(band).width,
            height: rectOf(band).height,
          }}
        />
      )}
    </div>
  );
}

function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case "heading":
      // h1 belongs to the post title, so in-post headings start at h3 here.
      return createElement(`h${Math.min(6, Math.max(3, block.level + 2))}`, null, block.text);
    case "para":
      if (block.style === "quote") return <blockquote>{block.text}</blockquote>;
      if (block.style === "caption") return <p className="cp-caption">{block.text}</p>;
      return <p>{block.text}</p>;
    case "list":
      return block.ordered ? (
        <ol>
          {block.items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ol>
      ) : (
        <ul>
          {block.items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      );
    case "image":
      return <ImageBlock src={block.src} />;
    case "rule":
      return <hr />;
  }
}

/**
 * An image, fetched only once it's nearly on screen. A digest can carry a
 * hundred of them and they all go through the backend to dodge CORS, so
 * fetching the lot the moment Organize opens would stall the step and hammer
 * the CDNs for pictures nobody has scrolled to yet.
 */
function ImageBlock({ src }: { src: string }) {
  const ref = useRef<HTMLDivElement>(null);
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
      // Start a screen ahead, so scrolling meets pictures already there.
      { rootMargin: "600px" }
    );
    observer.observe(el);
    return () => {
      live = false;
      observer.disconnect();
    };
  }, [src]);

  return (
    <div className="cp-figure" ref={ref}>
      {url ? (
        <img src={url} alt="" />
      ) : (
        <span className="cp-image">▣ {failed ? "image unavailable" : "image"}</span>
      )}
    </div>
  );
}
