import type { PluginListEntry, RpcClient } from "@zero/protocol";
import type { StatusBarItem, StatusBarRegistry, SidebarPanelSpec, SidebarPanelRegistry } from "./registries";
import type { NotificationHub } from "./notifications";

export interface ZeroUiPluginApi {
  client: RpcClient;
  registerStatusBarItem(item: StatusBarItem): void;
  registerSidebarPanel(panel: SidebarPanelSpec): void;
  onNotification(method: string, handler: (params: unknown) => void): () => void;
}

export interface PluginUiModule {
  mount(container: HTMLElement, api: ZeroUiPluginApi): () => void;
}

/** Discovers every plugin whose manifest declares a `ui` contribution,
 * dynamically imports its bundle, and calls its `mount`. A failure in any
 * one plugin (bad import, throwing mount) is caught and logged - it never
 * blocks another plugin's UI or the rest of the workbench, mirroring
 * PluginHost.activateBuiltins's per-plugin isolation on the daemon side. */
export async function loadPluginUis(opts: {
  client: RpcClient;
  plugins: PluginListEntry[];
  statusBarRegistry: StatusBarRegistry;
  sidebarPanelRegistry: SidebarPanelRegistry;
  hub: NotificationHub;
  importModule?: (url: string) => Promise<PluginUiModule>;
}): Promise<() => void> {
  const importModule = opts.importModule ?? ((url: string) => import(/* @vite-ignore */ url));
  const cleanups: Array<() => void> = [];

  await Promise.all(
    opts.plugins
      .filter((p) => p.contributions.ui && p.health.ok)
      .map(async (p) => {
        const url = `/plugins/${p.id}/ui.js`;
        try {
          const mod = await importModule(url);
          const api: ZeroUiPluginApi = {
            client: opts.client,
            registerStatusBarItem: (item) => opts.statusBarRegistry.register(item),
            registerSidebarPanel: (panel) => opts.sidebarPanelRegistry.register(panel),
            onNotification: (method, handler) => opts.hub.subscribe(method, handler),
          };
          const container = document.createElement("div");
          const cleanup = mod.mount(container, api);
          cleanups.push(cleanup);
        } catch (e) {
          console.error(`plugin UI "${p.id}" failed to load:`, e);
        }
      }),
  );

  return () => cleanups.forEach((c) => c());
}
