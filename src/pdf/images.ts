import { fetchImageB64 } from "../gmail";
import type { PreparedImage } from "../types";

const MAX_PX = 1400;

const cache = new Map<string, PreparedImage | null>();

/**
 * Fetches an image through the Rust backend (avoids CORS), decodes it in the
 * webview, downscales it, and re-encodes as JPEG so pdf-lib can embed any
 * source format (webp, gif, png, ...) uniformly.
 */
export async function prepareImage(src: string): Promise<PreparedImage | null> {
  if (cache.has(src)) return cache.get(src)!;
  let result: PreparedImage | null = null;
  try {
    const b64 = await fetchImageB64(src);
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes]);
    const bitmap = await createImageBitmap(blob);
    if (bitmap.width > 3 && bitmap.height > 3) {
      const scale = Math.min(1, MAX_PX / Math.max(bitmap.width, bitmap.height));
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#ffffff"; // flatten transparency for JPEG
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(bitmap, 0, 0, w, h);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
      const jpegB64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
      result = {
        jpeg: Uint8Array.from(atob(jpegB64), (c) => c.charCodeAt(0)),
        width: w,
        height: h,
      };
    }
    bitmap.close();
  } catch {
    result = null; // unreachable/undecodable image: just skip it
  }
  cache.set(src, result);
  return result;
}
