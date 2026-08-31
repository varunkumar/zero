import { useEffect, useMemo, useRef } from "react";
import { marked } from "marked";
import type { RpcClient } from "@zero/protocol";
import { sanitizeHtml } from "../sanitizeHtml";
import { fetchBinaryFile, base64ToDataUrl } from "./fetchBinary";

export function renderMarkdown(content: string): string {
  const html = marked.parse(content, { async: false }) as string;
  return sanitizeHtml(html);
}

function dirname(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

/** Resolves a Markdown-relative image path (`./foo.png`, `../assets/x.png`)
 * against the directory of the Markdown file it came from, producing the
 * workspace-relative path `fs/readBinary` expects. */
function resolveRelativePath(baseDir: string, rel: string): string {
  const parts = baseDir ? baseDir.split("/") : [];
  for (const part of rel.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

/** An `<img src>` needs resolving against the workspace filesystem only when
 * it's neither an absolute URL, a `data:` URI, nor already root-relative. */
function isWorkspaceRelativeSrc(src: string): boolean {
  return src !== "" && !/^([a-z][a-z0-9+.-]*:)?\/\//i.test(src) && !src.startsWith("data:") && !src.startsWith("/");
}

// Content rendered here is always a file already open in the user's own
// workspace, but that is not a reason to trust it: unlike CodeMirror (which
// only *displays* text), `dangerouslySetInnerHTML` *executes* what marked
// produces in the workbench's own browser origin. This app has no CSP, the
// daemon's session token is readable from page JS (see connection.ts), and
// the daemon accepts pty/open with an arbitrary shell — so an unsanitized
// `<img onerror=...>` or `<script>` in a Markdown file is a real path to
// driving a terminal on the host, not merely an XSS annoyance. `marked`'s
// output is therefore run through DOMPurify (see `renderMarkdown` above)
// before it ever reaches `dangerouslySetInnerHTML`.
export function MarkdownPreview(props: { content: string; path?: string; client?: RpcClient }) {
  const html = useMemo(() => renderMarkdown(props.content), [props.content]);
  const containerRef = useRef<HTMLDivElement>(null);
  const { path, client } = props;

  // Relative image paths in Markdown (`![](./diagram.png)`) resolve fine on
  // disk, but this HTML is rendered at the workbench's own origin/route, not
  // the file's location - the browser has no way to turn "./diagram.png"
  // into workspace bytes on its own. So once the sanitized HTML is in the
  // DOM, walk its <img> tags and fetch anything workspace-relative through
  // the same fs/readBinary path ImageViewer uses, swapping in a data: URL.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !path || !client) return;
    const baseDir = dirname(path);
    const images = Array.from(container.querySelectorAll("img"));
    let cancelled = false;
    for (const img of images) {
      const src = img.getAttribute("src") ?? "";
      if (!isWorkspaceRelativeSrc(src)) continue;
      const resolved = resolveRelativePath(baseDir, src);
      fetchBinaryFile(client, resolved)
        .then(({ contentBase64, mimeType }) => {
          if (cancelled) return;
          img.src = base64ToDataUrl(contentBase64, mimeType);
        })
        .catch(() => {
          if (cancelled) return;
          img.alt = img.alt ? `${img.alt} (failed to load)` : "(failed to load)";
        });
    }
    return () => {
      cancelled = true;
    };
  }, [html, path, client]);

  return (
    <div
      ref={containerRef}
      className="zero-markdown-preview"
      style={{ height: "100%", overflow: "auto", padding: "12px 16px" }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
