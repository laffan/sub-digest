import { useMemo, useRef } from "react";
import type { Post, Publication } from "../types";

interface Props {
  posts: Post[];
  /** Ids of posts the agent will read, from the filter that found each. */
  agentPosts: ReadonlySet<string>;
  /** Posts read in an earlier session — shown at half strength, nothing more. */
  processed: ReadonlySet<string>;
  /** Most posts one collection can return; a full list says so. */
  limit: number;
  /** What to say when it came back full — the two inputs run out differently. */
  limitNote: string;
  onTogglePost: (id: string) => void;
  onSetPostsSelected: (ids: string[], selected: boolean) => void;
  onTogglePublication: (name: string, selected: boolean) => void;
}

/**
 * What an input found, grouped by publication and ready to be picked over.
 *
 * Both inputs land here: an email and a saved article are the same shape by the
 * time they reach it — a title, a publication, a date — so selecting works one
 * way whichever step produced the list.
 */
export function PostList({
  posts,
  agentPosts,
  processed,
  limit,
  limitNote,
  onTogglePost,
  onSetPostsSelected,
  onTogglePublication,
}: Props) {
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

  if (posts.length === 0) return null;

  return (
    <section className="panel results">
      <p className="hint">Shift-click to select through to your last click.</p>

      {posts.length >= limit && <p className="hint">{limitNote}</p>}

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
