import type { z } from "zod";
import type { Workspace } from "../workspace";

export interface PluginHealth { ok: boolean; detail?: string }

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  contributions: {
    rpcMethods?: string[];
    contextProviders?: string[];
    tools?: string[];
    commands?: string[];
    /** Set true if this plugin ships a browser UI bundle at ui/dist/index.js (built by scripts/build-plugin-ui.ts), served at GET /plugins/:id/ui.js. */
    ui?: true;
  };
}

export interface PluginContext {
  root: string;
  workspace: Workspace;
  broadcast: (method: string, params: unknown) => void;
  register: <P, R>(method: string, schema: z.ZodType<P>, fn: (params: P) => Promise<R>) => void;
}

export interface ZeroPlugin {
  manifest: PluginManifest;
  activate(ctx: PluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
  health?(): PluginHealth;
}
