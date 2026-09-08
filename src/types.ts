/** Metadata for one newsletter email discovered in the mailbox. */
export interface PostMeta {
  id: string;
  /** Raw From header, e.g. `Astral Codex Ten <astralcodexten@substack.com>` */
  from: string;
  subject: string;
  /** Gmail internalDate, milliseconds since epoch */
  dateMs: number;
  /**
   * The filters that found this message, in the order they're configured. A
   * scan runs each filter as its own query precisely to learn this: search
   * terms match the body, so which filter caught a message can't be worked
   * out from its headers afterwards. It's what decides how the post is read.
   */
  filterIds: string[];
}

/**
 * Which input a session collects from. The first step of the app is a choice of
 * where the reading comes from — the mailbox, or a list you keep on a site —
 * and everything after it works on what that step produced, whichever it was.
 */
export type InputKind = "gmail" | "saved";

/**
 * A post with its publication name resolved and selection state.
 *
 * The fields past `selected` are what a saved-list item carries that an email
 * doesn't: an article has an address of its own, and the list usually names its
 * writer. `subject` is the title either way, so everything downstream — the
 * scan list, the running order, the contents page — reads one shape.
 */
export interface Post extends PostMeta {
  publication: string;
  selected: boolean;
  /** Which input found it. */
  source: InputKind;
  /** The article's own address; saved-list items only. */
  url?: string;
  /** Who the list said wrote it, when it said. */
  author?: string;
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

/**
 * One saved way of finding newsletters. A filter can be a sender domain, a
 * whole address, a slice of subject line, a search term, or any combination:
 * every kind of criterion it sets has to hold, and within one kind any single
 * value will do. So domains `substack.com` plus the subject slice `Weekly`
 * finds Substack mail whose subject carries "Weekly", nothing else.
 *
 * Scanning ORs the enabled filters together, so each one is its own way in.
 */
export interface MailFilter {
  /** Stable across edits, so the sidebar's checkboxes track the right filter. */
  id: string;
  /** What the user calls it; falls back to its first criterion when blank. */
  name: string;
  enabled: boolean;
  /** Sender domains, e.g. `substack.com`. */
  domains: string[];
  /** Whole sender addresses, e.g. `news@example.com`. */
  senders: string[];
  /** Text the subject line has to contain. */
  subjects: string[];
  /** Free search terms, matched anywhere in the message. */
  terms: string[];
  /**
   * Read the mail this filter finds with the AI agent rather than the default
   * parser — for link roundups, where the digest should carry the articles
   * rather than the page of links. Being per-filter is the point: carve the
   * roundups out with their own filter and only they go to the agent.
   */
  useAgent: boolean;
  /** What the agent should take from this filter's mail. */
  instructions: string;
  /**
   * Keep a signature of everything struck out of this filter's mail, and strike
   * it out again wherever it turns up. A newsletter's furniture — the masthead
   * image, the standing sign-off, the same promo paragraph every week — is
   * removed once and stays removed.
   */
  rememberRemovals: boolean;
  /** The signatures remembered so far; see `blockSignature` in `remember.ts`. */
  removedSignatures: string[];
}

/** The criterion lists on a filter — everything but its id, name and state. */
export type FilterField = "domains" | "senders" | "subjects" | "terms";

export type FontFamily = "Helvetica" | "Times" | "Courier";
export type PageSizeName = "A5" | "HalfLetter" | "A4" | "Letter";

/**
 * Each page size in PDF points. The layout engine draws with these; the cover
 * picker only wants the shape of them, so it can crop a picture to the page it
 * will actually be printed on.
 */
export const PAGE_POINTS: Record<PageSizeName, [number, number]> = {
  A5: [419.53, 595.28],
  HalfLetter: [396, 612],
  A4: [595.28, 841.89],
  Letter: [612, 792],
};

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

/**
 * One artwork from the Metropolitan Museum's open collection API — a candidate
 * for the cover, and once chosen, the thing the credit under the contents
 * describes. Only open-access pieces are searched, so every one of these
 * carries an image the digest is free to print.
 */
export interface CoverArtwork {
  /** The museum's own id for the piece; unique, and the picker's React key. */
  objectId: number;
  title: string;
  /** `artistDisplayName` — empty on an unattributed piece. */
  artist: string;
  /** `artistDisplayBio`, e.g. "Dutch, Zundert 1853–1890 Auvers-sur-Oise". */
  artistBio: string;
  /** `objectDate`, in the museum's own phrasing: "1887", "ca. 1487". */
  date: string;
  /** What it's made of — "Oil on canvas", "Woodblock print". */
  medium: string;
  /** How the museum came by it, e.g. "Rogers Fund, 1949". */
  creditLine: string;
  department: string;
  /** The museum's page for the piece. */
  objectUrl: string;
  /** Full-size image, for the printed cover. */
  imageUrl: string;
  /** Web-sized image, for the picker's grid. */
  thumbUrl: string;
}

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
  /**
   * The filter that decided how this entry was read — and so the filter that
   * remembers what gets struck out of it.
   */
  filterId?: string;
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

/**
 * Reads a key back into the entry and block it names. An agent-processed
 * entry's own id already carries a `#`, so the block index is what follows the
 * *last* one.
 */
export function parseBlockKey(key: string): { postId: string; index: number } | null {
  const cut = key.lastIndexOf("#");
  if (cut <= 0) return null;
  const index = Number(key.slice(cut + 1));
  return Number.isInteger(index) && index >= 0 ? { postId: key.slice(0, cut), index } : null;
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
 * Where one block ended up on the page, in PDF points with the origin at the
 * foot of the page. A block that flows across a column break has one of these
 * per column, so clicking any part of it in the preview finds it.
 */
export interface BlockPlacement {
  /** The `blockKey` of the block drawn here. */
  key: string;
  kind: Block["kind"];
  /** 0-based index of the page in the finished document. */
  page: number;
  x: number;
  /** The rectangle's bottom edge. */
  y: number;
  width: number;
  height: number;
}

/**
 * A generated digest, ready to preview and save. EPUB carries a standalone
 * HTML rendering of the book alongside the archive, since the preview pane
 * can't open the archive itself; a PDF carries the map of what was drawn
 * where, so the preview can turn a click into the block under it.
 */
export type GeneratedOutput =
  | { format: "pdf"; bytes: Uint8Array; placements: BlockPlacement[] }
  | { format: "epub"; bytes: Uint8Array; previewHtml: string };

/** Default file name (sans directory) for saving a generated digest. */
export function outputFileName(format: ExportFormat): string {
  return `substack-digest.${format}`;
}
