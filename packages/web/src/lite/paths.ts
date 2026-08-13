export function assertSafePath(path: string): string[] {
  if (path === "" || path === ".") return [];
  if (path.startsWith("/") || path.startsWith("\\")) throw new Error(`path escapes workspace: ${path}`);
  if (/^[A-Za-z]:/.test(path)) throw new Error(`path escapes workspace: ${path}`);
  const parts = path.split("/").filter((p) => p !== "");
  if (parts.some((p) => p === "." || p === "..")) throw new Error(`path escapes workspace: ${path}`);
  return parts;
}
