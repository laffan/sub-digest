import { useState } from "react";
import { AGENT_MODEL_LABEL } from "../anthropic";
import {
  NORMALIZE,
  emptyFilter,
  filterIsEmpty,
  filterLabel,
} from "../filters";
import type { FilterField, MailFilter } from "../types";

interface Props {
  filters: MailFilter[];
  /** Whether an Anthropic key is set; the agent can't run without one. */
  hasKey: boolean;
  onChange: (filters: MailFilter[]) => void;
  onClose: () => void;
}

const AGENT_EXAMPLES = [
  "Take every article this roundup recommends.",
  "Only the articles in the main list — skip the 'also worth reading' section at the end.",
  "Take each linked article, and pull its content from the .post-content div.",
  "Skip anything on the publication's own site; take only the outside links.",
];

/** The criterion lists, in the order they appear on a filter card. */
const FIELDS: {
  field: FilterField;
  label: string;
  hint: string;
  placeholder: string;
}[] = [
  {
    field: "domains",
    label: "Sender domains",
    hint: "a whole publisher",
    placeholder: "substack.com",
  },
  {
    field: "senders",
    label: "Senders",
    // Gmail's `from:` matches the name on the header as well as the address.
    hint: "an address, or a name",
    placeholder: "news@example.com",
  },
  {
    field: "subjects",
    label: "Subject contains",
    hint: "standing text in the subject",
    placeholder: "Weekly Digest",
  },
  {
    field: "terms",
    label: "Search terms",
    hint: "anywhere in the message",
    placeholder: "unsubscribe",
  },
];

export function FilterEditorModal({ filters, hasKey, onChange, onClose }: Props) {
  const update = (id: string, patch: Partial<MailFilter>) =>
    onChange(filters.map((f) => (f.id === id ? { ...f, ...patch } : f)));

  const addFilter = () => onChange([...filters, emptyFilter("")]);
  const removeFilter = (id: string) => onChange(filters.filter((f) => f.id !== id));

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal wide"
        role="dialog"
        aria-modal="true"
        aria-label="Filters"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2>Filters</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close filters">
            ✕
          </button>
        </div>

        <p className="hint">
          Each filter is one way of finding newsletters. Within a filter, every kind of criterion
          you set has to hold and any one value of that kind will do — so{" "}
          <code>substack.com</code> with the subject slice <code>Weekly</code> finds Substack mail
          whose subject carries "Weekly". A scan runs the filters you've enabled, and mail matching
          any of them turns up.
        </p>

        {filters.length === 0 && (
          <p className="hint warn">
            No filters yet — add one below, or a scan has nothing to look for.
          </p>
        )}

        <div className="filter-cards">
          {filters.map((f) => (
            <section className="filter-card" key={f.id}>
              <div className="filter-card-head">
                <input
                  className="filter-name"
                  type="text"
                  value={f.name}
                  onChange={(e) => update(f.id, { name: e.target.value })}
                  placeholder={filterLabel(f)}
                  aria-label="Filter name"
                  spellCheck={false}
                />
                <label className="check inline">
                  <input
                    type="checkbox"
                    checked={f.enabled}
                    onChange={(e) => update(f.id, { enabled: e.target.checked })}
                  />
                  Enabled
                </label>
                <button
                  className="link danger"
                  onClick={() => removeFilter(f.id)}
                  aria-label={`Remove filter ${filterLabel(f)}`}
                >
                  Remove
                </button>
              </div>

              <div className="chip-fields">
                {FIELDS.map(({ field, label, hint, placeholder }) => (
                  <ChipField
                    key={field}
                    label={label}
                    hint={hint}
                    placeholder={placeholder}
                    values={f[field]}
                    normalize={NORMALIZE[field]}
                    onChange={(values) => update(f.id, { [field]: values })}
                  />
                ))}
              </div>

              {filterIsEmpty(f) && (
                <p className="hint">Add a criterion — a filter with none matches nothing.</p>
              )}

              <div className="filter-agent">
                <label className="check inline agent-toggle">
                  <input
                    type="checkbox"
                    checked={f.useAgent}
                    onChange={(e) => update(f.id, { useAgent: e.target.checked })}
                  />
                  Read this filter's mail with the AI agent
                </label>

                {f.useAgent && (
                  <>
                    <p className="hint">
                      For link roundups, where the digest should carry the articles rather than a
                      page of links. <strong>{AGENT_MODEL_LABEL}</strong> names the links this
                      filter's mail recommends; the app fetches each one and lays it in as scraped.
                      Say which links count and which to skip, and name a CSS selector if the
                      linked pages need one to find their content.
                    </p>
                    {!hasKey && (
                      <p className="hint warn">
                        No Anthropic API key set — add one under Settings for the agent to run.
                      </p>
                    )}
                    <textarea
                      className="agent-instructions"
                      value={f.instructions}
                      onChange={(e) => update(f.id, { instructions: e.target.value })}
                      rows={3}
                      placeholder="e.g. Take every article this roundup recommends."
                      aria-label={`Agent instructions for ${filterLabel(f)}`}
                      autoCapitalize="sentences"
                      spellCheck
                    />
                    {/* Out of the way once there's something written. */}
                    {f.instructions.trim().length === 0 && (
                      <div className="examples">
                        <span className="hint">Examples:</span>
                        {AGENT_EXAMPLES.map((ex) => (
                          <button
                            key={ex}
                            className="example-chip"
                            onClick={() => update(f.id, { instructions: ex })}
                          >
                            {ex}
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            </section>
          ))}
        </div>

        <button className="secondary add-filter" onClick={addFilter}>
          + Add filter
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

interface ChipFieldProps {
  label: string;
  hint: string;
  placeholder: string;
  values: string[];
  /** Tidies a typed value into the form the query builder wants. */
  normalize: (raw: string) => string;
  onChange: (values: string[]) => void;
}

/** One criterion: the values already added, and a box to add another. */
function ChipField({ label, hint, placeholder, values, normalize, onChange }: ChipFieldProps) {
  const [input, setInput] = useState("");

  const candidate = normalize(input);
  const duplicate = candidate.length > 0 && values.includes(candidate);

  const add = () => {
    if (!candidate || duplicate) return;
    onChange([...values, candidate]);
    setInput("");
  };

  return (
    <div className="chip-field">
      <div className="chip-head">
        <span className="chip-label">{label}</span>
        <span className="chip-hint">{hint}</span>
      </div>
      {values.length > 0 && (
        <ul className="chips">
          {values.map((v) => (
            <li className="chip" key={v}>
              <span className="chip-text">{v}</span>
              <button
                className="chip-x"
                onClick={() => onChange(values.filter((x) => x !== v))}
                aria-label={`Remove ${v}`}
                title={`Remove ${v}`}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="chip-add"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={placeholder}
          aria-label={`Add to ${label}`}
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
    </div>
  );
}
