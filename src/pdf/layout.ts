import {
  PDFDocument,
  PDFFont,
  PDFImage,
  PDFPage,
  StandardFonts,
  rgb,
  type RGB,
} from "pdf-lib";
import type { Block, DigestPost, LayoutSettings, PageSizeName, PreparedImage } from "../types";
import { prepareImage } from "./images";

const MM = 72 / 25.4; // millimetres → points

const PAGE_SIZES: Record<PageSizeName, [number, number]> = {
  A5: [419.53, 595.28],
  HalfLetter: [396, 612],
  A4: [595.28, 841.89],
  Letter: [612, 792],
};

interface FontSet {
  regular: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
}

const INK = rgb(0.1, 0.1, 0.12);
const MUTED = rgb(0.42, 0.42, 0.46);
const RULE = rgb(0.75, 0.75, 0.78);

export interface GenerateProgress {
  (message: string): void;
}

/**
 * Lays selected posts out chronologically into a PDF. Returns the finished
 * document bytes (after optional saddle-stitch imposition).
 */
export async function generatePdf(
  posts: DigestPost[],
  settings: LayoutSettings,
  onProgress: GenerateProgress
): Promise<Uint8Array> {
  const sorted = [...posts].sort((a, b) => a.dateMs - b.dateMs);

  const doc = await PDFDocument.create();
  const title = dateRangeLabel(sorted) || "Substack Digest";
  doc.setTitle(title);
  doc.setCreator("Sub Digest");

  const fonts = await embedFonts(doc, settings);
  const flow = new Flow(doc, settings, fonts);

  // Content is laid out first so the cover's table of contents can point at
  // real page numbers; the cover is inserted in front afterwards.
  const toc: TocEntry[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const post = sorted[i];
    onProgress(`Laying out ${i + 1}/${sorted.length}: ${post.title}`);
    const page = await layoutPost(flow, post, settings);
    toc.push({ publication: post.publication, title: post.title, dateMs: post.dateMs, page });
  }

  flow.drawFooters(sorted);

  if (settings.coverPage && sorted.length > 0) {
    drawCover(doc, flow, toc, sorted);
  }

  if (settings.bookletImposition) {
    onProgress("Imposing booklet sheets…");
    return imposeBooklet(await doc.save(), title);
  }
  return doc.save();
}

async function embedFonts(doc: PDFDocument, s: LayoutSettings): Promise<FontSet> {
  const pick: Record<string, [StandardFonts, StandardFonts, StandardFonts]> = {
    Helvetica: [StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique],
    Times: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic],
    Courier: [StandardFonts.Courier, StandardFonts.CourierBold, StandardFonts.CourierOblique],
  };
  const [r, b, i] = pick[s.font] ?? pick.Times;
  return {
    regular: await doc.embedFont(r),
    bold: await doc.embedFont(b),
    italic: await doc.embedFont(i),
  };
}

/**
 * A floated image the text wraps around: it occupies one side of the column
 * from the current y down to `bottomY`; lines above `bottomY` are narrowed.
 */
interface FloatRegion {
  side: "left" | "right";
  width: number;
  gap: number;
  bottomY: number;
}

/**
 * Column-flow cursor over a growing document: tracks the current page,
 * column and y position, and adds columns/pages on demand.
 */
class Flow {
  readonly pageW: number;
  readonly pageH: number;
  readonly colW: number;
  private readonly cols: number;
  private readonly gap: number;
  private readonly mTop: number;
  private readonly mBottom: number;
  private readonly mLeft: number;
  private readonly mRight: number;

  page!: PDFPage;
  private col = 0;
  y = 0;
  private started = false;
  private pagesAdded = 0;

  /** The image the current text is wrapping around, if any. */
  activeFloat: FloatRegion | null = null;
  private floatCount = 0;

