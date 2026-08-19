import { createRoot, type Root } from "react-dom/client";
import { useEffect, useState } from "react";

/** Minimal local shape of ZeroUiPluginApi (packages/web/src/workbench/plugins/loader.ts) -
 * this bundle is standalone browser JS with no dependency on @zero/web, so
 * the contract is restated here rather than imported. */
interface ZeroUiPluginApi {
  client: { request<R>(method: string, params?: unknown): Promise<R> };
  registerStatusBarItem(item: { id: string; mount(el: HTMLElement): () => void }): void;
  registerSidebarPanel(panel: { id: string; title: string; icon?: string; mount(el: HTMLElement): () => void }): void;
  onNotification(method: string, handler: (params: unknown) => void): () => void;
}

interface GitStatusFile { path: string; status: string }
interface GitStatusResult {
  branch: string; dirtyCount: number; ahead: number; behind: number;
  remoteUrl: string | null; files: GitStatusFile[];
}

function GitStatusBarItem(props: { client: ZeroUiPluginApi["client"] }) {
  const [status, setStatus] = useState<GitStatusResult | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const { status } = await props.client.request<{ status: GitStatusResult | null }>("git/status");
        if (!cancelled) setStatus(status);
      } catch {
        if (!cancelled) setStatus(null);
      }
    };
    void tick();
    const id = setInterval(tick, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [props.client]);

  if (!status) return null;

  return (
    <span style={{ position: "relative", display: "inline-flex", alignItems: "center", gap: 4 }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{ background: "transparent", border: "none", color: "inherit", cursor: "pointer", font: "inherit" }}
        title={`${status.files.length} changed file(s)`}
      >
        {status.branch} ({status.files.length})
      </button>
      {open && status.files.length > 0 && (
        <div style={{
          position: "absolute", bottom: "100%", right: 0, marginBottom: 4,
          background: "var(--zero-sidebar-bg, #222)", color: "var(--zero-sidebar-fg, #eee)",
          border: "1px solid var(--zero-border, #444)", borderRadius: 4, padding: 6,
          minWidth: 180, fontSize: 12, zIndex: 10,
        }}>
          {status.files.map((f) => (
            <div key={f.path} style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "2px 0" }}>
              <span>{f.path}</span>
              <span style={{ opacity: 0.7 }}>{f.status}</span>
            </div>
          ))}
        </div>
      )}
    </span>
  );
}

export function mount(_container: HTMLElement, api: ZeroUiPluginApi): () => void {
  api.registerStatusBarItem({
    id: "git",
    mount(el: HTMLElement) {
      const root: Root = createRoot(el);
      root.render(<GitStatusBarItem client={api.client} />);
      return () => root.unmount();
    },
  });
  return () => {};
}
