import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFFont,
  PDFImage,
  PDFName,
  PDFNumber,
  PDFPage,
  StandardFonts,
  rgb,
  type RGB,
} from "pdf-lib";
import {
  byline,
  type Block,
  type DigestPost,
  type LayoutSettings,
  type PageSizeName,
  type PreparedImage,
} from "../types";
import { prepareImage } from "../images";
import { dateRangeLabel, formatLongDate } from "../dates";

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
  // The caller's order is the running order — the Organize step sets it, and
  // it starts out chronological.
  const sorted = posts;

  const doc = await PDFDocument.create();
  const title = dateRangeLabel(sorted) || "Substack Digest";
  doc.setTitle(title);
  doc.setCreator("Sub Digest");

  const fonts = await embedFonts(doc, settings);
  const flow = new Flow(doc, settings, fonts);

  // Content is laid out first so the table of contents can point at real page
  // numbers; the front matter is inserted ahead of it afterwards.
  const toc: TocEntry[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const post = sorted[i];
    onProgress(`Laying out ${i + 1}/${sorted.length}: ${post.title}`);
    const page = await layoutPost(flow, post, settings);
    toc.push({ byline: byline(post), title: post.title, dateMs: post.dateMs, page });
  }

  flow.drawFooters(sorted);

  if (settings.coverPage && sorted.length > 0) {
    drawFrontMatter(doc, flow, toc, sorted);
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

  /** The x/width available for a line at the current y. */
  lineBox(indent: number): { x: number; width: number } {
    return {
      x: this.colX + indent,
      width: Math.max(this.colW - indent, this.colW * 0.15),
    };
  }

  /**
   * Draws an image as a block of its own: text runs above and below it, never
   * beside it. It spans the column, unless holding its aspect ratio within the
   * height cap makes it narrower, in which case it's centred. Advances y past
   * the image.
   */
  placeImage(pdfImage: PDFImage, img: PreparedImage) {
    this.ensureStarted();
    let w = this.colW;
    let h = (img.height / img.width) * w;
    // A tall picture would otherwise take the column on its own; cap it so
    // there's room for text above and below it.
    const maxH = this.colHeight * 0.6;
    if (h > maxH) {
      h = maxH;
      w = (img.width / img.height) * h;
    }
    // Keep it whole: an image that doesn't fit here starts the next column
    // rather than running off the bottom of this one.
    this.fit(h);
    const x = this.colX + (this.colW - w) / 2;
    this.page.drawImage(pdfImage, { x, y: this.y - h, width: w, height: h });
    this.advance(h);
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
 * Lays out a paragraph line by line, taking the available width from the flow
 * each time, since a line can carry over into the next column.
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

  // Keep the header together. This has to measure the real wrapped height, not
  // guess: if the title spilled into the next column the page recorded below
  // would be the one holding a stranded byline, and the table of contents would
  // send readers a page early.
  const pubSize = body * 0.78;
  const titleSize = body * 1.55;
  const sourceSize = body * 0.7;
  const credit = sanitize(byline(post).toUpperCase());
  const pubLines = wrapText(credit, flow.fonts.bold, pubSize, flow.colW);
  const titleLines = wrapText(sanitize(post.title), flow.fonts.bold, titleSize, flow.colW);
  const sourceLines = post.sourceUrl
    ? wrapText(sanitize(post.sourceUrl), flow.fonts.regular, sourceSize, flow.colW).length
    : 0;
  const headerHeight =
    body * 2.6 + // separator rule and the space around it
    Math.max(pubLines.length, 1) * pubSize * 1.15 +
    body * 0.35 +
    Math.max(titleLines.length, 1) * titleSize * 1.12 +
    body * 0.35 +
    body * 0.82 * 1.15 + // date
    sourceLines * sourceSize * 1.15 +
    body * 0.9 +
    body * s.lineHeight * 2; // and enough body text that the header isn't stranded
  flow.fit(headerHeight);
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

  drawParagraph(flow, byline(post).toUpperCase(), {
    font: flow.fonts.bold,
    size: pubSize,
    color: MUTED,
    spaceAfter: body * 0.35,
    lineHeight: 1.15,
  });
  drawParagraph(flow, post.title, {
    font: flow.fonts.bold,
    size: titleSize,
    spaceAfter: body * 0.35,
    lineHeight: 1.12,
  });
  drawParagraph(flow, formatLongDate(post.dateMs), {
    font: flow.fonts.italic,
    size: body * 0.82,
    // The source line follows, so close the gap between the two.
    spaceAfter: post.sourceUrl ? body * 0.12 : body * 0.9,
    color: MUTED,
    lineHeight: 1.15,
  });
  // Where the text came from. In print a link isn't clickable, but it's the
  // only way back to the piece itself.
  if (post.sourceUrl) {
    drawParagraph(flow, post.sourceUrl, {
      font: flow.fonts.regular,
      size: sourceSize,
      color: MUTED,
      spaceAfter: body * 0.9,
      lineHeight: 1.15,
    });
  }

  for (const block of post.blocks) {
    await layoutBlock(flow, block, s);
  }
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
        flow.advance(body * 0.5);
        flow.placeImage(pdfImage, prepared);
        flow.advance(body * 0.6);
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

// ---------------------------------------------------------------------------
// Front matter: masthead + table of contents

interface TocEntry {
  /** The piece's author when the newsletter named one, else the publication. */
  byline: string;
  title: string;
  dateMs: number;
  page: number;
}

/** A contents entry's clickable area, resolved to a real page once all
 *  front-matter pages exist and the content's page offset is known. */
interface PendingLink {
  page: PDFPage;
  rect: [number, number, number, number];
  /** 1-based content page number, i.e. the number printed in the footer. */
  target: number;
}

/**
 * Draws the front matter ahead of the content: a masthead, then a table of
 * contents listing *every* post — continuing onto as many pages as it needs —
 * with each entry a clickable link to the page the post starts on.
 */
function drawFrontMatter(doc: PDFDocument, flow: Flow, toc: TocEntry[], posts: DigestPost[]) {
  const { pageW, pageH, fonts } = flow;
  const margin = Math.max(pageW * 0.09, 34);
  const width = pageW - margin * 2;
  const bottom = Math.max(pageH * 0.07, 30);
  const titleSize = Math.min(10.5, Math.max(8.5, pageH / 60));
  const metaSize = titleSize * 0.78;
  const pageNumW = fonts.bold.widthOfTextAtSize("000", titleSize) + 8;
  const titleW = width - pageNumW;
  const topY = pageH - Math.max(pageH * 0.1, 44);

  // Front matter goes ahead of the content, so the nth page inserts at index n.
  let frontCount = 0;
  const addFrontPage = (): PDFPage => doc.insertPage(frontCount++, [pageW, pageH]);

  let page = addFrontPage();
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
  center("S U B S T A C K", topY + 26, fonts.regular, 9, MUTED);
  center("Digest", topY, fonts.bold, 34);
  page.drawLine({
    start: { x: margin, y: topY - 14 },
    end: { x: pageW - margin, y: topY - 14 },
    thickness: 1,
    color: INK,
  });
  const pubs = [...new Set(posts.map((p) => p.publication))];
  const subtitle = `${dateRangeLabel(posts)}   ·   ${posts.length} post${posts.length === 1 ? "" : "s"} from ${pubs.length} publication${pubs.length === 1 ? "" : "s"}`;
  center(subtitle, topY - 30, fonts.italic, 9, MUTED);

  /** Starts a continuation page and returns the y to resume the list at. */
  const continuePage = (): number => {
    page = addFrontPage();
    page.drawText(sanitize("Contents, continued"), {
      x: margin,
      y: topY,
      size: metaSize,
      font: fonts.italic,
      color: MUTED,
    });
    page.drawLine({
      start: { x: margin, y: topY - 10 },
      end: { x: pageW - margin, y: topY - 10 },
      thickness: 0.6,
      color: RULE,
    });
    return topY - 10 - titleSize * 1.4;
  };

  // Contents
  const links: PendingLink[] = [];
  let y = topY - 64;
  let pageIsEmpty = false; // an entry taller than a page has to overflow somewhere

  for (const entry of toc) {
    // Titles wrap as far as they need to; the list flows onto another page
    // rather than cutting the digest's contents short.
    const lines = wrapText(sanitize(entry.title) || "(untitled)", fonts.bold, titleSize, titleW);
    const entryH = lines.length * titleSize * 1.25 + metaSize * 1.5 + titleSize * 0.9;
    if (y - entryH < bottom && !pageIsEmpty) {
      y = continuePage();
      pageIsEmpty = true;
    }
    const entryTop = y;

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
    const meta = `${entry.byline}  ·  ${new Date(entry.dateMs).toLocaleDateString(undefined, {
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
    links.push({
      page,
      rect: [margin, y - metaSize * 0.35, pageW - margin, entryTop],
      target: entry.page,
    });
    y -= titleSize * 0.9;
    pageIsEmpty = false;
  }

  // Content pages sit after the front matter, so a post that prints page n is
  // the document's (frontCount + n - 1)th page.
  for (const link of links) {
    addInternalLink(doc, link.page, link.rect, doc.getPage(frontCount + link.target - 1));
  }
}

/** Turns `rect` on `page` into a click target that jumps to `target`'s top. */
function addInternalLink(
  doc: PDFDocument,
  page: PDFPage,
  rect: [number, number, number, number],
  target: PDFPage
) {
  const annot = doc.context.obj({
    Type: "Annot",
    Subtype: "Link",
    Rect: rect,
    Border: [0, 0, 0], // the dot leader already reads as a link; no box drawn
    F: 4, // print
    Dest: [target.ref, "XYZ", null, target.getHeight(), null],
  });
  page.node.addAnnot(doc.context.register(annot));
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
  // Where each 1-based source page ended up, so its links can be re-created.
  const placed = new Map<number, { sheet: PDFPage; slot: 0 | 1 }>();
  const place = (sheet: PDFPage, pageNo: number, slot: 0 | 1) => {
    if (pageNo > embedded.length) return; // padding blank
    sheet.drawPage(embedded[pageNo - 1], { x: slot * pw, y: 0, width: pw, height: ph });
    placed.set(pageNo, { sheet, slot });
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

  reLinkImposedSheets(src, out, placed, pw, ph);
  return out.save();
}

/**
 * Rebuilds the contents' links on the imposed sheets. Embedding a page turns
 * it into a form XObject, which leaves its annotations behind — so each link is
 * re-created at its page's new offset, pointing at whichever sheet now carries
 * its destination.
 */
function reLinkImposedSheets(
  src: PDFDocument,
  out: PDFDocument,
  placed: Map<number, { sheet: PDFPage; slot: 0 | 1 }>,
  pw: number,
  ph: number
) {
  const pageNoOfRef = new Map<string, number>();
  src.getPages().forEach((p, i) => pageNoOfRef.set(p.ref.toString(), i + 1));

  src.getPages().forEach((page, i) => {
    const annots = page.node.Annots();
    const from = placed.get(i + 1);
    if (!annots || !from) return;

    for (let a = 0; a < annots.size(); a++) {
      const dict = src.context.lookupMaybe(annots.get(a), PDFDict);
      if (!dict || dict.get(PDFName.of("Subtype")) !== PDFName.of("Link")) continue;
      const rect = src.context.lookupMaybe(dict.get(PDFName.of("Rect")), PDFArray);
      const dest = src.context.lookupMaybe(dict.get(PDFName.of("Dest")), PDFArray);
      if (!rect || rect.size() < 4 || !dest || dest.size() < 1) continue;

      const to = placed.get(pageNoOfRef.get(dest.get(0).toString()) ?? 0);
      if (!to) continue;

      const [x0, y0, x1, y1] = [0, 1, 2, 3].map((k) =>
        (src.context.lookupMaybe(rect.get(k), PDFNumber) ?? PDFNumber.of(0)).asNumber()
      );
      const dx = from.slot * pw;
      const annot = out.context.obj({
        Type: "Annot",
        Subtype: "Link",
        Rect: [x0 + dx, y0, x1 + dx, y1],
        Border: [0, 0, 0],
        F: 4,
        Dest: [to.sheet.ref, "XYZ", to.slot * pw, ph, null],
      });
      from.sheet.node.addAnnot(out.context.register(annot));
    }
  });
}

