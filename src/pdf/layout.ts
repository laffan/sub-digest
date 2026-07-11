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
  doc.setTitle("Substack Digest");
  doc.setCreator("Sub Digest");

  const fonts = await embedFonts(doc, settings);
  const flow = new Flow(doc, settings, fonts);

  if (settings.coverPage && sorted.length > 0) {
    drawCover(flow, sorted);
    flow.finishPageForCover();
  }

  for (let i = 0; i < sorted.length; i++) {
    const post = sorted[i];
    onProgress(`Laying out ${i + 1}/${sorted.length}: ${post.title}`);
    await layoutPost(flow, post, settings);
  }

  flow.drawFooters(sorted);

  if (settings.bookletImposition) {
    onProgress("Imposing booklet sheets…");
    return imposeBooklet(await doc.save());
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
  private coverPages = 0;

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
    this.col = 0;
    this.y = this.pageH - this.mTop;
  }

  nextColumn() {
    this.ensureStarted();
    if (this.col + 1 < this.cols) {
      this.col += 1;
      this.y = this.pageH - this.mTop;
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

  /** Cover is drawn on its own page created by the caller. */
  finishPageForCover() {
    this.coverPages = this.doc.getPageCount();
    this.started = false; // next content draw starts a fresh page
  }

  drawFooters(posts: DigestPost[]) {
    if (!this.settings.pageNumbers) return;
    const pages = this.doc.getPages();
    const label = dateRangeLabel(posts);
    for (let i = this.coverPages; i < pages.length; i++) {
      const p = pages[i];
      const n = String(i + 1 - this.coverPages);
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

function drawParagraph(flow: Flow, text: string, opts: ParaOpts) {
  const clean = sanitize(text);
  if (!clean) return;
  const lh = (opts.lineHeight ?? 1.3) * opts.size;
  const indent = opts.indent ?? 0;
  const prefix = opts.hangingPrefix ?? "";
  const width = flow.colW - indent;
  const prefixW = prefix ? opts.font.widthOfTextAtSize(prefix, opts.size) : 0;
  const lines = wrapText(clean, opts.font, opts.size, width - prefixW);

  flow.ensureStarted();
  // Avoid a lone first line at the very bottom of a column
  flow.fit(Math.min(lines.length, 2) * lh);

  lines.forEach((line, i) => {
    if (flow.remaining < lh) flow.nextColumn();
    flow.advance(lh);
    if (i === 0 && prefix) {
      flow.page.drawText(prefix, {
        x: flow.colX + indent,
        y: flow.y,
        size: opts.size,
        font: opts.font,
        color: opts.color ?? INK,
      });
    }
    flow.page.drawText(line, {
      x: flow.colX + indent + prefixW,
      y: flow.y,
      size: opts.size,
      font: opts.font,
      color: opts.color ?? INK,
    });
  });
  flow.advance(opts.spaceAfter ?? opts.size * 0.5);
}

// ---------------------------------------------------------------------------
// Post layout

async function layoutPost(flow: Flow, post: DigestPost, s: LayoutSettings) {
  const body = s.fontSize;
  flow.ensureStarted();

  // Keep the header together: publication + title + date + a couple of lines
  const headerEstimate = body * 6;
  flow.fit(headerEstimate);

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
        drawImage(flow, pdfImage, prepared, body);
      }
      break;
    }
    case "rule": {
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

function drawImage(flow: Flow, pdfImage: PDFImage, img: PreparedImage, body: number) {
  // Scale to column width, and never taller than 60% of a column
  const maxH = flow.colHeight * 0.6;
  let w = flow.colW;
  let h = (img.height / img.width) * w;
  if (h > maxH) {
    h = maxH;
    w = (img.width / img.height) * h;
  }
  flow.fit(h + body);
  if (flow.remaining < h) {
    // Still too tall for a fresh column: shrink to what's available
    h = flow.remaining - body * 0.5;
    w = (img.width / img.height) * h;
    if (h < body * 2) return;
  }
  flow.advance(h);
  flow.page.drawImage(pdfImage, {
    x: flow.colX + (flow.colW - w) / 2,
    y: flow.y,
    width: w,
    height: h,
  });
  flow.advance(body * 0.6);
}

// ---------------------------------------------------------------------------
// Cover

function drawCover(flow: Flow, posts: DigestPost[]) {
  flow.addPage();
  const { pageW, pageH, fonts } = flow;
  const page = flow.page;
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

  let y = pageH * 0.72;
  center("SUBSTACK", y + 30, fonts.regular, 11, MUTED);
  center("Digest", y, fonts.bold, 40);
  page.drawLine({
    start: { x: pageW * 0.3, y: y - 16 },
    end: { x: pageW * 0.7, y: y - 16 },
    thickness: 1,
    color: RULE,
  });
  center(dateRangeLabel(posts), y - 38, fonts.italic, 11, MUTED);

  const pubs = [...new Set(posts.map((p) => p.publication))];
  const count = `${posts.length} post${posts.length === 1 ? "" : "s"} from ${pubs.length} publication${pubs.length === 1 ? "" : "s"}`;
  center(count, y - 58, fonts.regular, 9, MUTED);

  let listY = pageH * 0.42;
  for (const pub of pubs.slice(0, 14)) {
    center(pub, listY, fonts.regular, 9.5);
    listY -= 16;
  }
  if (pubs.length > 14) center(`+ ${pubs.length - 14} more`, listY, fonts.italic, 9, MUTED);
}

// ---------------------------------------------------------------------------
// Booklet imposition (2-up saddle stitch)

/**
 * Reorders pages onto double-width sheets so that printing double-sided
 * (flip on short edge) and folding the stack in half yields a booklet.
 */
async function imposeBooklet(contentBytes: Uint8Array): Promise<Uint8Array> {
  const src = await PDFDocument.load(contentBytes);
  const n = Math.ceil(src.getPageCount() / 4) * 4;
  const out = await PDFDocument.create();
  out.setTitle("Substack Digest (booklet)");

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
