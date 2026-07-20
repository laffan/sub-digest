import { useMemo, useState } from "react";
import type { AgentConfig, Post, Publication } from "../types";

interface Props {
  posts: Post[];
  days: number;
  scanning: boolean;
  agentConfigs: Record<string, AgentConfig>;
  onDaysChange: (days: number) => void;
  onScan: () => void;
  onTogglePost: (id: string) => void;
  onTogglePublication: (name: string, selected: boolean) => void;
  onToggleAgent: (name: string, useAgent: boolean) => void;
  onOpenAgentOptions: (name: string) => void;
}

// `days: 0` means no lower bound — search the entire archive.
const TIMEFRAMES: { label: string; days: number }[] = [
  { label: "Last 7 days", days: 7 },
  { label: "Last 14 days", days: 14 },
  { label: "Last 30 days", days: 30 },
  { label: "Last 3 months", days: 90 },
  { label: "Last 6 months", days: 183 },
  { label: "Last year", days: 365 },
  { label: "Last 2 years", days: 730 },
  { label: "All time", days: 0 },
];

/** Matches MAX_MESSAGES in the Rust backend. */
const SCAN_LIMIT = 1000;

export function PostList({
  posts,
  days,
  scanning,
  agentConfigs,
  onDaysChange,
  onScan,
  onTogglePost,
  onTogglePublication,
  onToggleAgent,
  onOpenAgentOptions,
}: Props) {
  const [openMenu, setOpenMenu] = useState<string | null>(null);

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
          {TIMEFRAMES.map((t) => (
            <option key={t.days} value={t.days}>
              {t.label}
            </option>
          ))}
        </select>
        <button className="secondary" disabled={scanning} onClick={onScan}>
          {scanning ? "Scanning…" : "Scan Mail"}
        </button>
      </div>

      {posts.length === 0 && !scanning && (
        <p className="hint">Scan your mail to discover Substack posts (archived included).</p>
      )}

      {posts.length >= SCAN_LIMIT && (
        <p className="hint">
          Showing the first {SCAN_LIMIT.toLocaleString()} matches — narrow the timeframe to
          reach older ones.
        </p>
      )}

      <div className="pub-list">
        {publications.map((pub) => {
          const all = pub.posts.every((p) => p.selected);
          const some = pub.posts.some((p) => p.selected);
          const agent = agentConfigs[pub.name];
          const useAgent = agent?.useAgent ?? false;
          const menuOpen = openMenu === pub.name;
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
                <span className="pub-count">{pub.posts.length}</span>
                <button
                  className={`pub-menu-btn${useAgent ? " active" : ""}`}
                  aria-label={`Agent menu for ${pub.name}`}
                  aria-expanded={menuOpen}
                  title={useAgent ? "Agent enabled" : "Agent options"}
                  onClick={() => setOpenMenu(menuOpen ? null : pub.name)}
                >
                  <CaretIcon />
                </button>

                {menuOpen && (
                  <>
                    <div className="menu-scrim" onClick={() => setOpenMenu(null)} />
                    <div className="pub-menu" role="menu">
                      <label className="menu-check">
                        <input
                          type="checkbox"
                          checked={useAgent}
                          onChange={(e) => onToggleAgent(pub.name, e.target.checked)}
                        />
                        Use Agent
                      </label>
                      <button
                        className="menu-item"
                        disabled={!useAgent}
                        onClick={() => {
                          setOpenMenu(null);
                          onOpenAgentOptions(pub.name);
                        }}
                      >
                        Agent options…
                      </button>
                    </div>
                  </>
                )}
              </div>
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

function CaretIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
