import { useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

interface Props {
  pdfBytes: Uint8Array | null;
}

export function Preview({ pdfBytes }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [rendering, setRendering] = useState(false);
  const renderToken = useRef(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const token = ++renderToken.current;

    if (!pdfBytes) {
      container.innerHTML = "";
      return;
    }

    (async () => {
      setRendering(true);
      try {
        // pdf.js transfers the buffer to its worker, so hand it a copy
        const doc = await pdfjs.getDocument({ data: pdfBytes.slice() }).promise;
        if (token !== renderToken.current) return;
        container.innerHTML = "";

        const targetWidth = Math.max(320, container.clientWidth - 48);
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
          container.appendChild(canvas);

          await page.render({
            canvasContext: canvas.getContext("2d")!,
            viewport,
          }).promise;
        }
      } finally {
        if (token === renderToken.current) setRendering(false);
      }
    })();
  }, [pdfBytes]);

  return (
    <div className="preview-wrap">
      {!pdfBytes && (
        <div className="preview-empty">
          <p>No PDF yet</p>
          <p className="hint">
            Connect Gmail, scan for posts, pick the ones you want, then hit Generate.
          </p>
        </div>
      )}
      {rendering && <div className="preview-rendering">Rendering preview…</div>}
      <div ref={containerRef} className="preview-pages" />
    </div>
  );
}
