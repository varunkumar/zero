import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as rpc from "vscode-jsonrpc/node";
import {
  InitializeRequest, InitializedNotification, DidOpenTextDocumentNotification,
  DidChangeTextDocumentNotification, DidCloseTextDocumentNotification,
  PublishDiagnosticsNotification, HoverRequest, DefinitionRequest,
  type Diagnostic as ProtoDiagnostic, type Location, type LocationLink,
} from "vscode-languageserver-protocol";
import type { LspDiagnostic, LspPosition, LspRange } from "@zero/protocol";

function pathUri(path: string): string {
  return pathToFileURL(path).toString();
}

function fileUriToPath(uri: string): string {
  return new URL(uri).pathname;
}

function toLspDiagnostic(d: ProtoDiagnostic): LspDiagnostic {
  return { range: d.range, severity: (d.severity ?? 1) as 1 | 2 | 3 | 4, message: d.message, source: d.source };
}

/** The daemon bundles its own language servers (typescript-language-server,
 * pyright, ...) as dependencies so they work with no user setup. Those
 * binaries live in @zero/daemon's own node_modules/.bin, which is not on
 * PATH by default (unlike a package.json "scripts" entry, a plain
 * child_process.spawn does not search it). Prepend it explicitly so
 * `spawn("typescript-language-server", ...)` resolves without requiring the
 * caller's environment to have it on PATH. */
const localBinDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "node_modules", ".bin");

function spawnEnv(): NodeJS.ProcessEnv {
  if (!existsSync(localBinDir)) return process.env;
  const path = process.env.PATH ?? process.env.Path ?? "";
  return { ...process.env, PATH: `${localBinDir}:${path}` };
}

/** One spawned language-server process, one workspace root. Full-document
 * sync only (see plan's Global Constraints) — every sync sends the whole
 * buffer text, no incremental ranges. */
export class LspClient {
  #proc: ChildProcessWithoutNullStreams;
  #conn: rpc.MessageConnection;
  #versions = new Map<string, number>();
  #ready: Promise<void>;
  #failed = false;

  constructor(
    command: string, args: string[], rootPath: string,
    private onDiagnostics: (path: string, diagnostics: LspDiagnostic[]) => void,
  ) {
    this.#proc = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: spawnEnv() });
    this.#proc.on("error", () => { this.#failed = true; });
    this.#conn = rpc.createMessageConnection(
      new rpc.StreamMessageReader(this.#proc.stdout),
      new rpc.StreamMessageWriter(this.#proc.stdin),
    );
    this.#conn.onNotification(PublishDiagnosticsNotification.type, (params) => {
      this.onDiagnostics(fileUriToPath(params.uri), params.diagnostics.map(toLspDiagnostic));
    });
    // If the connection dies at any point (server crash, stdio pipe closed,
    // protocol-level error) after a successful initialize, subsequent
    // hover()/definition()/sync() calls must degrade to null/[]/no-op rather
    // than reject with an uncaught rejection from #conn.sendRequest.
    this.#conn.onClose(() => { this.#failed = true; });
    this.#conn.onError(() => { this.#failed = true; });
    this.#conn.listen();
    this.#ready = Promise.race([
      this.#conn.sendRequest(InitializeRequest.type, {
        processId: process.pid, rootUri: pathToFileURL(rootPath).toString(),
        // Language servers such as typescript-language-server gate whether
        // they bother computing/publishing diagnostics on the client having
        // declared textDocument.publishDiagnostics support during
        // initialize — an empty capabilities object silently disables
        // diagnostics entirely, so this must be declared explicitly.
        capabilities: {
          textDocument: {
            publishDiagnostics: {},
            hover: { contentFormat: ["markdown", "plaintext"] },
            definition: { linkSupport: true },
          },
        },
        workspaceFolders: null,
      }),
      // A server that spawns but never speaks the LSP protocol (or just
      // never responds to initialize) would otherwise hang #awaitReady()
      // forever for every caller. Bound it.
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("lsp initialize timed out")), 5000);
      }),
    ])
      .then(() => { this.#conn.sendNotification(InitializedNotification.type, {}); })
      .catch(() => { this.#failed = true; });
  }

  /** Every public method awaits readiness (or a failed init) first, so a
   * still-initializing or dead server degrades to a no-op/null rather than
   * hanging the caller forever. */
  async #awaitReady(): Promise<boolean> {
    await this.#ready.catch(() => {});
    return !this.#failed;
  }

  async sync(path: string, content: string, languageId: string): Promise<void> {
    if (!(await this.#awaitReady())) return;
    const uri = pathUri(path);
    const existing = this.#versions.get(path);
    if (existing === undefined) {
      this.#versions.set(path, 1);
      this.#conn.sendNotification(DidOpenTextDocumentNotification.type, {
        textDocument: { uri, languageId, version: 1, text: content },
      });
      return;
    }
    const version = existing + 1;
    this.#versions.set(path, version);
    this.#conn.sendNotification(DidChangeTextDocumentNotification.type, {
      textDocument: { uri, version },
      contentChanges: [{ text: content }],
    });
  }

  async hover(path: string, position: LspPosition): Promise<string | null> {
    if (!(await this.#awaitReady())) return null;
    const result = await this.#conn
      .sendRequest(HoverRequest.type, { textDocument: { uri: pathUri(path) }, position })
      .catch(() => { this.#failed = true; return null; });
    if (!result) return null;
    const contents = result.contents;
    if (typeof contents === "string") return contents;
    if (Array.isArray(contents)) {
      return contents.map((c) => (typeof c === "string" ? c : c.value)).join("\n\n");
    }
    return "value" in contents ? contents.value : null;
  }

  async definition(path: string, position: LspPosition): Promise<{ path: string; range: LspRange }[]> {
    if (!(await this.#awaitReady())) return [];
    const result = await this.#conn
      .sendRequest(DefinitionRequest.type, { textDocument: { uri: pathUri(path) }, position })
      .catch(() => { this.#failed = true; return null; });
    const raw: (Location | LocationLink)[] = Array.isArray(result) ? result : result ? [result] : [];
    return raw.map((loc) =>
      "uri" in loc
        ? { path: fileUriToPath(loc.uri), range: loc.range }
        : { path: fileUriToPath(loc.targetUri), range: loc.targetSelectionRange },
    );
  }

  close(path: string): void {
    if (!this.#versions.delete(path)) return;
    this.#conn.sendNotification(DidCloseTextDocumentNotification.type, { textDocument: { uri: pathUri(path) } });
  }

  dispose(): void {
    this.#conn.dispose();
    this.#proc.kill();
  }
}
