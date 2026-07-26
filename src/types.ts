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

/** Timeframe sentinel: scan an explicit start/end date range instead of "last N days". */
export const CUSTOM_RANGE = -1;

/** An explicit scan window, as the `YYYY-MM-DD` strings a date input produces. */
export interface DateRange {
  start: string;
  end: string;
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

/**
 * One entry in the digest, ready for layout. Usually a post; for an
 * agent-processed newsletter it's one of the articles that newsletter linked
 * to, which is why the title and byline can differ from the email's.
 */
export interface DigestPost {
  /** Stable across re-preparations, so removals and ordering survive a revisit. */
  id: string;
  publication: string;
  title: string;
  /** Who wrote it, when the newsletter named them. */
  author?: string;
  /** The article's own address, for entries the agent fetched. */
  sourceUrl?: string;
  dateMs: number;
  blocks: Block[];
}

/** Who to credit: the piece's author when known, else where it arrived from. */
export function byline(post: DigestPost): string {
  return post.author?.trim() ? post.author.trim() : post.publication;
}

/** The key identifying one block of one entry, for marking it removed. */
export function blockKey(postId: string, index: number): string {
  return `${postId}#${index}`;
}

/** Drops blocks marked for removal, and any entry left with nothing in it. */
export function withRemovals(posts: DigestPost[], removed: ReadonlySet<string>): DigestPost[] {
  if (removed.size === 0) return posts;
  return posts
    .map((p) => ({ ...p, blocks: p.blocks.filter((_, i) => !removed.has(blockKey(p.id, i))) }))
    .filter((p) => p.blocks.length > 0);
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
