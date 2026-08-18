export type FileKind = "text" | "markdown" | "image" | "pdf";

const MARKDOWN_EXTS = new Set(["md", "mdx"]);
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp"]);

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  pdf: "application/pdf",
};

/** Leading-dot files like ".gitignore" have no extension by this rule
 * (mirrors `iconFor.ts`'s existing convention) and are always "text". */
function extOf(path: string): string {
  const name = path.split("/").at(-1) ?? path;
  const dotIndex = name.lastIndexOf(".");
  return dotIndex > 0 ? name.slice(dotIndex + 1).toLowerCase() : "";
}

export function classifyFile(path: string): FileKind {
  const ext = extOf(path);
  if (MARKDOWN_EXTS.has(ext)) return "markdown";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (ext === "pdf") return "pdf";
  return "text";
}

export function mimeTypeFor(path: string): string {
  return MIME_BY_EXT[extOf(path)] ?? "application/octet-stream";
}
