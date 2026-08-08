import { useCallback, useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { BlockPlacement, GeneratedOutput } from "../types";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** Width of the thumbnail rail beside the pages, in CSS pixels. */
const THUMB_WIDTH = 150;

interface Props {
  output: GeneratedOutput | null;
  /** A new document is being laid out; what's on screen is the previous one. */
  busy?: boolean;
  /** Take the block under a click out of the digest. */
  onRemoveBlock?: (key: string) => void;
}

export function Preview({ output, busy = false, onRemoveBlock }: Props) {
  return (
    <div className="preview-wrap">
      {!output && (
        <div className="preview-empty">
          <p>Nothing generated yet</p>
          <p className="hint">
            Connect Gmail, scan for posts, pick the ones you want, then hit Generate.
          </p>
        </div>
      )}
      {output?.format === "pdf" && (
        <PdfPreview
          bytes={output.bytes}
          placements={output.placements}
          busy={busy}
          onRemoveBlock={onRemoveBlock}
        />
      )}
      {output?.format === "epub" && <EpubPreview html={output.previewHtml} />}
    </div>
  );
}

/** The nearest ancestor that scrolls, so a re-render can hold its place. */
function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let node = el?.parentElement ?? null; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll") return node;
  }
  return null;
}

/**
 * Renders the actual generated PDF, page by page, with pdf.js — full size in
 * the main column, and again as a rail of thumbnails beside it that scroll the
 * pages when clicked.
 *
 * The pages are live: the layout engine hands back the rectangle every block
 * was drawn in, so a click lands on a paragraph or a picture and takes it out
 * of the digest.
 */
