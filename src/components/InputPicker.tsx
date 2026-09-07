import type { InputKind } from "../types";

interface Props {
  value: InputKind;
  onChange: (kind: InputKind) => void;
  /** Switching mid-collection would leave posts from an input that isn't on. */
  disabled: boolean;
}

const INPUTS: { kind: InputKind; label: string; hint: string }[] = [
  { kind: "gmail", label: "Gmail", hint: "Newsletters your filters match, out of your mailbox." },
  {
    kind: "saved",
    label: "Saved List",
    hint: "Articles you've saved on a site — sign in, pick the list, collect what's on it.",
  },
];

/**
 * Where this session's reading comes from. One input at a time: a session
 * collects from the mailbox or from a list, and everything after this step —
 * selecting, reading, ordering, the cover, both exports — is the same work
 * either way.
 */
export function InputPicker({ value, onChange, disabled }: Props) {
  const chosen = INPUTS.find((i) => i.kind === value) ?? INPUTS[0];

  return (
    <section className="panel input-picker">
      <h2 className="col-title">Input</h2>
      <div className="segmented" role="group" aria-label="Where the posts come from">
        {INPUTS.map((input) => (
          <button
            key={input.kind}
            className={`segment${input.kind === value ? " active" : ""}`}
            onClick={() => onChange(input.kind)}
            disabled={disabled}
            aria-pressed={input.kind === value}
          >
            {input.label}
          </button>
        ))}
      </div>
      <p className="hint">{chosen.hint}</p>
    </section>
  );
}