  constructor(
    private doc: PDFDocument,
    private settings: LayoutSettings,
    readonly fonts: FontSet
  ) {
    [this.pageW, this.pageH] = PAGE_SIZES[settings.pageSize];
    this.mTop = settings.marginTop * MM;
    this.mBottom = settings.marginBottom * MM;
    this.mLeft = settings.marginLeft * MM;
    this.mRight = settings.marginRight * MM;
    this.cols = settings.columns;
    this.gap = settings.columnGap * MM;
    const usable = this.pageW - this.mLeft - this.mRight;
    this.colW = (usable - this.gap * (this.cols - 1)) / this.cols;
  }

  get colX(): number {
    return this.mLeft + this.col * (this.colW + this.gap);
  }

  get bottom(): number {
    return this.mBottom;
  }

  get remaining(): number {
    return this.y - this.mBottom;
  }

  get colHeight(): number {
    return this.pageH - this.mTop - this.mBottom;
  }

  /** Ensures a page exists (first draw call creates it). */
  ensureStarted() {
    if (!this.started) {
      this.addPage();
      this.started = true;
    }
  }

  addPage() {
    this.page = this.doc.addPage([this.pageW, this.pageH]);
    this.pagesAdded += 1;
    this.col = 0;
    this.y = this.pageH - this.mTop;
    this.activeFloat = null; // a float never spans columns/pages
  }

  /** 1-based number of the page currently being drawn. */
  get pageNumber(): number {
    return this.pagesAdded;
  }

  nextColumn() {
    this.ensureStarted();
    if (this.col + 1 < this.cols) {
      this.col += 1;
      this.y = this.pageH - this.mTop;
      this.activeFloat = null;
    } else {
      this.addPage();
    }
  }

  /** Moves to the next column/page unless `height` points fit here. */
  fit(height: number) {
    this.ensureStarted();
    if (this.remaining < height && this.remaining < this.colHeight - 1) {
      this.nextColumn();
    }
  }

  advance(dy: number) {
    this.y -= dy;
  }

  embedJpg(bytes: Uint8Array): Promise<PDFImage> {
    return this.doc.embedJpg(bytes);
  }

  /** The x/width available for a line at the current y, accounting for a float. */
  lineBox(indent: number): { x: number; width: number } {
    let x0 = this.colX;
    let w = this.colW;
    const f = this.activeFloat;
    if (f && this.y > f.bottomY + 0.01) {
      const reserved = f.width + f.gap;
      if (f.side === "left") x0 = this.colX + reserved;
      w = this.colW - reserved;
    }
    return { x: x0 + indent, width: Math.max(w - indent, this.colW * 0.15) };
  }

  /** Ends the active float, dropping the cursor below the image if still beside it. */
  clearFloat() {
    if (this.activeFloat) {
      if (this.y > this.activeFloat.bottomY) this.y = this.activeFloat.bottomY;
      this.activeFloat = null;
    }
  }

  /**
   * Draws an image floated to the alternating side at ≤50% column width, and
   * records the region so subsequent text wraps beside it. Does not advance y.
   */
  placeFloat(pdfImage: PDFImage, img: PreparedImage, body: number) {
    this.ensureStarted();
    const gap = body * 0.7;
    let w = this.colW * 0.5;
    let h = (img.height / img.width) * w;
    const maxH = this.colHeight * 0.55;
    if (h > maxH) {
      h = maxH;
      w = (img.width / img.height) * h;
    }
    // Ensure vertical room; a fresh-but-too-short column shrinks, otherwise wrap.
    if (this.remaining < h + body * 0.5) {
      if (this.remaining >= this.colHeight - 1) {
        h = this.remaining - body * 0.5;
        w = (img.width / img.height) * h;
      } else {
        this.nextColumn();
      }
    }
    const side: "left" | "right" = this.floatCount % 2 === 0 ? "right" : "left";
    this.floatCount += 1;
    const x = side === "left" ? this.colX : this.colX + this.colW - w;
    const top = this.y;
    this.page.drawImage(pdfImage, { x, y: top - h, width: w, height: h });
    this.activeFloat = { side, width: w, gap, bottomY: top - h };
  }

