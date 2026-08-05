import { join, relative } from "node:path";
import type { LspDiagnostic, LspPosition, LspRange, LspContextChunk } from "@zero/protocol";
import { LspClient } from "./client";
import { type LspServerConfig, languageForPath } from "./registry";

export class LspService {
  #clients = new Map<string, LspClient>(); // keyed by registry entry key, e.g. "typescript"

  constructor(
    private root: string,
    private servers: Record<string, LspServerConfig>,
    private onDiagnostics: (path: string, diagnostics: LspDiagnostic[]) => void,
  ) {}

  #resolve(relPath: string): { client: LspClient; languageId: string; absPath: string } | undefined {
    const languageId = languageForPath(relPath);
    if (!languageId) return undefined;
    const entry = Object.entries(this.servers).find(([, cfg]) => cfg.languageIds.includes(languageId));
    if (!entry) return undefined;
    const [key, cfg] = entry;
    let client = this.#clients.get(key);
    if (!client) {
      client = new LspClient(cfg.command, cfg.args, this.root,
        (absPath, diagnostics) => this.onDiagnostics(relative(this.root, absPath), diagnostics));
      this.#clients.set(key, client);
    }
    return { client, languageId, absPath: join(this.root, relPath) };
  }

  async sync(relPath: string, content: string): Promise<void> {
    const found = this.#resolve(relPath);
    if (!found) return;
    await found.client.sync(found.absPath, content, found.languageId);
  }

  async hover(relPath: string, position: LspPosition): Promise<string | null> {
    const found = this.#resolve(relPath);
    if (!found) return null;
    return found.client.hover(found.absPath, position);
  }

  async definition(relPath: string, position: LspPosition): Promise<{ path: string; range: LspRange }[]> {
    const found = this.#resolve(relPath);
    if (!found) return [];
    const locations = await found.client.definition(found.absPath, position);
    return locations.map((l) => ({ path: relative(this.root, l.path), range: l.range }));
  }

  /** Purpose-built for `LspContext`: today this is hover text at the cursor,
   * scored below buffer/graph context. Extend here (signature help, nearby
   * symbol docs) without changing `LspContext`'s shape. */
  async contextAt(relPath: string, position: LspPosition): Promise<LspContextChunk[]> {
    const hover = await this.hover(relPath, position);
    if (!hover) return [];
    return [{ text: hover, score: 0.6 }];
  }

  dispose(): void {
    for (const client of this.#clients.values()) client.dispose();
    this.#clients.clear();
  }
}
