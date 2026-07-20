import { useState } from "react";

interface Props {
  publication: string;
  instructions: string;
  hasKey: boolean;
  onSave: (instructions: string) => void;
  onClose: () => void;
}

const EXAMPLES = [
  "This is a link roundup — list each linked article as a bullet with its one-line summary.",
  "For each link, fetch the linked article and include its first two paragraphs under the title.",
  "Fetch each link and extract only the .post-content div; summarize it in 2-3 sentences.",
  "Keep only the main essay; drop the 'what I'm reading' and recommendations sections.",
];

export function AgentOptionsModal({
  publication,
  instructions,
  hasKey,
  onSave,
  onClose,
}: Props) {
  const [text, setText] = useState(instructions);

  const save = () => {
    onSave(text.trim());
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Agent options for ${publication}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2>Agent options</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <p className="hint">
          Instructions for how the agent should handle posts from{" "}
          <strong>{publication}</strong>. Describe what to keep, drop, or reshape. The agent can
          also fetch a linked page and pull just the content it needs — optionally from a specific
          CSS selector / DIV — so you don't pay tokens for whole pages.
        </p>
        {!hasKey && (
          <p className="hint warn">
            No Anthropic API key set — add one under Settings for the agent to run.
          </p>
        )}
        <textarea
          className="agent-instructions"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={6}
          placeholder="e.g. This is a link roundup — list each linked article as a bullet with a one-line summary."
          autoCapitalize="sentences"
          spellCheck
        />
        <div className="examples">
          <span className="hint">Examples:</span>
          {EXAMPLES.map((ex) => (
            <button key={ex} className="example-chip" onClick={() => setText(ex)}>
              {ex}
            </button>
          ))}
        </div>
        <div className="modal-foot">
          <button className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
