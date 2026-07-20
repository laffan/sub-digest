import { useState } from "react";
import { ANTHROPIC_MODELS, anthropicTest } from "../anthropic";

interface Props {
  domains: string[];
  onDomainsChange: (domains: string[]) => void;
  anthropicKey: string;
  anthropicModel: string;
  onAnthropicChange: (key: string, model: string) => void;
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

type TestState = { status: "idle" | "testing" | "ok" | "error"; message?: string };

export function SettingsModal({
  domains,
  onDomainsChange,
  anthropicKey,
  anthropicModel,
  onAnthropicChange,
  onClose,
}: Props) {
  const [input, setInput] = useState("");
  const [keyDraft, setKeyDraft] = useState(anthropicKey);
  const [model, setModel] = useState(anthropicModel);
  const [test, setTest] = useState<TestState>({ status: "idle" });

  const candidate = normalizeDomain(input);
  const duplicate = candidate.length > 0 && domains.includes(candidate);

  const addDomain = () => {
    if (!candidate || duplicate) return;
    onDomainsChange([...domains, candidate]);
    setInput("");
  };
  const removeDomain = (d: string) => onDomainsChange(domains.filter((x) => x !== d));

  const saveAnthropic = (key: string, m: string) => {
    setKeyDraft(key);
    setModel(m);
    onAnthropicChange(key.trim(), m);
  };

  const runTest = async () => {
    onAnthropicChange(keyDraft.trim(), model); // persist before testing
    setTest({ status: "testing" });
    try {
      const msg = await anthropicTest(keyDraft.trim(), model);
      setTest({ status: "ok", message: msg });
    } catch (e) {
      setTest({ status: "error", message: String(e) });
    }
  };

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
          <h2>Settings</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close settings">
            ✕
          </button>
        </div>

        <h3 className="modal-section">Sender domains</h3>
        <p className="hint">
          Scanning matches email from these domains — for example <code>substack.com</code>,{" "}
          <code>ghost.io</code>, <code>beehiiv.com</code>, or a specific sender like{" "}
          <code>news@example.com</code>.
        </p>
        <ul className="domain-list">
          {domains.map((d) => (
            <li key={d}>
              <span className="domain-name">{d}</span>
              <button
                className="link danger"
                onClick={() => removeDomain(d)}
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
            addDomain();
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

        <h3 className="modal-section">AI agent (Anthropic)</h3>
        <p className="hint">
          Some newsletters (link roundups, unusual layouts) parse poorly. Add an Anthropic API
          key to let a per-newsletter agent reformat them. The key is stored only on this device.
        </p>
        <label>
          API key
          <input
            type="password"
            value={keyDraft}
            onChange={(e) => saveAnthropic(e.target.value, model)}
            placeholder="sk-ant-…"
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label>
          Model
          <select value={model} onChange={(e) => saveAnthropic(keyDraft, e.target.value)}>
            {ANTHROPIC_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <div className="test-row">
          <button
            className="secondary"
            onClick={runTest}
            disabled={test.status === "testing" || keyDraft.trim().length === 0}
          >
            {test.status === "testing" ? "Testing…" : "Test key"}
          </button>
          {test.status === "ok" && <span className="test-ok">✓ {test.message}</span>}
          {test.status === "error" && <span className="test-err">{test.message}</span>}
        </div>

        <div className="modal-foot">
          <button className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
