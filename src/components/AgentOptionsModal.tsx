import { useState } from "react";

interface Props {
  publication: string;
  instructions: string;
  hasKey: boolean;
  onSave: (instructions: string) => void;
  onClose: () => void;
}

const EXAMPLES = [
  "Take every article this roundup recommends.",
  "Only the articles in the main list — skip the 'also worth reading' section at the end.",
  "Take each linked article, and pull its content from the .post-content div.",
  "Skip anything on the publication's own site; take only the outside links.",
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
          Which links the agent should take from posts by <strong>{publication}</strong>. The model
          only picks out the articles; the app fetches each one and lays it into the digest as
          scraped. Say which links count and which to skip, and name a CSS selector / DIV if the
          linked pages need one to find their content.
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
          placeholder="e.g. Take every article this roundup recommends."
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
