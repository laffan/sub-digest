import { useState } from "react";
import {
  METHOD_LABELS,
  emptyList,
  emptySource,
  listSummary,
  sourceDomain,
  type SavedList,
  type SavedSource,
  type SignInMethod,
} from "../sources";

interface Props {
  sources: SavedSource[];
  onChange: (sources: SavedSource[]) => void;
  onClose: () => void;
}

const METHODS: SignInMethod[] = ["link", "password", "cookie"];

/**
 * The saved-list sources and what to read from each.
 *
 * This is where the feature stops being about Substack. A source is a site, a
 * way in, and a list or two; filling that form in is the whole of adding
 * another site, and correcting an address a site has moved is a paste. Substack
 * is one of these like anything else — which matters, because it publishes no
 * API and the addresses it ships with are the ones its own reader calls.
 */
export function SourceEditorModal({ sources, onChange, onClose }: Props) {
  // One source open at a time; the rest stay a line each, as the filters do.
  const [openId, setOpenId] = useState<string | null>(sources[0]?.id ?? null);

  const update = (id: string, patch: Partial<SavedSource>) =>
    onChange(sources.map((s) => (s.id === id ? { ...s, ...patch } : s)));

  const addSource = () => {
    const added = emptySource("");
    onChange([...sources, added]);
    setOpenId(added.id);
  };

  const removeSource = (id: string) => {
    onChange(sources.filter((s) => s.id !== id));
    if (openId === id) setOpenId(null);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal wide"
        role="dialog"
        aria-modal="true"
        aria-label="Sources"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2>Sources</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close sources">
            ✕
          </button>
        </div>

        <p className="hint">
          A site you keep a list on, how to sign in to it, and what to read the list from. None of
          these sites publishes an API for this, so an address that stops working is one to correct
          here — the log says exactly what came back.
        </p>

        {sources.length === 0 && <p className="hint">No sources yet.</p>}

        <div className="filter-cards">
          {sources.map((s) => (
            <section className={`filter-card${s.id === openId ? " open" : ""}`} key={s.id}>
              {s.id === openId ? (
                <div className="filter-card-head">
                  <button
                    className="filter-toggle"
                    onClick={() => setOpenId(null)}
                    aria-expanded
                    aria-label={`Collapse ${s.name || "source"}`}
                  >
                    <CaretIcon />
                  </button>
                  <input
                    className="filter-name"
                    type="text"
                    value={s.name}
                    onChange={(e) => update(s.id, { name: e.target.value })}
                    placeholder="Substack"
                    aria-label="Source name"
                    spellCheck={false}
                  />
                </div>
              ) : (
                <button
                  className="filter-card-head collapsed"
                  onClick={() => setOpenId(s.id)}
                  aria-expanded={false}
                >
                  <span className="filter-toggle">
                    <CaretIcon />
                  </span>
                  <span className="filter-head-name">{s.name || "Untitled source"}</span>
                  <span className="filter-head-summary">
                    {sourceDomain(s) || "no site yet"} ·{" "}
                    {s.lists.length === 1 ? "1 list" : `${s.lists.length} lists`}
                  </span>
                </button>
              )}

              {s.id === openId && (
                <div className="filter-card-body">
                  <label>
                    The site
                    <input
                      type="text"
                      value={s.home}
                      onChange={(e) => update(s.id, { home: e.target.value })}
                      placeholder="https://substack.com"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                    />
                  </label>
                  <p className="hint">
                    The session is kept for <code>{sourceDomain(s) || "—"}</code> and its
                    subdomains, and sent nowhere else.
                  </p>

                  <ListEditor source={s} onUpdate={(patch) => update(s.id, patch)} />

                  <details className="advanced">
                    <summary>Signing in</summary>
                    <div className="check-row" role="group" aria-label="Ways in this site offers">
                      {METHODS.map((m) => (
                        <label className="check inline" key={m}>
                          <input
                            type="checkbox"
                            checked={s.methods.includes(m)}
                            onChange={(e) =>
                              update(s.id, {
                                methods: e.target.checked
                                  ? [...s.methods, m]
                                  : s.methods.filter((x) => x !== m),
                              })
                            }
                          />
                          <span>{METHOD_LABELS[m]}</span>
                        </label>
                      ))}
                    </div>
                    <label>
                      Sign-in link endpoint
                      <input
                        type="text"
                        value={s.linkRequestUrl}
                        onChange={(e) => update(s.id, { linkRequestUrl: e.target.value })}
                        placeholder="https://substack.com/api/v1/email-login"
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                      />
                    </label>
                    <label>
                      Password endpoint
                      <input
                        type="text"
                        value={s.passwordUrl}
                        onChange={(e) => update(s.id, { passwordUrl: e.target.value })}
                        placeholder="https://substack.com/api/v1/login"
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                      />
                    </label>
                    <label>
                      Session cookie name
                      <input
                        type="text"
                        value={s.cookieName}
                        onChange={(e) => update(s.id, { cookieName: e.target.value })}
                        placeholder="connect.sid"
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                      />
                    </label>
                    <label>
                      “Who's signed in” address
                      <input
                        type="text"
                        value={s.probeUrl}
                        onChange={(e) => update(s.id, { probeUrl: e.target.value })}
                        placeholder="https://substack.com/api/v1/user/profile/self"
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                      />
                    </label>
                    <label>
                      …and where the name is in its answer
                      <input
                        type="text"
                        value={s.probeFields.join(", ")}
                        onChange={(e) =>
                          update(s.id, {
                            probeFields: e.target.value
                              .split(",")
                              .map((v) => v.trim())
                              .filter((v) => v.length > 0),
                          })
                        }
                        placeholder="user.name, email"
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                      />
                    </label>
                    <p className="hint">
                      Checked after signing in, so a session that didn't take says so straight
                      away. Leave it blank and the session is taken on trust until a list is asked
                      for.
                    </p>
                  </details>

                  <div className="filter-card-foot">
                    <button className="link danger" onClick={() => removeSource(s.id)}>
                      Remove this source
                    </button>
                  </div>
                </div>
              )}
            </section>
          ))}
        </div>

        <button className="add-filter" onClick={addSource}>
          + Add a Source
        </button>

        <div className="modal-foot">
          <button className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

interface ListEditorProps {
  source: SavedSource;
  onUpdate: (patch: Partial<SavedSource>) => void;
}

/** A source's lists: what each is called, and what to read it from. */
function ListEditor({ source, onUpdate }: ListEditorProps) {
  const update = (id: string, patch: Partial<SavedList>) =>
    onUpdate({ lists: source.lists.map((l) => (l.id === id ? { ...l, ...patch } : l)) });

  return (
    <div className="source-lists">
      <h3 className="col-title">Lists</h3>
      {source.lists.map((l) => (
        <div className="source-list" key={l.id}>
          <div className="source-list-head">
            <input
              type="text"
              value={l.name}
              onChange={(e) => update(l.id, { name: e.target.value })}
              placeholder="Saved"
              aria-label="List name"
              spellCheck={false}
            />
            <select
              value={l.kind}
              onChange={(e) => update(l.id, { kind: e.target.value as SavedList["kind"] })}
              aria-label="What comes back"
            >
              <option value="json">A list endpoint (JSON)</option>
              <option value="links">A page of links (HTML)</option>
            </select>
            <button
              className="rule-x"
              onClick={() => onUpdate({ lists: source.lists.filter((x) => x.id !== l.id) })}
              aria-label={`Remove ${l.name || "list"}`}
              title="Remove list"
            >
              ✕
            </button>
          </div>

          <label>
            Address{l.urls.length > 1 ? "es, one per line — tried in order" : ""}
            <textarea
              className="paste-box"
              value={l.urls.join("\n")}
              onChange={(e) => update(l.id, { urls: e.target.value.split("\n") })}
              placeholder="https://substack.com/api/v1/inbox/top?surface=inbox_saved&limit=50"
              rows={Math.min(4, Math.max(2, l.urls.length))}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </label>

          {l.kind === "links" ? (
            <label>
              Which links to take
              <input
                type="text"
                value={l.linkSelector}
                onChange={(e) => update(l.id, { linkSelector: e.target.value })}
                placeholder="ul.saved-posts"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </label>
          ) : (
            <label>
              Where the items are (optional)
              <input
                type="text"
                value={l.itemsPath}
                onChange={(e) => update(l.id, { itemsPath: e.target.value })}
                placeholder="posts"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </label>
          )}

          <p className="hint">
            {l.kind === "links"
              ? "A CSS selector for the part of the page the list is in; blank takes every link on it. Titles come from the link text."
              : `Left blank, the longest array of objects in the answer is taken as the list. ${listSummary(l)}`}
          </p>
        </div>
      ))}

      <button
        className="rule-add-btn"
        onClick={() => onUpdate({ lists: [...source.lists, emptyList("")] })}
      >
        + Add a List
      </button>
    </div>
  );
}

function CaretIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M9 6l6 6-6 6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
