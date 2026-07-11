import { useMemo } from "react";
import type { Post, Publication } from "../types";

interface Props {
  posts: Post[];
  days: number;
  scanning: boolean;
  onDaysChange: (days: number) => void;
  onScan: () => void;
  onTogglePost: (id: string) => void;
  onTogglePublication: (name: string, selected: boolean) => void;
}

const TIMEFRAMES = [7, 14, 30, 60, 90];

export function PostList({
  posts,
  days,
  scanning,
  onDaysChange,
  onScan,
  onTogglePost,
  onTogglePublication,
}: Props) {
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

  return (
    <section className="panel posts">
      <h2 className="col-title">Posts</h2>
      <div className="scan-row">
        <select value={days} onChange={(e) => onDaysChange(Number(e.target.value))}>
          {TIMEFRAMES.map((d) => (
            <option key={d} value={d}>
              Last {d} days
            </option>
          ))}
        </select>
        <button className="secondary" disabled={scanning} onClick={onScan}>
          {scanning ? "Scanning…" : "Scan Inbox"}
        </button>
      </div>

      {posts.length === 0 && !scanning && (
        <p className="hint">Scan your inbox to discover Substack posts.</p>
      )}

      <div className="pub-list">
        {publications.map((pub) => {
          const all = pub.posts.every((p) => p.selected);
          const some = pub.posts.some((p) => p.selected);
          return (
            <div className="pub" key={pub.name}>
              <label className="pub-header">
                <input
                  type="checkbox"
                  checked={all}
                  ref={(el) => {
                    if (el) el.indeterminate = some && !all;
                  }}
                  onChange={(e) => onTogglePublication(pub.name, e.target.checked)}
                />
                <span className="pub-name">{pub.name}</span>
                <span className="pub-count">{pub.posts.length}</span>
              </label>
              <ul>
                {pub.posts.map((p) => (
                  <li key={p.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={p.selected}
                        onChange={() => onTogglePost(p.id)}
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
