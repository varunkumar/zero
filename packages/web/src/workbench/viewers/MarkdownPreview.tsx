import { marked } from "marked";

export function renderMarkdown(content: string): string {
  return marked.parse(content, { async: false }) as string;
}

// Content rendered here is always a file already open in the user's own
// workspace, not third-party/untrusted web content — the same trust level
// as opening it for editing — so dangerouslySetInnerHTML on marked's
// output is acceptable without a separate sanitizer pass.
export function MarkdownPreview(props: { content: string }) {
  return (
    <div
      className="zero-markdown-preview"
      style={{ height: "100%", overflow: "auto", padding: "12px 16px" }}
      dangerouslySetInnerHTML={{ __html: renderMarkdown(props.content) }}
    />
  );
}
