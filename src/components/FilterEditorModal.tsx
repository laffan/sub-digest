import { useState } from "react";
import { NORMALIZE, emptyFilter, filterLabel } from "../filters";
import type { FilterField, MailFilter } from "../types";

interface Props {
  filters: MailFilter[];
  /** Whether an Anthropic key is set; the agent can't run without one. */
  hasKey: boolean;
  onChange: (filters: MailFilter[]) => void;
  onClose: () => void;
}

/**
 * A rule is one value on one of a filter's criterion lists. The list is the
 * filter: rules of the same type are alternatives, and the types a filter uses
 * all have to hold.
 */
const RULE_TYPES: { field: FilterField; label: string; placeholder: string }[] = [
  { field: "domains", label: "Sender domain", placeholder: "substack.com" },
  { field: "senders", label: "Sender", placeholder: "news@example.com" },
  { field: "subjects", label: "Subject contains", placeholder: "Weekly Digest" },
  { field: "terms", label: "Search term", placeholder: "unsubscribe" },
];

const AGENT_EXAMPLES = [
  "Take every article this roundup recommends.",
  "Only the articles in the main list — skip the 'also worth reading' section at the end.",
  "Take each linked article, and pull its content from the .post-content div.",
  "Skip anything on the publication's own site; take only the outside links.",
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

        {filters.length === 0 && <p className="hint">No filters yet.</p>}

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
                <button
                  className="link danger"
                  onClick={() => removeFilter(f.id)}
                  aria-label={`Remove filter ${filterLabel(f)}`}
                >
                  Remove
                </button>
              </div>

              <RuleList filter={f} onUpdate={(patch) => update(f.id, patch)} />

              <div className="filter-agent">
                <label className="check inline agent-toggle">
                  <input
                    type="checkbox"
                    checked={f.useAgent}
                    onChange={(e) => update(f.id, { useAgent: e.target.checked })}
                  />
                  Retrieve Links with AI agent
                </label>

                {f.useAgent && (
                  <>
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

interface RuleListProps {
  filter: MailFilter;
  onUpdate: (patch: Partial<MailFilter>) => void;
}

/** A filter's rules, and the row that adds another. */
function RuleList({ filter, onUpdate }: RuleListProps) {
  const [type, setType] = useState<FilterField>("domains");
  const [value, setValue] = useState("");

  const spec = RULE_TYPES.find((t) => t.field === type) ?? RULE_TYPES[0];
  const candidate = NORMALIZE[type](value);
  const duplicate = candidate.length > 0 && filter[type].includes(candidate);

  const add = () => {
    if (!candidate || duplicate) return;
    onUpdate({ [type]: [...filter[type], candidate] });
    setValue("");
  };

  const remove = (field: FilterField, dropped: string) =>
    onUpdate({ [field]: filter[field].filter((v) => v !== dropped) });

  // Grouped by type, in the order the types are listed.
  const rules = RULE_TYPES.flatMap(({ field, label }) =>
    filter[field].map((v) => ({ field, label, value: v }))
  );

  return (
    <>
      <ul className="rules">
        {rules.length === 0 ? (
          <li className="rules-empty">No rules yet.</li>
        ) : (
          rules.map((rule) => (
            <li className="rule" key={`${rule.field}:${rule.value}`}>
              <span className="rule-type">{rule.label}</span>
              <span className="rule-value">{rule.value}</span>
              <button
                className="rule-x"
                onClick={() => remove(rule.field, rule.value)}
                aria-label={`Remove rule ${rule.label} ${rule.value}`}
                title="Remove rule"
              >
                ✕
              </button>
            </li>
          ))
        )}
      </ul>

      <form
        className="rule-add"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <select
          value={type}
          onChange={(e) => setType(e.target.value as FilterField)}
          aria-label="Rule type"
        >
          {RULE_TYPES.map((t) => (
            <option key={t.field} value={t.field}>
              {t.label}
            </option>
          ))}
        </select>
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={spec.placeholder}
          aria-label="Rule value"
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
        />
        <button className="secondary" type="submit" disabled={!candidate || duplicate}>
          Add Rule
        </button>
      </form>
      {duplicate && <p className="hint">Already added.</p>}
    </>
  );
}