function PdfPreview({
  bytes,
  placements,
  busy,
  onRemoveBlock,
}: {
  bytes: Uint8Array;
  placements: BlockPlacement[];
  busy: boolean;
  onRemoveBlock?: (key: string) => void;
}) {
  const pagesRef = useRef<HTMLDivElement>(null);
  const thumbsRef = useRef<HTMLDivElement>(null);
  const [rendering, setRendering] = useState(false);
  const [pageCount, setPageCount] = useState(0);
  const renderToken = useRef(0);

  useEffect(() => {
    const pages = pagesRef.current;
    const thumbs = thumbsRef.current;
    if (!pages || !thumbs) return;
    const token = ++renderToken.current;

    (async () => {
      setRendering(true);
      // Re-rendering after a removal empties the column, which would otherwise
      // snap the reader back to page one.
      const scroller = scrollParent(pages);
      const held = scroller?.scrollTop ?? 0;
      try {
        // pdf.js transfers the buffer to its worker, so hand it a copy
        const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
        if (token !== renderToken.current) return;
        pages.innerHTML = "";
        thumbs.innerHTML = "";
        setPageCount(doc.numPages);

        const targetWidth = Math.max(320, pages.clientWidth - 48);
        const dpr = Math.min(window.devicePixelRatio || 1, 2);

        for (let i = 1; i <= doc.numPages; i++) {
          if (token !== renderToken.current) return;
          const page = await doc.getPage(i);
          const base = page.getViewport({ scale: 1 });
          const scale = Math.min(targetWidth / base.width, 1200 / base.height);
          const viewport = page.getViewport({ scale: scale * dpr });

          const canvas = document.createElement("canvas");
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
          canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;
          canvas.className = "preview-page";
          // What a click on this canvas has to know to become a point on the
          // page: which page, and how many CSS pixels a point came out as.
          canvas.dataset.pageIndex = String(i - 1);
          canvas.dataset.scale = String(scale);
          pages.appendChild(canvas);

          await page.render({
            canvasContext: canvas.getContext("2d")!,
            viewport,
          }).promise;
          if (token !== renderToken.current) return;

          thumbs.appendChild(await renderThumb(page, i, dpr));
        }
        if (scroller && held > 0) scroller.scrollTop = held;
      } finally {
        if (token === renderToken.current) setRendering(false);
      }
    })();
  }, [bytes]);

  // Which page is in view, so the rail says where you are.
  useEffect(() => {
    const pages = pagesRef.current;
    if (!pages || pageCount === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const n = (entry.target as HTMLElement).dataset.pageIndex;
          thumbsRef.current?.querySelectorAll(".preview-thumb").forEach((el) => {
            el.classList.toggle("current", (el as HTMLElement).dataset.pageIndex === n);
          });
          break;
        }
      },
      { rootMargin: "-45% 0px -45% 0px" }
    );
    pages.querySelectorAll(".preview-page").forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [pageCount, rendering]);

  /** The smallest block drawn over a point, so a picture beats its column. */
  const blockAt = useCallback(
    (canvas: HTMLCanvasElement, clientX: number, clientY: number): BlockPlacement | null => {
      const pageIndex = Number(canvas.dataset.pageIndex);
      const scale = Number(canvas.dataset.scale);
      if (!Number.isFinite(pageIndex) || !(scale > 0)) return null;
      const box = canvas.getBoundingClientRect();
      const x = (clientX - box.left) / scale;
      // PDF coordinates start at the foot of the page.
      const y = (box.bottom - clientY) / scale;
      let best: BlockPlacement | null = null;
      for (const p of placements) {
        if (p.page !== pageIndex) continue;
        if (x < p.x || x > p.x + p.width || y < p.y || y > p.y + p.height) continue;
        if (!best || p.width * p.height < best.width * best.height) best = p;
      }
      return best;
    },
    [placements]
  );

  const canvasUnder = (target: EventTarget): HTMLCanvasElement | null =>
    target instanceof HTMLCanvasElement && target.classList.contains("preview-page")
      ? target
      : null;

  const clickPage = (e: React.MouseEvent) => {
    if (!onRemoveBlock || busy) return;
    const canvas = canvasUnder(e.target);
    const hit = canvas && blockAt(canvas, e.clientX, e.clientY);
    if (hit) onRemoveBlock(hit.key);
  };

  // The pointer says what's removable before anything is clicked.
  const hoverPage = (e: React.MouseEvent) => {
    const pages = pagesRef.current;
    if (!pages) return;
    if (!onRemoveBlock || busy) {
      pages.classList.remove("over-block");
      return;
    }
    const canvas = canvasUnder(e.target);
    const hit = canvas && blockAt(canvas, e.clientX, e.clientY);
    pages.classList.toggle("over-block", !!hit);
  };

  const showPage = (index: number) => {
    pagesRef.current
      ?.querySelector<HTMLElement>(`.preview-page[data-page-index="${index}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="pdf-preview">
      <div
        className="preview-thumbs"
        ref={thumbsRef}
        role="tablist"
        aria-label="Pages"
        onClick={(e) => {
          const thumb = (e.target as HTMLElement).closest<HTMLElement>(".preview-thumb");
          if (thumb?.dataset.pageIndex) showPage(Number(thumb.dataset.pageIndex));
        }}
      />
      <div className="preview-main">
        {(rendering || busy) && (
          <div className="preview-rendering">{busy ? "Updating…" : "Rendering preview…"}</div>
        )}
        {onRemoveBlock && !rendering && (
          <p className="preview-hint hint">Click anything on a page to take it out of the digest.</p>
        )}
        <div
          ref={pagesRef}
          className={`preview-pages${busy ? " busy" : ""}`}
          onClick={clickPage}
          onMouseMove={hoverPage}
        />
      </div>
    </div>
  );
}

/** One page of the rail: a small render of the page, and its number. */
async function renderThumb(
  page: pdfjs.PDFPageProxy,
  pageNumber: number,
  dpr: number
): Promise<HTMLElement> {
  const base = page.getViewport({ scale: 1 });
  const scale = THUMB_WIDTH / base.width;
  const viewport = page.getViewport({ scale: scale * dpr });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  canvas.style.width = `${THUMB_WIDTH}px`;
  canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;
  await page.render({ canvasContext: canvas.getContext("2d")!, viewport }).promise;

  const button = document.createElement("button");
  button.className = "preview-thumb";
  button.dataset.pageIndex = String(pageNumber - 1);
  button.title = `Page ${pageNumber}`;
  button.setAttribute("aria-label", `Go to page ${pageNumber}`);
  button.appendChild(canvas);
  const label = document.createElement("span");
  label.className = "preview-thumb-num";
  label.textContent = String(pageNumber);
  button.appendChild(label);
  return button;
}

/**
 * Shows the EPUB's own markup and stylesheet in a sandboxed frame — the book
 * reflows, so there are no fixed pages to rasterise. Scripting is disabled;
 * the document is generated locally and only needs to render.
 */
function EpubPreview({ html }: { html: string }) {
  return (
    <iframe className="preview-epub" title="EPUB preview" sandbox="" srcDoc={html} />
  );
}
