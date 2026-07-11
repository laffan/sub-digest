import type { Block } from "./types";

/**
 * Extracts readable content blocks from a Substack newsletter email.
 * Substack HTML varies over time, so this works from a prioritized list of
 * known content containers and falls back to the whole body, then strips
 * chrome (buttons, share widgets, footers) before walking block elements.
 */
export function parseEmailHtml(html: string, subject: string): Block[] {
  const doc = new DOMParser().parseFromString(html, "text/html");

  const container =
    doc.querySelector(
      [
        ".post-content",
        ".body.markup",
        "div.markup",
        "td.post",
        "div.post",
        ".email-body-container",
        ".message-content",
      ].join(", ")
    ) ?? doc.body;

  stripChrome(container);

  const blocks: Block[] = [];
  walk(container, blocks);

  // Drop a leading heading that repeats the subject; the layout engine
  // draws its own post header with the title.
  if (blocks.length > 0 && blocks[0].kind === "heading") {
    if (normalize(blocks[0].text) === normalize(subject)) blocks.shift();
  }

  return coalesce(blocks);
}

/** Fallback for plain-text-only emails. */
export function parsePlainText(text: string): Block[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 0 && !isNoiseText(p))
    .map((p): Block => ({ kind: "para", text: p }));
}

const NOISE_SELECTORS = [
  "script",
  "style",
  "head",
  ".post-header",
  ".preamble",
  ".subscription-widget-wrap",
  ".subscription-widget",
  ".subscribe-widget",
  ".button-wrapper",
  ".button",
  ".email-ufi-2-top",
  ".email-ufi-2-bottom",
  "table.email-ufi-2",
  ".footer",
  ".email-footer",
  ".email-footer-container",
  ".post-cta",
  ".community-highlight",
  ".share-dialog",
  ".comments-section",
  ".poll-embed",
  ".digest-post-embed",
  ".embedded-post-wrap",
  ".pencraft", // web-app chrome occasionally embedded
  "[data-component-name='SubscribeWidget']",
].join(", ");

const NOISE_LINK_RE =
  /^(unsubscribe|view in browser|read in app|share|comment|like|restack|subscribe( now)?|upgrade to paid|leave a comment|share this post|listen (on|now)|watch (on|now)|get the app|start writing|read more|view comments?)$/i;

function stripChrome(root: Element) {
  root.querySelectorAll(NOISE_SELECTORS).forEach((el) => el.remove());
  root.querySelectorAll("a").forEach((a) => {
    const t = normalize(a.textContent ?? "");
    if (NOISE_LINK_RE.test(t)) a.remove();
  });
}

function isNoiseText(t: string): boolean {
  return NOISE_LINK_RE.test(t.trim()) || /^©/.test(t.trim());
}

const BLOCK_TAGS = new Set([
  "P",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "BLOCKQUOTE",
  "UL",
  "OL",
  "FIGURE",
  "IMG",
  "HR",
  "PRE",
]);

function walk(node: Element, out: Block[]) {
  for (const child of Array.from(node.children)) {
    const tag = child.tagName;
    if (BLOCK_TAGS.has(tag)) {
      emit(child, out);
    } else if (
      tag === "DIV" ||
      tag === "TABLE" ||
      tag === "TBODY" ||
      tag === "TR" ||
      tag === "TD" ||
      tag === "SECTION" ||
      tag === "ARTICLE" ||
      tag === "SPAN" ||
      tag === "CENTER"
    ) {
      // Structural wrapper: recurse, but if it contains no block children and
      // has direct text, treat it as a paragraph.
      if (child.querySelector("p, h1, h2, h3, h4, h5, h6, blockquote, ul, ol, img, figure, hr")) {
        walk(child, out);
      } else {
        const text = textOf(child);
        if (text) out.push({ kind: "para", text });
      }
    }
  }
}

function emit(el: Element, out: Block[]) {
  switch (el.tagName) {
    case "H1":
    case "H2":
    case "H3":
    case "H4":
    case "H5":
    case "H6": {
      const text = textOf(el);
      if (text) out.push({ kind: "heading", level: Number(el.tagName[1]), text });
      break;
    }
    case "P":
    case "PRE": {
      const img = el.querySelector("img");
      if (img) emitImage(img, out);
      const text = textOf(el);
      if (text && !isNoiseText(text)) out.push({ kind: "para", text });
      break;
    }
    case "BLOCKQUOTE": {
      const paras = el.querySelectorAll("p");
      if (paras.length === 0) {
        const text = textOf(el);
        if (text) out.push({ kind: "para", text, style: "quote" });
      } else {
        paras.forEach((p) => {
          const text = textOf(p);
          if (text) out.push({ kind: "para", text, style: "quote" });
        });
      }
      break;
    }
    case "UL":
    case "OL": {
      const items = Array.from(el.querySelectorAll(":scope > li"))
        .map((li) => textOf(li))
        .filter((t): t is string => !!t);
      if (items.length) out.push({ kind: "list", items, ordered: el.tagName === "OL" });
      break;
    }
    case "FIGURE": {
      const img = el.querySelector("img");
      if (img) emitImage(img, out);
      const cap = el.querySelector("figcaption");
      const capText = cap ? textOf(cap) : null;
      if (capText) out.push({ kind: "para", text: capText, style: "caption" });
      break;
    }
    case "IMG":
      emitImage(el as HTMLImageElement, out);
      break;
    case "HR":
      out.push({ kind: "rule" });
      break;
  }
}

function emitImage(img: Element, out: Block[]) {
  const src = img.getAttribute("src") ?? "";
  if (!src.startsWith("http")) return;
  // Skip tracking pixels and UI glyphs
  const w = Number(img.getAttribute("width") || "0");
  const h = Number(img.getAttribute("height") || "0");
  if ((w > 0 && w <= 3) || (h > 0 && h <= 3)) return;
  if (/\/emails\/open|\/o\/e|pixel|spacer|icons?\//i.test(src)) return;
  out.push({ kind: "image", src });
}

function textOf(el: Element): string | null {
  const t = (el.textContent ?? "").replace(/\s+/g, " ").trim();
  return t.length > 0 ? t : null;
}

function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Merge consecutive duplicate images / rules and drop empty leftovers. */
function coalesce(blocks: Block[]): Block[] {
  const out: Block[] = [];
  for (const b of blocks) {
    const prev = out[out.length - 1];
    if (b.kind === "image" && prev?.kind === "image" && prev.src === b.src) continue;
    if (b.kind === "rule" && prev?.kind === "rule") continue;
    out.push(b);
  }
  while (out.length && out[out.length - 1].kind === "rule") out.pop();
  return out;
}