  /** Numbers every page; called before the cover is inserted in front. */
  drawFooters(posts: DigestPost[]) {
    if (!this.settings.pageNumbers) return;
    const pages = this.doc.getPages();
    const label = dateRangeLabel(posts);
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      const n = String(i + 1);
      const f = this.fonts.regular;
      const size = 7.5;
      p.drawText(n, {
        x: (this.pageW - f.widthOfTextAtSize(n, size)) / 2,
        y: this.mBottom * 0.45,
        size,
        font: f,
        color: MUTED,
      });
      p.drawText(label, {
        x: this.mLeft,
        y: this.mBottom * 0.45,
        size: 6.5,
        font: this.fonts.italic,
        color: MUTED,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Text helpers

/**
 * pdf-lib's standard fonts use WinAnsi encoding; strip anything it can't
 * encode, mapping typographic characters to close equivalents first.
 */
export function sanitize(text: string): string {
  const map: Record<string, string> = {
    "‘": "‘", "’": "’", "“": "“", "”": "”",
    "–": "–", "—": "—", "…": "…", "•": "•",
    "™": "™", "˜": "~", "‹": "‹", "›": "›",
    "‚": "‚", "„": "„", "†": "†", "‡": "‡",
    "‰": "‰", "Œ": "Œ", "œ": "œ", "Š": "Š",
    "š": "š", "Ÿ": "Ÿ", "Ž": "Ž", "ž": "ž",
    "ƒ": "ƒ", "€": "€", "ˆ": "^",
    " ": " ", " ": " ", " ": " ", "​": "", "﻿": "",
    "❠": "*", "❤": "", "→": "->", "←": "<-",
  };
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code >= 32 && code <= 126) out += ch;
    else if (code >= 160 && code <= 255) out += ch;
    else if (ch in map) out += map[ch];
    // anything else (emoji, CJK, …) is dropped
  }
  return out.replace(/ {2,}/g, " ");
}

function wrapText(text: string, font: PDFFont, size: number, width: number): string[] {
  const words = text.split(" ").filter((w) => w.length > 0);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= width) {
      line = candidate;
    } else {
      if (line) lines.push(line);
      // Hard-break words wider than the column
      if (font.widthOfTextAtSize(word, size) > width) {
        let chunk = "";
        for (const ch of word) {
          if (font.widthOfTextAtSize(chunk + ch, size) > width && chunk) {
            lines.push(chunk);
            chunk = ch;
          } else {
            chunk += ch;
          }
        }
        line = chunk;
      } else {
        line = word;
      }
    }
  }
  if (line) lines.push(line);
  return lines;
}

interface ParaOpts {
  font: PDFFont;
  size: number;
  color?: RGB;
  spaceAfter?: number;
  indent?: number;
  lineHeight?: number;
  hangingPrefix?: string;
}

/** Greedily fits the largest chunk of `word` into `width`; returns [head, rest]. */
function hardBreak(word: string, font: PDFFont, size: number, width: number): [string, string] {
  let head = "";
  for (let i = 0; i < word.length; i++) {
    const next = head + word[i];
    if (head && font.widthOfTextAtSize(next, size) > width) {
      return [head, word.slice(i)];
    }
    head = next;
  }
  return [head, ""];
}

/**
 * Lays out a paragraph line by line, recomputing the available width for each
 * line so text wraps around any active floated image.
 */
