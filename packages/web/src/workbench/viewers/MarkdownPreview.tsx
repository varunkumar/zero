import { useMemo } from "react";
import { marked } from "marked";
import { sanitizeHtml } from "../sanitizeHtml";

export function renderMarkdown(content: string): string {
  const html = marked.parse(content, { async: false }) as string;
  return sanitizeHtml(html);
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
