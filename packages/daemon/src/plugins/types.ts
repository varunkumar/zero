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
    ui?: { entry: string };
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
