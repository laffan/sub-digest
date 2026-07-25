import type { Block, FontFamily, LayoutSettings } from "../types";

/**
 * XHTML generation for the EPUB exporter. Everything here produces
 * XML-well-formed markup: EPUB documents are parsed as XML, so an unescaped
 * `&` or a stray control character makes the whole book unreadable.
 */

const XML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

/**
 * Drops the characters XML 1.0 forbids: C0 controls (other than tab/CR/LF),
 * lone surrogates, and the two non-characters. Unlike the PDF path's
 * WinAnsi `sanitize`, everything else survives — EPUB is UTF-8, so emoji and
 * CJK make it into the book.
 */
function xmlSafe(text: string): string {
  let out = "";
  // Iterating a string yields whole surrogate pairs, so astral characters
  // (emoji) pass through and only *unpaired* surrogates are dropped.
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code === 0x09 || code === 0x0a || code === 0x0d) out += ch;
    else if (code < 0x20) continue;
    else if (code >= 0xd800 && code <= 0xdfff) continue;
    else if (code === 0xfffe || code === 0xffff) continue;
    else out += ch;
  }
  return out;
}

/** Escapes text for use in element content or an attribute value. */
export function esc(text: string): string {
  return xmlSafe(text).replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);
}

/**
 * Maps an image URL to the href to use in the markup, or null to omit the
 * image (not downloadable, or images are switched off).
 */
export interface ImageResolver {
  (src: string): string | null;
}

/** Renders content blocks as XHTML flow content. */
export function blocksToXhtml(blocks: Block[], resolveImage: ImageResolver): string {
  const out: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    switch (block.kind) {
      case "heading": {
        // h1 is the post title, so in-post headings start at h2.
        const level = Math.min(6, Math.max(2, block.level + 1));
        out.push(`<h${level}>${esc(block.text)}</h${level}>`);
        break;
      }
      case "para": {
        if (block.style === "quote") {
          out.push(`<blockquote><p>${esc(block.text)}</p></blockquote>`);
        } else if (block.style === "caption") {
          out.push(`<p class="caption">${esc(block.text)}</p>`);
        } else {
          out.push(`<p>${esc(block.text)}</p>`);
        }
        break;
      }
      case "list": {
        const tag = block.ordered ? "ol" : "ul";
        out.push(`<${tag}>`);
        for (const item of block.items) out.push(`  <li>${esc(item)}</li>`);
        out.push(`</${tag}>`);
        break;
      }
      case "image": {
        const href = resolveImage(block.src);
        if (!href) break;
        // A caption immediately after an image belongs inside its figure.
        const next = blocks[i + 1];
        const caption = next?.kind === "para" && next.style === "caption" ? next.text : null;
        if (caption !== null) i += 1;
        out.push(
          `<figure>`,
          `  <img src="${esc(href)}" alt=""/>`,
          ...(caption !== null ? [`  <figcaption>${esc(caption)}</figcaption>`] : []),
          `</figure>`
        );
        break;
      }
      case "rule": {
        out.push(`<hr class="rule"/>`);
        break;
      }
    }
  }
  return out.join("\n");
}

/** Wraps body content in an XHTML document referencing the shared stylesheet. */
export function xhtmlDocument(title: string, body: string, cssHref: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en" xml:lang="en">
<head>
  <meta charset="utf-8"/>
  <title>${esc(title)}</title>
  <link rel="stylesheet" type="text/css" href="${cssHref}"/>
</head>
<body>
${body}
</body>
</html>
`;
}

const FONT_STACKS: Record<FontFamily, string> = {
  Times: 'Georgia, "Times New Roman", Times, serif',
  Helvetica: '"Helvetica Neue", Helvetica, Arial, sans-serif',
  Courier: '"Courier New", Courier, monospace',
};

/**
 * The book's stylesheet. Sizes are relative — a reading device owns the base
 * font size — so the PDF's point size and page geometry have no analogue here;
 * the font family and line height carry over.
 */
export function epubCss(settings: LayoutSettings): string {
  return `/* Sub Digest */
html {
  font-family: ${FONT_STACKS[settings.font] ?? FONT_STACKS.Times};
}

body {
  margin: 0 5%;
  line-height: ${settings.lineHeight};
  text-align: justify;
  hyphens: auto;
  -epub-hyphens: auto;
}

p {
  margin: 0 0 0.35em;
  text-indent: 1.2em;
  widows: 2;
  orphans: 2;
}

/* First paragraph after a heading, quote, figure or rule starts flush left. */
h1 + p, h2 + p, h3 + p, h4 + p, h5 + p, h6 + p,
blockquote + p, figure + p, hr + p, .post-date + p {
  text-indent: 0;
}

h1, h2, h3, h4, h5, h6 {
  line-height: 1.2;
  text-align: left;
  page-break-after: avoid;
  break-after: avoid;
}

h1.post-title {
  font-size: 1.55em;
  margin: 0 0 0.2em;
}

h2 { font-size: 1.25em; margin: 1.1em 0 0.3em; }
h3 { font-size: 1.1em; margin: 1em 0 0.3em; }
h4, h5, h6 { font-size: 1em; margin: 1em 0 0.3em; }

.publication {
  font-size: 0.78em;
  font-weight: bold;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #6b6b73;
  margin: 0 0 0.4em;
  text-indent: 0;
  text-align: left;
}

.post-date {
  font-style: italic;
  font-size: 0.85em;
  color: #6b6b73;
  margin: 0 0 1.2em;
  text-indent: 0;
  text-align: left;
}

blockquote {
  margin: 0.6em 0 0.6em 1.2em;
  font-style: italic;
  color: #3f3f47;
}

blockquote p { text-indent: 0; }

ul, ol { margin: 0.4em 0 0.6em 1.4em; padding: 0; }
li { margin-bottom: 0.25em; text-align: left; }

figure {
  margin: 1em 0;
  text-align: center;
  page-break-inside: avoid;
  break-inside: avoid;
}

img {
  max-width: 100%;
  height: auto;
}

figcaption, .caption {
  font-style: italic;
  font-size: 0.82em;
  color: #6b6b73;
  text-align: center;
  text-indent: 0;
  margin: 0.3em 0 0;
}

hr.rule {
  border: 0;
  border-top: 1px solid #bfbfc4;
  width: 30%;
  margin: 1.4em auto;
}

/* Cover */
.cover {
  text-align: center;
  margin-top: 22%;
}

.cover .kicker {
  font-size: 0.8em;
  letter-spacing: 0.4em;
  color: #6b6b73;
  text-indent: 0;
  text-align: center;
}

.cover h1 {
  font-size: 2.6em;
  margin: 0.1em 0 0.3em;
  text-align: center;
}

.cover .rule {
  width: 100%;
  margin: 0.6em 0;
}

.cover .subtitle {
  font-style: italic;
  font-size: 0.9em;
  color: #6b6b73;
  text-indent: 0;
  text-align: center;
}

/* Table of contents */
nav h1 { font-size: 1.4em; margin: 0 0 0.8em; }
nav ol { list-style: none; margin: 0; padding: 0; }
nav li { margin-bottom: 0.6em; }
nav a { text-decoration: none; }
`;
}
