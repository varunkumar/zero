const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  pdf: "application/pdf",
};

/** Derives a mime type from a file's extension via a small fixed table —
 * not content-sniffed, since callers already trust the extension to pick
 * which viewer renders the file. */
export function mimeTypeFor(path: string): string {
  const dotIndex = path.lastIndexOf(".");
  const ext = dotIndex >= 0 ? path.slice(dotIndex + 1).toLowerCase() : "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}
