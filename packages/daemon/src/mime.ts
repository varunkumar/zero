const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  pdf: "application/pdf",
};

/** Leading-dot files like ".png" have no "extension" by this rule (mirrors
 * the web side's `extOf` convention in `packages/web/src/mime.ts`) and
 * always fall back to "application/octet-stream". */
function extOf(path: string): string {
  const name = path.split("/").at(-1) ?? path;
  const dotIndex = name.lastIndexOf(".");
  return dotIndex > 0 ? name.slice(dotIndex + 1).toLowerCase() : "";
}

/** Derives a mime type from a file's extension via a small fixed table —
 * not content-sniffed, since callers already trust the extension to pick
 * which viewer renders the file. */
export function mimeTypeFor(path: string): string {
  return MIME_BY_EXT[extOf(path)] ?? "application/octet-stream";
}