function drawParagraph(flow: Flow, text: string, opts: ParaOpts) {
  const clean = sanitize(text);
  if (!clean) return;
  const { font, size, color = INK } = opts;
  const lh = (opts.lineHeight ?? 1.3) * size;
  const indent = opts.indent ?? 0;
  const prefix = opts.hangingPrefix ?? "";
  const prefixW = prefix ? font.widthOfTextAtSize(prefix, size) : 0;

  const words = clean.split(" ").filter((w) => w.length > 0);
  flow.ensureStarted();
  // Avoid a lone first line at the very bottom of a column
  flow.fit(Math.min(words.length, 2) * lh);

  let first = true;
  let idx = 0;
  while (idx < words.length) {
    if (flow.remaining < lh) flow.nextColumn();
    flow.advance(lh);

    const box = flow.lineBox(indent);
    const usePrefix = first && prefix.length > 0;
    const avail = box.width - (usePrefix ? prefixW : 0);

    // Greedily accumulate words that fit the current line's available width.
    let line = "";
    while (idx < words.length) {
      const candidate = line ? `${line} ${words[idx]}` : words[idx];
      if (font.widthOfTextAtSize(candidate, size) <= avail) {
        line = candidate;
        idx += 1;
      } else if (!line) {
        // A single word wider than the line: break it across characters.
        const [head, rest] = hardBreak(words[idx], font, size, avail);
        line = head;
        if (rest) words[idx] = rest;
        else idx += 1;
        break;
      } else {
        break;
      }
    }

    const textX = box.x + (usePrefix ? prefixW : 0);
    if (usePrefix) {
      flow.page.drawText(prefix, { x: box.x, y: flow.y, size, font, color });
    }
    if (line) flow.page.drawText(line, { x: textX, y: flow.y, size, font, color });
    first = false;
  }
  flow.advance(opts.spaceAfter ?? size * 0.5);
}

// ---------------------------------------------------------------------------
// Post layout

/** Lays out one post and returns the 1-based page number it starts on. */
async function layoutPost(flow: Flow, post: DigestPost, s: LayoutSettings): Promise<number> {
  const body = s.fontSize;
  flow.ensureStarted();
  flow.clearFloat(); // a prior post's float never carries into this one

  // Keep the header together: publication + title + date + a couple of lines
  const headerEstimate = body * 6;
  flow.fit(headerEstimate);
  const startPage = flow.pageNumber;

  // Separator above subsequent posts in the same column
  if (flow.remaining < flow.colHeight - 1) {
    flow.advance(body * 1.4);
    flow.page.drawLine({
      start: { x: flow.colX, y: flow.y },
      end: { x: flow.colX + flow.colW, y: flow.y },
      thickness: 0.6,
      color: RULE,
    });
    flow.advance(body * 1.2);
  }

  drawParagraph(flow, post.publication.toUpperCase(), {
    font: flow.fonts.bold,
    size: body * 0.78,
    color: MUTED,
    spaceAfter: body * 0.35,
    lineHeight: 1.15,
  });
  drawParagraph(flow, post.title, {
    font: flow.fonts.bold,
    size: body * 1.55,
    spaceAfter: body * 0.35,
    lineHeight: 1.12,
  });
  drawParagraph(flow, formatDate(post.dateMs), {
    font: flow.fonts.italic,
    size: body * 0.82,
    color: MUTED,
    spaceAfter: body * 0.9,
    lineHeight: 1.15,
  });

  for (const block of post.blocks) {
    await layoutBlock(flow, block, s);
  }
  flow.clearFloat(); // drop below any trailing floated image before the next post
  return startPage;
}

