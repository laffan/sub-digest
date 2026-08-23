import { fetchImageB64 } from "./gmail";
import type { PreparedImage } from "./types";

const MAX_PX = 1400;
/**
 * A cover is the one picture printed the full size of the page, so it's kept
 * larger than the pictures that sit inside a column — 1400px across an A4 sheet
 * is soft in print.
 */
export const COVER_MAX_PX = 2200;

const cache = new Map<string, PreparedImage | null>();
const objectUrls = new Map<string, string | null>();

/**
 * A URL the webview can show, for the Organize preview. It goes through the
 * same fetch-and-re-encode the exporters use, so seeing an image here warms the
 * cache that generating the document will read — and an image that can't be
 * displayed is exactly the one that won't make it into the output either.
 */
export async function imageObjectUrl(src: string): Promise<string | null> {
  const known = objectUrls.get(src);
  if (known !== undefined) return known;
  const prepared = await prepareImage(src);
  // Copied into a fresh array: `Blob` won't take a view whose buffer might be
  // shared, and the copy costs a few hundred kilobytes once per image.
  const url = prepared
    ? URL.createObjectURL(new Blob([new Uint8Array(prepared.jpeg)], { type: "image/jpeg" }))
    : null;
  objectUrls.set(src, url);
  return url;
}

/**
 * Fetches an image through the Rust backend (avoids CORS), decodes it in the
 * webview, downscales it to `maxPx` on its longest side, and re-encodes as JPEG
 * so pdf-lib can embed any source format (webp, gif, png, ...) uniformly.
 */
export async function prepareImage(
  src: string,
  maxPx = MAX_PX
): Promise<PreparedImage | null> {
  // The size is part of what's cached: the same picture can be wanted small for
  // a column and large for a cover.
  const key = maxPx === MAX_PX ? src : `${maxPx}|${src}`;
  if (cache.has(key)) return cache.get(key)!;
  let result: PreparedImage | null = null;
  try {
    const b64 = await fetchImageB64(src);
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes]);
    const bitmap = await createImageBitmap(blob);
    if (bitmap.width > 3 && bitmap.height > 3) {
      const scale = Math.min(1, maxPx / Math.max(bitmap.width, bitmap.height));
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
  cache.set(key, result);
  return result;
}
