import type { FontFamily, LayoutSettings, PageSizeName } from "../types";

interface Props {
  settings: LayoutSettings;
  onChange: (s: LayoutSettings) => void;
}

const PAGE_SIZES: { value: PageSizeName; label: string }[] = [
  { value: "A5", label: "A5 (148 × 210 mm)" },
  { value: "HalfLetter", label: "Half Letter (5.5 × 8.5 in)" },
  { value: "A4", label: "A4 (210 × 297 mm)" },
  { value: "Letter", label: "Letter (8.5 × 11 in)" },
];

const FONTS: FontFamily[] = ["Times", "Helvetica", "Courier"];

export function SettingsPanel({ settings, onChange }: Props) {
  const set = <K extends keyof LayoutSettings>(key: K, value: LayoutSettings[K]) =>
    onChange({ ...settings, [key]: value });

  const num =
    <K extends keyof LayoutSettings>(key: K, min: number, max: number) =>
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = Number(e.target.value);
      if (!Number.isNaN(v)) set(key, Math.min(max, Math.max(min, v)) as LayoutSettings[K]);
    };

  return (
    <div className="settings">
      <fieldset>
        <legend>Page</legend>
        <label>
          Size
          <select
            value={settings.pageSize}
            onChange={(e) => set("pageSize", e.target.value as PageSizeName)}
          >
            {PAGE_SIZES.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={settings.bookletImposition}
            onChange={(e) => set("bookletImposition", e.target.checked)}
          />
          Booklet imposition (2-up, saddle stitch)
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={settings.coverPage}
            onChange={(e) => set("coverPage", e.target.checked)}
          />
          Cover with table of contents
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={settings.pageNumbers}
            onChange={(e) => set("pageNumbers", e.target.checked)}
          />
          Page numbers
        </label>
      </fieldset>

      <fieldset>
        <legend>Margins (mm)</legend>
        <div className="grid2">
          <label>
            Top
            <input type="number" min={4} max={40} value={settings.marginTop} onChange={num("marginTop", 4, 40)} />
          </label>
          <label>
            Bottom
            <input type="number" min={4} max={40} value={settings.marginBottom} onChange={num("marginBottom", 4, 40)} />
          </label>
          <label>
            Left
            <input type="number" min={4} max={40} value={settings.marginLeft} onChange={num("marginLeft", 4, 40)} />
          </label>
          <label>
            Right
            <input type="number" min={4} max={40} value={settings.marginRight} onChange={num("marginRight", 4, 40)} />
          </label>
        </div>
      </fieldset>

      <fieldset>
        <legend>Columns</legend>
        <div className="grid2">
          <label>
            Count
            <select
              value={settings.columns}
              onChange={(e) => set("columns", Number(e.target.value) as 1 | 2)}
            >
              <option value={1}>1</option>
              <option value={2}>2</option>
            </select>
          </label>
          <label>
            Gap (mm)
            <input type="number" min={2} max={20} value={settings.columnGap} onChange={num("columnGap", 2, 20)} />
          </label>
        </div>
      </fieldset>

      <fieldset>
        <legend>Type</legend>
        <label>
          Font
          <select value={settings.font} onChange={(e) => set("font", e.target.value as FontFamily)}>
            {FONTS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
        <div className="grid2">
          <label>
            Size (pt)
            <input
              type="number"
              min={7}
              max={16}
              step={0.5}
              value={settings.fontSize}
              onChange={num("fontSize", 7, 16)}
            />
          </label>
          <label>
            Line height
            <input
              type="number"
              min={1}
              max={2}
              step={0.05}
              value={settings.lineHeight}
              onChange={num("lineHeight", 1, 2)}
            />
          </label>
        </div>
      </fieldset>

      <fieldset>
        <legend>Content</legend>
        <label className="check">
          <input
            type="checkbox"
            checked={settings.includeImages}
            onChange={(e) => set("includeImages", e.target.checked)}
          />
          Include images
        </label>
      </fieldset>
    </div>
  );
}
