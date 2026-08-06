import { z } from "zod";
import type { PluginHealthResult, PluginListResult } from "@zero/protocol";
import type { RpcServer } from "../rpc";
import type { Workspace } from "../workspace";
import type { PluginContext, PluginHealth, ZeroPlugin } from "./types";

type Entry = {
  plugin: ZeroPlugin;
  health: PluginHealth;
};

export class PluginHost {
  #rpc: RpcServer;
  #workspace: Workspace;
  #root: string;
  #broadcast: (method: string, params: unknown) => void;
  #entries: Entry[] = [];

  constructor(opts: {
    rpc: RpcServer;
    workspace: Workspace;
    root: string;
    broadcast: (method: string, params: unknown) => void;
  }) {
    this.#rpc = opts.rpc;
    this.#workspace = opts.workspace;
    this.#root = opts.root;
    this.#broadcast = opts.broadcast;
  }

  registerHostRpcs(): void {
    this.#rpc.register("plugin/list", z.object({}).optional().transform(() => ({})),
      async () => this.list());
    this.#rpc.register("plugin/health", z.object({}).optional().transform(() => ({})),
      async () => this.health());
  }

  async activateBuiltins(
    factories: Array<(ctx: PluginContext) => ZeroPlugin | Promise<ZeroPlugin>>,
  ): Promise<void> {
    for (const factory of factories) {
      const ctx = this.#makeContext();
      let plugin: ZeroPlugin;
      try {
        plugin = await factory(ctx);
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        this.#entries.push({
          plugin: {
            manifest: { id: "unknown", name: "unknown", version: "0", contributions: {} },
            activate() {},
          },
          health: { ok: false, detail },
        });
        continue;
      }
      try {
        await plugin.activate(ctx);
        this.#entries.push({
          plugin,
          health: plugin.health?.() ?? { ok: true },
        });
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        this.#entries.push({ plugin, health: { ok: false, detail } });
      }
    }
  }

  #makeContext(): PluginContext {
    return {
      root: this.#root,
      workspace: this.#workspace,
      broadcast: this.#broadcast,
      register: (method, schema, fn) => this.#rpc.register(method, schema, fn),
    };
  }

  list(): PluginListResult {
    return {
      plugins: this.#entries.map(({ plugin, health }) => ({
        id: plugin.manifest.id,
        name: plugin.manifest.name,
        version: plugin.manifest.version,
        health: this.#liveHealth(plugin, health),
        contributions: plugin.manifest.contributions,
      })),
    };
  }

  health(): PluginHealthResult {
    const plugins: Record<string, PluginHealth> = {};
    let ok = true;
    for (const { plugin, health } of this.#entries) {
      const h = this.#liveHealth(plugin, health);
      plugins[plugin.manifest.id] = h;
      if (!h.ok) ok = false;
    }
    return { ok, plugins };
  }

  #liveHealth(plugin: ZeroPlugin, cached: PluginHealth): PluginHealth {
    try {
      return plugin.health?.() ?? cached;
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }
}
