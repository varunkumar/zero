import { useMemo } from "react";
import { marked } from "marked";
import createDOMPurify from "dompurify";

// DOMPurify's default export is a factory that binds to a DOM window rather
// than sanitizing directly (its browser-auto-detection only kicks in when a
// global `window` already exists at import time, which isn't guaranteed
// under `bun:test` - see testUtils/domTestSetup.ts). Resolve and cache one
// instance lazily against whatever `window` is available at call time,
// rather than at module load.
let purifier: ReturnType<typeof createDOMPurify> | null = null;

function getPurifier(): ReturnType<typeof createDOMPurify> {
  if (!purifier) {
    if (typeof window === "undefined") {
      throw new Error("renderMarkdown requires a DOM window (DOMPurify has none to sanitize against)");
    }
    purifier = createDOMPurify(window);
  }
  return purifier;
}

export function renderMarkdown(content: string): string {
  const html = marked.parse(content, { async: false }) as string;
  return getPurifier().sanitize(html);
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
export function MarkdownPreview(props: { content: string }) {
  const html = useMemo(() => renderMarkdown(props.content), [props.content]);
  return (
    <div
      className="zero-markdown-preview"
      style={{ height: "100%", overflow: "auto", padding: "12px 16px" }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
