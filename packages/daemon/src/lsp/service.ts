import { relative } from "node:path";
import type { LspDiagnostic, LspPosition, LspRange, LspContextChunk } from "@zero/protocol";
import { LspClient } from "./client";
import { type LspServerConfig, languageForPath } from "./registry";
import type { Workspace } from "../workspace";

export class LspService {
  #clients = new Map<string, LspClient>(); // keyed by registry entry key, e.g. "typescript"

  constructor(
    private workspace: Workspace,
    private servers: Record<string, LspServerConfig>,
    private onDiagnostics: (path: string, diagnostics: LspDiagnostic[]) => void,
  ) {}

  async #resolve(relPath: string): Promise<{ client: LspClient; languageId: string; absPath: string } | undefined> {
    const languageId = languageForPath(relPath);
    if (!languageId) return undefined;
    const entry = Object.entries(this.servers).find(([, cfg]) => cfg.languageIds.includes(languageId));
    if (!entry) return undefined;
    // Same containment guard every fs/* RPC goes through (workspace.ts):
    // an RPC-supplied path must not be trusted to stay inside the
    // workspace root. A path that escapes it degrades this call to a no-op
    // exactly like an unconfigured language, rather than throwing through
    // the RPC layer.
    let absPath: string;
    try {
      absPath = await this.workspace.resolveInRoot(relPath);
    } catch {
      return undefined;
    }
    const [key, cfg] = entry;
    let client = this.#clients.get(key);
    if (!client) {
      client = new LspClient(cfg.command, cfg.args, this.workspace.root,
        (absPath, diagnostics) => this.onDiagnostics(relative(this.workspace.root, absPath), diagnostics));
      this.#clients.set(key, client);
    }
    return { client, languageId, absPath };
  }

  async sync(relPath: string, content: string): Promise<void> {
    const found = await this.#resolve(relPath);
    if (!found) return;
    await found.client.sync(found.absPath, content, found.languageId);
  }

  async hover(relPath: string, position: LspPosition): Promise<string | null> {
    const found = await this.#resolve(relPath);
    if (!found) return null;
    return found.client.hover(found.absPath, position);
  }

  async definition(relPath: string, position: LspPosition): Promise<{ path: string; range: LspRange }[]> {
    const found = await this.#resolve(relPath);
    if (!found) return [];
    const locations = await found.client.definition(found.absPath, position);
    return locations.map((l) => ({ path: relative(this.workspace.root, l.path), range: l.range }));
  }

  /** Purpose-built for `LspContext`: today this is hover text at the cursor,
   * scored below buffer/graph context. Extend here (signature help, nearby
   * symbol docs) without changing `LspContext`'s shape. */
  async contextAt(relPath: string, position: LspPosition): Promise<LspContextChunk[]> {
    const hover = await this.hover(relPath, position);
    if (!hover) return [];
    return [{ text: hover, score: 0.6 }];
  }

  /** Whether the language server responsible for `relPath` has failed
   * (failed to spawn, timed out on initialize, or died). False for a path
   * with no configured server at all — that's a normal, silent no-op, not
   * a failure — and false if the server just hasn't been synced yet. Used
   * to surface a "language server unavailable" signal distinct from "no
   * problems found" (an empty diagnostics list looks identical to that
   * otherwise). */
  async isFailed(relPath: string): Promise<boolean> {
    const languageId = languageForPath(relPath);
    if (!languageId) return false;
    const entry = Object.entries(this.servers).find(([, cfg]) => cfg.languageIds.includes(languageId));
    if (!entry) return false;
    const [key] = entry;
    const client = this.#clients.get(key);
    if (!client) return false;
    return client.failed;
  }

  dispose(): void {
    for (const client of this.#clients.values()) client.dispose();
    this.#clients.clear();
  }
}