async function layoutBlock(flow: Flow, block: Block, s: LayoutSettings) {
  const body = s.fontSize;
  const lh = s.lineHeight;
  switch (block.kind) {
    case "heading": {
      const size = block.level <= 2 ? body * 1.25 : body * 1.08;
      flow.fit(size * 3.2);
      flow.advance(body * 0.5);
      drawParagraph(flow, block.text, {
        font: flow.fonts.bold,
        size,
        spaceAfter: body * 0.4,
        lineHeight: 1.15,
      });
      break;
    }
    case "para": {
      if (block.style === "quote") {
        drawParagraph(flow, block.text, {
          font: flow.fonts.italic,
          size: body,
          indent: body * 1.2,
          color: rgb(0.25, 0.25, 0.3),
          spaceAfter: body * 0.55,
          lineHeight: lh,
        });
      } else if (block.style === "caption") {
        drawParagraph(flow, block.text, {
          font: flow.fonts.italic,
          size: body * 0.82,
          color: MUTED,
          spaceAfter: body * 0.7,
          lineHeight: 1.2,
        });
      } else {
        drawParagraph(flow, block.text, {
          font: flow.fonts.regular,
          size: body,
          spaceAfter: body * 0.55,
          lineHeight: lh,
        });
      }
      break;
    }
    case "list": {
      block.items.forEach((item, i) => {
        drawParagraph(flow, item, {
          font: flow.fonts.regular,
          size: body,
          indent: body * 0.9,
          hangingPrefix: block.ordered ? `${i + 1}. ` : "• ",
          spaceAfter: body * 0.3,
          lineHeight: lh,
        });
      });
      flow.advance(body * 0.3);
      break;
    }
    case "image": {
      if (!s.includeImages) break;
      const prepared = await prepareImage(block.src);
      if (prepared) {
        const pdfImage = await flow.embedJpg(prepared.jpeg);
        flow.clearFloat(); // stack floats vertically rather than overlapping
        flow.advance(body * 0.4);
        flow.placeFloat(pdfImage, prepared, body);
      }
      break;
    }
    case "rule": {
      flow.clearFloat();
      flow.fit(body * 2);
      flow.advance(body);
      const cx = flow.colX + flow.colW / 2;
      flow.page.drawLine({
        start: { x: cx - flow.colW * 0.15, y: flow.y },
        end: { x: cx + flow.colW * 0.15, y: flow.y },
        thickness: 0.6,
        color: RULE,
      });
      flow.advance(body);
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Cover: masthead + table of contents

interface TocEntry {
  publication: string;
  title: string;
  dateMs: number;
  page: number;
}

function drawCover(doc: PDFDocument, flow: Flow, toc: TocEntry[], posts: DigestPost[]) {
  const { pageW, pageH, fonts } = flow;
  const page = doc.insertPage(0, [pageW, pageH]);

  const margin = Math.max(pageW * 0.09, 34);
  const width = pageW - margin * 2;
  const center = (text: string, y: number, font: PDFFont, size: number, color = INK) => {
    const t = sanitize(text);
    page.drawText(t, {
      x: (pageW - font.widthOfTextAtSize(t, size)) / 2,
      y,
      size,
      font,
      color,
    });
  };

  // Masthead
  const mastY = pageH - Math.max(pageH * 0.1, 44);
  center("S U B S T A C K", mastY + 26, fonts.regular, 9, MUTED);
  center("Digest", mastY, fonts.bold, 34);
  page.drawLine({
    start: { x: margin, y: mastY - 14 },
    end: { x: pageW - margin, y: mastY - 14 },
    thickness: 1,
    color: INK,
  });
  const pubs = [...new Set(posts.map((p) => p.publication))];
  const subtitle = `${dateRangeLabel(posts)}   ·   ${posts.length} post${posts.length === 1 ? "" : "s"} from ${pubs.length} publication${pubs.length === 1 ? "" : "s"}`;
  center(subtitle, mastY - 30, fonts.italic, 9, MUTED);

  // Contents
  let y = mastY - 64;
  const bottom = Math.max(pageH * 0.07, 30);
  const titleSize = Math.min(10.5, Math.max(8.5, pageH / 60));
  const metaSize = titleSize * 0.78;
  const pageNumW = fonts.bold.widthOfTextAtSize("000", titleSize) + 8;
  const titleW = width - pageNumW;

  for (let i = 0; i < toc.length; i++) {
    const entry = toc[i];
    const title = sanitize(entry.title);
    let lines = wrapText(title, fonts.bold, titleSize, titleW);
    if (lines.length > 2) {
      lines = lines.slice(0, 2);
      lines[1] = truncateToWidth(`${lines[1]}…`, fonts.bold, titleSize, titleW);
    }
    const entryH = lines.length * titleSize * 1.25 + metaSize * 1.5 + titleSize * 0.9;

    // Out of room: summarize the rest instead of overflowing
    if (y - entryH < bottom) {
      const rest = toc.length - i;
      page.drawText(sanitize(`+ ${rest} more post${rest === 1 ? "" : "s"} inside`), {
        x: margin,
        y: Math.max(y - titleSize * 1.4, bottom),
        size: metaSize,
        font: fonts.italic,
        color: MUTED,
      });
      break;
    }

    // Title lines, with the page number and dot leader on the first line
    for (let l = 0; l < lines.length; l++) {
      y -= titleSize * 1.25;
      page.drawText(lines[l], {
        x: margin,
        y,
        size: titleSize,
        font: fonts.bold,
        color: INK,
      });
      if (l === 0) {
        const num = String(entry.page);
        const numX = pageW - margin - fonts.bold.widthOfTextAtSize(num, titleSize);
        page.drawText(num, { x: numX, y, size: titleSize, font: fonts.bold, color: INK });
        drawDotLeader(
          page,
          margin + fonts.bold.widthOfTextAtSize(lines[l], titleSize) + 5,
          numX - 5,
          y,
          fonts.regular,
          titleSize
        );
      }
    }

    y -= metaSize * 1.5;
    const meta = `${entry.publication}  ·  ${new Date(entry.dateMs).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    })}`;
    page.drawText(truncateToWidth(sanitize(meta), fonts.italic, metaSize, titleW), {
      x: margin,
      y,
      size: metaSize,
      font: fonts.italic,
      color: MUTED,
    });
    y -= titleSize * 0.9;
  }
}

function drawDotLeader(
  page: PDFPage,
  x0: number,
  x1: number,
  y: number,
  font: PDFFont,
  size: number
) {
  const dotW = font.widthOfTextAtSize(" .", size);
  const count = Math.floor((x1 - x0) / dotW);
  if (count < 2) return;
  page.drawText(" .".repeat(count), {
    x: x1 - count * dotW,
    y,
    size,
    font,
    color: RULE,
  });
}

function truncateToWidth(text: string, font: PDFFont, size: number, width: number): string {
  if (font.widthOfTextAtSize(text, size) <= width) return text;
  let t = text;
  while (t.length > 1 && font.widthOfTextAtSize(`${t}…`, size) > width) {
    t = t.slice(0, -1).trimEnd();
  }
  return `${t}…`;
}

// ---------------------------------------------------------------------------
// Booklet imposition (2-up saddle stitch)

/**
 * Reorders pages onto double-width sheets so that printing double-sided
 * (flip on short edge) and folding the stack in half yields a booklet.
 */
async function imposeBooklet(contentBytes: Uint8Array, title: string): Promise<Uint8Array> {
  const src = await PDFDocument.load(contentBytes);
  const n = Math.ceil(src.getPageCount() / 4) * 4;
  const out = await PDFDocument.create();
  out.setTitle(title);

  const [pw, ph] = [src.getPage(0).getWidth(), src.getPage(0).getHeight()];
  const embedded = await out.embedPages(src.getPages());
  const place = (sheet: PDFPage, pageNo: number, slot: 0 | 1) => {
    if (pageNo > embedded.length) return; // padding blank
    sheet.drawPage(embedded[pageNo - 1], { x: slot * pw, y: 0, width: pw, height: ph });
  };

  // Side s (1-indexed): odd sides put the high page on the left
  for (let s2 = 1; s2 <= n / 2; s2++) {
    const sheet = out.addPage([pw * 2, ph]);
    const high = n - (s2 - 1);
    const low = s2;
    if (s2 % 2 === 1) {
      place(sheet, high, 0);
      place(sheet, low, 1);
    } else {
      place(sheet, low, 0);
      place(sheet, high, 1);
    }
  }
  return out.save();
}

// ---------------------------------------------------------------------------

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export function dateRangeLabel(posts: DigestPost[]): string {
  if (posts.length === 0) return "";
  const times = posts.map((p) => p.dateMs);
  const fmt = (ms: number) =>
    new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  const lo = fmt(Math.min(...times));
  const hi = fmt(Math.max(...times));
  return lo === hi ? lo : `${lo} – ${hi}`;
}
