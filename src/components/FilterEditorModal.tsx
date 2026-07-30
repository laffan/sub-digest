import { useState } from "react";
import {
  NORMALIZE,
  emptyFilter,
  filterIsEmpty,
  filterLabel,
} from "../filters";
import type { FilterField, MailFilter } from "../types";

interface Props {
  filters: MailFilter[];
  onChange: (filters: MailFilter[]) => void;
  onClose: () => void;
}

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
    hint: "one address",
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

export function FilterEditorModal({ filters, onChange, onClose }: Props) {
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
