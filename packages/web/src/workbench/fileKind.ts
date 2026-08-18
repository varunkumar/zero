// `mimeTypeFor` lives in `../mime` (no workbench/UI dependency) so that
// filesystem-layer code like `lite/browserFs.ts` can use it without
// depending on this workbench UI module. Re-exported here so nothing that
// already imports `mimeTypeFor` from this file needs to change.
export { mimeTypeFor } from "../mime";

export type FileKind = "text" | "markdown" | "image" | "pdf";

const MARKDOWN_EXTS = new Set(["md", "mdx"]);
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp"]);

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
