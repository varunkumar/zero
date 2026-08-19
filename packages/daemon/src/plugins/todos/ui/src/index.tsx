import { createRoot, type Root } from "react-dom/client";
import { useEffect, useState } from "react";

interface ZeroUiPluginApi {
  client: { request<R>(method: string, params?: unknown): Promise<R> };
  registerStatusBarItem(item: { id: string; mount(el: HTMLElement): () => void }): void;
  registerSidebarPanel(panel: { id: string; title: string; icon?: string; mount(el: HTMLElement): () => void }): void;
  onNotification(method: string, handler: (params: unknown) => void): () => void;
}

interface TodoEntry { path: string; line: number; kind: "TODO" | "FIXME" | "HACK"; text: string }

function TodosPanel(props: { client: ZeroUiPluginApi["client"]; onNotification: ZeroUiPluginApi["onNotification"] }) {
  const [entries, setEntries] = useState<TodoEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const { entries } = await props.client.request<{ entries: TodoEntry[] }>("todos/list");
        if (!cancelled) setEntries(entries);
      } catch {
        if (!cancelled) setEntries([]);
      }
    };
    void refresh();
    const unsubscribe = props.onNotification("fs/changed", () => void refresh());
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [props.client, props.onNotification]);

  if (entries.length === 0) {
    return <div style={{ padding: 12, opacity: 0.7, fontSize: 13 }}>No TODOs found.</div>;
  }

  return (
    <div style={{ overflowY: "auto", height: "100%", fontSize: 13 }}>
      {entries.map((e) => (
        <div key={`${e.path}:${e.line}`} style={{ padding: "6px 12px", borderBottom: "1px solid var(--zero-border, #333)" }}>
          <div style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
            <span style={{ fontWeight: 600, opacity: 0.8 }}>{e.kind}</span>
            <span style={{ opacity: 0.6 }}>{e.path}:{e.line}</span>
          </div>
          <div>{e.text}</div>
        </div>
      ))}
    </div>
  );
}

export function mount(_container: HTMLElement, api: ZeroUiPluginApi): () => void {
  api.registerSidebarPanel({
    id: "todos",
    title: "TODOs",
    mount(el: HTMLElement) {
      const root: Root = createRoot(el);
      root.render(<TodosPanel client={api.client} onNotification={api.onNotification} />);
      return () => root.unmount();
    },
  });
  return () => {};
}
