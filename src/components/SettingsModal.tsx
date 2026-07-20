import { useState } from "react";

interface Props {
  domains: string[];
  onChange: (domains: string[]) => void;
  onClose: () => void;
}

/** Reduces "@Substack.com", "https://ghost.io/x" etc. to a bare "substack.com". */
function normalizeDomain(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/\s+/g, "");
}

export function SettingsModal({ domains, onChange, onClose }: Props) {
  const [input, setInput] = useState("");
  const candidate = normalizeDomain(input);
  const duplicate = candidate.length > 0 && domains.includes(candidate);

  const add = () => {
    if (!candidate || duplicate) return;
    onChange([...domains, candidate]);
    setInput("");
  };

  const remove = (d: string) => onChange(domains.filter((x) => x !== d));

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2>Sender domains</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close settings">
            ✕
          </button>
        </div>

        <p className="hint">
          Scanning matches email from these domains. Add newsletter hosts you use — for
          example <code>substack.com</code>, <code>ghost.io</code>, <code>beehiiv.com</code>,
          or a specific sender like <code>news@example.com</code>.
        </p>

        <ul className="domain-list">
          {domains.map((d) => (
            <li key={d}>
              <span className="domain-name">{d}</span>
              <button
                className="link danger"
                onClick={() => remove(d)}
                disabled={domains.length <= 1}
                aria-label={`Remove ${d}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>

        <form
          className="domain-add"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="add a domain…"
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
          />
          <button className="secondary" type="submit" disabled={!candidate || duplicate}>
            Add
          </button>
        </form>
        {duplicate && <p className="hint">Already added.</p>}

        <div className="modal-foot">
          <button className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
