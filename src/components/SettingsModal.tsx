import { useState } from "react";
import { AGENT_MODEL_LABEL, anthropicTest } from "../anthropic";

interface Props {
  anthropicKey: string;
  onAnthropicKeyChange: (key: string) => void;
  /** How many posts are remembered as already processed. */
  processedCount: number;
  onForgetProcessed: () => void;
  onClose: () => void;
}

type TestState = { status: "idle" | "testing" | "ok" | "error"; message?: string };

export function SettingsModal({
  anthropicKey,
  onAnthropicKeyChange,
  processedCount,
  onForgetProcessed,
  onClose,
}: Props) {
  const [keyDraft, setKeyDraft] = useState(anthropicKey);
  const [test, setTest] = useState<TestState>({ status: "idle" });

  const saveKey = (key: string) => {
    setKeyDraft(key);
    onAnthropicKeyChange(key.trim());
  };

  const runTest = async () => {
    onAnthropicKeyChange(keyDraft.trim()); // persist before testing
    setTest({ status: "testing" });
    try {
      const msg = await anthropicTest(keyDraft.trim());
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

        <h3 className="modal-section">AI agent (Anthropic)</h3>
        <p className="hint">
          Link roundups parse poorly: you get a page of links instead of the reading. Add an
          Anthropic API key to let a per-newsletter agent pick out the linked articles, which the
          app then fetches and lays into the digest. The model runs on{" "}
          <strong>{AGENT_MODEL_LABEL}</strong> and only ever names the links — every word in the
          digest is scraped, never written. The key is stored only on this device.
        </p>
        <label>
          API key
          <input
            type="password"
            value={keyDraft}
            onChange={(e) => saveKey(e.target.value)}
            placeholder="sk-ant-…"
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
          />
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

        <h3 className="modal-section">Processed posts</h3>
        <p className="hint">
          Posts that have been fetched and parsed are remembered between sessions and shown at
          half strength when you scan, so it's easy to see what's new. It's only a marker —
          nothing is skipped, filtered, or unselected because of it.
        </p>
        <div className="processed-row">
          <span className="hint">
            {processedCount === 0
              ? "Nothing remembered yet."
              : `${processedCount.toLocaleString()} post${processedCount === 1 ? "" : "s"} remembered.`}
          </span>
          <button className="secondary" disabled={processedCount === 0} onClick={onForgetProcessed}>
            Clear
          </button>
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
