import { strToU8, zipSync, type Zippable } from "fflate";
import { dateRangeLabel, formatLongDate, formatShortDate, isoDay } from "../dates";
import { prepareImage } from "../images";
import type { DigestPost, GeneratedOutput, LayoutSettings } from "../types";
import { blocksToXhtml, epubCss, esc, xhtmlDocument, type ImageResolver } from "./xhtml";

/**
 * EPUB 3 export. Posts become chapters in the same chronological order the PDF
 * uses, so the two formats hold the same digest; unlike the PDF the text stays
 * UTF-8 (emoji and CJK survive) and reflows to the reader's own type settings.
 */

export interface GenerateProgress {
  (message: string): void;
}

/** One fetched, re-encoded image and where it lives inside the archive. */
interface EpubImage {
  /** Path relative to the OPS directory, e.g. `images/img001.jpg`. */
  href: string;
  id: string;
  jpeg: Uint8Array;
}

const OPS = "OEBPS";

export async function generateEpub(
  posts: DigestPost[],
  settings: LayoutSettings,
  onProgress: GenerateProgress
): Promise<Extract<GeneratedOutput, { format: "epub" }>> {
  // Chapter order is the caller's order, set in the Organize step.
  const sorted = posts;
  const range = dateRangeLabel(sorted);
  const title = range ? `Substack Digest, ${range}` : "Substack Digest";
  const publications = [...new Set(sorted.map((p) => p.publication))];

  const images: Map<string, EpubImage> = settings.includeImages
    ? await collectImages(sorted, onProgress)
    : new Map();
  onProgress("Building EPUB…");

  const css = epubCss(settings);
  const chapters = sorted.map((post, i) => {
    const file = `text/ch${pad(i + 1)}.xhtml`;
    const body = chapterBody(post, `ch${pad(i + 1)}`, (src) => {
      const img = images.get(src);
      return img ? `../${img.href}` : null;
    });
    return { id: `ch${pad(i + 1)}`, file, title: post.title, post, body };
  });

  const files: Zippable = {
    // The OCF spec requires `mimetype` first in the archive and uncompressed.
    mimetype: [strToU8("application/epub+zip"), { level: 0 }],
    "META-INF/container.xml": strToU8(containerXml()),
    [`${OPS}/style.css`]: strToU8(css),
  };

  const spine: string[] = [];
  const manifest: string[] = [
    `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
    `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`,
    `<item id="css" href="style.css" media-type="text/css"/>`,
  ];

  // Front matter: a title page and a contents page, matching the PDF's cover.
  const coverHtml = settings.coverPage ? coverBody(sorted, range, publications.length) : null;
  if (coverHtml) {
    files[`${OPS}/cover.xhtml`] = strToU8(xhtmlDocument(title, coverHtml, "style.css"));
    manifest.push(`<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="cover"/>`);
    // The nav document doubles as a readable contents page.
    spine.push(`<itemref idref="nav"/>`);
  }

  for (const ch of chapters) {
    files[`${OPS}/${ch.file}`] = strToU8(xhtmlDocument(ch.title, ch.body, "../style.css"));
    manifest.push(
      `<item id="${ch.id}" href="${ch.file}" media-type="application/xhtml+xml"/>`
    );
    spine.push(`<itemref idref="${ch.id}"/>`);
  }

  for (const img of images.values()) {
    // JPEG is already compressed; deflating it again just burns time.
    files[`${OPS}/${img.href}`] = [img.jpeg, { level: 0 }];
    manifest.push(`<item id="${img.id}" href="${img.href}" media-type="image/jpeg"/>`);
  }

  const bookId = uuidUrn();
  files[`${OPS}/nav.xhtml`] = strToU8(
    xhtmlDocument("Contents", navBody(chapters, !!coverHtml), "style.css")
  );
  files[`${OPS}/toc.ncx`] = strToU8(ncx(bookId, title, chapters, !!coverHtml));
  files[`${OPS}/package.opf`] = strToU8(
    packageOpf({ bookId, title, publications, posts: sorted, manifest, spine })
  );

  return {
    format: "epub",
    bytes: zipSync(files),
    previewHtml: previewDocument(title, css, coverHtml, chapters, images),
  };
}

// ---------------------------------------------------------------------------
// Images

/**
 * Fetches and re-encodes every distinct image once, in reading order.
 * Undownloadable images are simply left out of the book.
 */
async function collectImages(
  posts: DigestPost[],
  onProgress: GenerateProgress
): Promise<Map<string, EpubImage>> {
  const srcs: string[] = [];
  const seen = new Set<string>();
  for (const post of posts) {
    for (const block of post.blocks) {
      if (block.kind === "image" && !seen.has(block.src)) {
        seen.add(block.src);
        srcs.push(block.src);
      }
    }
  }

  const images = new Map<string, EpubImage>();
  for (let i = 0; i < srcs.length; i++) {
    onProgress(`Fetching image ${i + 1}/${srcs.length}…`);
    const prepared = await prepareImage(srcs[i]);
    if (!prepared) continue;
    const n = pad(images.size + 1);
    images.set(srcs[i], { id: `img${n}`, href: `images/img${n}.jpg`, jpeg: prepared.jpeg });
  }
  return images;
}

// ---------------------------------------------------------------------------
// Content documents

interface Chapter {
  id: string;
  file: string;
  title: string;
  post: DigestPost;
  body: string;
}

function chapterBody(post: DigestPost, id: string, resolveImage: ImageResolver): string {
  return [
    `<section class="post" epub:type="chapter" id="${id}">`,
    `<p class="publication">${esc(post.publication)}</p>`,
    `<h1 class="post-title">${esc(post.title)}</h1>`,
    `<p class="post-date">${esc(formatLongDate(post.dateMs))}</p>`,
    blocksToXhtml(post.blocks, resolveImage),
    `</section>`,
  ].join("\n");
}

function coverBody(posts: DigestPost[], range: string, publicationCount: number): string {
  const subtitle = `${range}   ·   ${plural(posts.length, "post")} from ${plural(
    publicationCount,
    "publication"
  )}`;
  return [
    `<section class="cover" epub:type="titlepage">`,
    `<p class="kicker">SUBSTACK</p>`,
    `<h1>Digest</h1>`,
    `<hr class="rule"/>`,
    `<p class="subtitle">${esc(subtitle)}</p>`,
    `</section>`,
  ].join("\n");
}

/**
 * The list of contents entries — one per post, never abridged. The publication
 * and date ride *inside* the entry: a nav `li` may hold only a single `a`/`span`
 * (plus a nested list), so they can't be siblings of the link.
 *
 * `hrefFor` returns null for the preview copy, which renders each entry as a
 * span instead: a fragment link inside the preview's sandboxed `srcdoc` frame
 * reloads it blank rather than scrolling.
 */
function tocList(chapters: Chapter[], hrefFor: (ch: Chapter) => string | null): string {
  const items = chapters
    .map((ch) => {
      const href = hrefFor(ch);
      const [open, close] = href === null ? ["<span>", "</span>"] : [`<a href="${esc(href)}">`, "</a>"];
      return (
        `    <li>${open}<span class="toc-title">${esc(ch.title)}</span>` +
        `<span class="toc-meta">${esc(
          `${ch.post.publication}  ·  ${formatShortDate(ch.post.dateMs)}`
        )}</span>${close}</li>`
      );
    })
    .join("\n");
  return `  <ol>\n${items}\n  </ol>`;
}

/** The EPUB 3 navigation document: the reader's table of contents. */
function navBody(chapters: Chapter[], hasCover: boolean): string {
  const landmarks = [
    ...(hasCover ? [`    <li><a epub:type="cover" href="cover.xhtml">Cover</a></li>`] : []),
    `    <li><a epub:type="toc" href="nav.xhtml">Contents</a></li>`,
    ...(chapters.length > 0
      ? [`    <li><a epub:type="bodymatter" href="${chapters[0].file}">Start reading</a></li>`]
      : []),
  ].join("\n");

  return `<nav epub:type="toc" id="toc">
  <h1>Contents</h1>
${tocList(chapters, (ch) => ch.file)}
</nav>
<nav epub:type="landmarks" id="landmarks" hidden="hidden">
  <h2>Landmarks</h2>
  <ol>
${landmarks}
  </ol>
</nav>`;
}

// ---------------------------------------------------------------------------
// Package metadata

function containerXml(): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="${OPS}/package.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;
}

interface OpfInput {
  bookId: string;
  title: string;
  publications: string[];
  posts: DigestPost[];
  manifest: string[];
  spine: string[];
}

function packageOpf({ bookId, title, publications, posts, manifest, spine }: OpfInput): string {
  const creators = publications
    .map((p, i) => `    <dc:creator id="creator${i + 1}">${esc(p)}</dc:creator>`)
    .join("\n");
  const newest = posts.length > 0 ? Math.max(...posts.map((p) => p.dateMs)) : Date.now();
  return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="en">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">${esc(bookId)}</dc:identifier>
    <dc:title>${esc(title)}</dc:title>
    <dc:language>en</dc:language>
${creators}
    <dc:date>${isoDay(newest)}</dc:date>
    <dc:publisher>Sub Digest</dc:publisher>
    <meta property="dcterms:modified">${timestamp()}</meta>
  </metadata>
  <manifest>
${manifest.map((item) => `    ${item}`).join("\n")}
  </manifest>
  <spine toc="ncx">
${spine.map((ref) => `    ${ref}`).join("\n")}
  </spine>
</package>
`;
}

/**
 * The EPUB 2 NCX table of contents. Superseded by the navigation document, but
 * older readers (and Kindle conversion) still look for it.
 */
function ncx(bookId: string, title: string, chapters: Chapter[], hasCover: boolean): string {
  const points: string[] = [];
  const push = (label: string, src: string) => {
    const n = points.length + 1;
    points.push(
      `    <navPoint id="navpoint-${n}" playOrder="${n}">`,
      `      <navLabel><text>${esc(label)}</text></navLabel>`,
      `      <content src="${src}"/>`,
      `    </navPoint>`
    );
  };
  if (hasCover) push("Cover", "cover.xhtml");
  for (const ch of chapters) push(ch.title, ch.file);

  return `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="en">
  <head>
    <meta name="dtb:uid" content="${esc(bookId)}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${esc(title)}</text></docTitle>
  <navMap>
${points.join("\n")}
  </navMap>
</ncx>
`;
}

// ---------------------------------------------------------------------------
// In-app preview

/**
 * A single self-contained HTML document showing the whole book, used by the
 * preview pane (which can't open the archive). Same markup and stylesheet as
 * the EPUB, with images inlined as data URLs.
 */
function previewDocument(
  title: string,
  css: string,
  coverHtml: string | null,
  chapters: Chapter[],
  images: Map<string, EpubImage>
): string {
  const dataUrls = new Map<string, string>();
  for (const [src, img] of images) dataUrls.set(src, jpegDataUrl(img.jpeg));

  // The contents page is part of the book, so the preview shows it too.
  const contents = coverHtml
    ? `<nav id="toc">\n  <h1>Contents</h1>\n${tocList(chapters, () => null)}\n</nav>`
    : null;

  const sheets = [
    ...(coverHtml ? [coverHtml] : []),
    ...(contents ? [contents] : []),
    ...chapters.map((ch) =>
      chapterBody(ch.post, `preview-${ch.id}`, (src) => dataUrls.get(src) ?? null)
    ),
  ];

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(title)}</title>
<style>
${css}
/* Preview chrome: each document as its own sheet, not a paginated page. */
body { margin: 0; padding: 18px 14px; background: transparent; }
.sheet {
  background: #fff;
  color: #1a1a1f;
  max-width: 34em;
  margin: 0 auto 18px;
  padding: 26px 28px;
  border-radius: 2px;
  box-shadow: 0 1px 3px rgba(30, 25, 15, 0.12), 0 6px 18px rgba(30, 25, 15, 0.1);
}
.sheet .cover { margin-top: 8%; margin-bottom: 8%; }
</style>
</head>
<body>
${sheets.map((s) => `<div class="sheet">\n${s}\n</div>`).join("\n")}
</body>
</html>
`;
}

function jpegDataUrl(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:image/jpeg;base64,${btoa(bin)}`;
}

// ---------------------------------------------------------------------------

function pad(n: number): string {
  return String(n).padStart(3, "0");
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** `dcterms:modified` must be a whole-second UTC timestamp. */
function timestamp(): string {
  return `${new Date().toISOString().slice(0, 19)}Z`;
}

/** A fresh identifier per generated book, as EPUB requires a unique one. */
function uuidUrn(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === "function") return `urn:uuid:${c.randomUUID()}`;
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant
  const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `urn:uuid:${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20
  )}-${hex.slice(20)}`;
}
