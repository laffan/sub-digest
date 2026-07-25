/** Metadata for one Substack email discovered in the mailbox. */
export interface PostMeta {
  id: string;
  /** Raw From header, e.g. `Astral Codex Ten <astralcodexten@substack.com>` */
  from: string;
  subject: string;
  /** Gmail internalDate, milliseconds since epoch */
  dateMs: number;
}

/** A post with its publication name resolved and selection state. */
export interface Post extends PostMeta {
  publication: string;
  selected: boolean;
}

export interface Publication {
  name: string;
  posts: Post[];
}

/** Per-publication agent configuration, keyed by publication name. */
export interface AgentConfig {
  useAgent: boolean;
  instructions: string;
}

export type FontFamily = "Helvetica" | "Times" | "Courier";
export type PageSizeName = "A5" | "HalfLetter" | "A4" | "Letter";

/** Which file Generate produces. */
export type ExportFormat = "pdf" | "epub";

/**
 * Output settings. The page-geometry fields (size, margins, columns, page
 * numbers, imposition) only apply to PDF; EPUB is reflowable and honours the
 * shared fields: `font`, `lineHeight`, `includeImages` and `coverPage`.
 */
export interface LayoutSettings {
  format: ExportFormat;
  pageSize: PageSizeName;
  /** millimetres */
  marginTop: number;
  marginBottom: number;
  marginLeft: number;
  marginRight: number;
  columns: 1 | 2;
  /** millimetres */
  columnGap: number;
  font: FontFamily;
  /** body size in points */
  fontSize: number;
  /** multiplier on font size */
  lineHeight: number;
  includeImages: boolean;
  pageNumbers: boolean;
  coverPage: boolean;
  /** Reorder pages 2-up onto double-width sheets for saddle-stitch printing */
  bookletImposition: boolean;
}

export const DEFAULT_SETTINGS: LayoutSettings = {
  format: "pdf",
  pageSize: "A5",
  marginTop: 14,
  marginBottom: 16,
  marginLeft: 14,
  marginRight: 14,
  columns: 1,
  columnGap: 6,
  font: "Times",
  fontSize: 9.5,
  lineHeight: 1.35,
  includeImages: true,
  pageNumbers: true,
  coverPage: true,
  bookletImposition: false,
};

/** Content blocks extracted from a Substack email body. */
export type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "para"; text: string; style?: "quote" | "caption" }
  | { kind: "list"; items: string[]; ordered: boolean }
  | { kind: "image"; src: string }
  | { kind: "rule" };

/** A fully fetched + parsed post, ready for layout. */
export interface DigestPost {
  publication: string;
  title: string;
  dateMs: number;
  blocks: Block[];
}

/** An image already decoded and re-encoded as JPEG for embedding. */
export interface PreparedImage {
  jpeg: Uint8Array;
  width: number;
  height: number;
}

/**
 * A generated digest, ready to preview and save. EPUB carries a standalone
 * HTML rendering of the book alongside the archive, since the preview pane
 * can't open the archive itself.
 */
export type GeneratedOutput =
  | { format: "pdf"; bytes: Uint8Array }
  | { format: "epub"; bytes: Uint8Array; previewHtml: string };

/** Default file name (sans directory) for saving a generated digest. */
export function outputFileName(format: ExportFormat): string {
  return `substack-digest.${format}`;
}
