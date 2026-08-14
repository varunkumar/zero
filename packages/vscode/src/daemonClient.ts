import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

export const DEFAULT_GATEWAY_PORT = 4821;

export interface DaemonClientDeps {
  fetchImpl?: typeof fetch;
  spawnImpl?: (command: string, args: string[], opts: { cwd: string; detached: boolean; stdio: "ignore" }) => { unref(): void };
  readFile?: (path: string) => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
  /** Health-check retry budget after spawning. Defaults to 20 (~10s at 500ms). */
  maxAttempts?: number;
}

export interface DaemonInfo { port: number; apiKey: string }

export class DaemonClient {
  #root: string;
  #fetchImpl: typeof fetch;
  #spawnImpl: NonNullable<DaemonClientDeps["spawnImpl"]>;
  #readFile: NonNullable<DaemonClientDeps["readFile"]>;
  #sleep: NonNullable<DaemonClientDeps["sleep"]>;
  #maxAttempts: number;

  constructor(root: string, deps: DaemonClientDeps = {}) {
    this.#root = root;
    this.#fetchImpl = deps.fetchImpl ?? fetch;
    this.#spawnImpl = deps.spawnImpl ?? defaultSpawn;
    this.#readFile = deps.readFile ?? defaultReadFile;
    this.#sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#maxAttempts = deps.maxAttempts ?? 20;
  }

  async ensureRunning(gatewayPort = DEFAULT_GATEWAY_PORT): Promise<DaemonInfo | null> {
    if (await this.#healthy(gatewayPort)) {
      return this.#readInfo(gatewayPort);
    }

    try {
      this.#spawnImpl("zero", ["serve", this.#root, "--gateway-port", String(gatewayPort)], {
        cwd: this.#root, detached: true, stdio: "ignore",
      }).unref();
    } catch {
      return null;
    }

    for (let attempt = 0; attempt < this.#maxAttempts; attempt++) {
      await this.#sleep(500);
      if (await this.#healthy(gatewayPort)) {
        return this.#readInfo(gatewayPort);
      }
    }
    return null;
  }

  async #healthy(gatewayPort: number): Promise<boolean> {
    try {
      // 3s, not 1s: /health probes every configured ChatCapableProvider
      // serially, including Ollama's /models check which itself has a 1s
      // timeout (packages/core/src/providers/openaiCompat.ts) - a slow or
      // absent Ollama can otherwise make a genuinely-running daemon look
      // dead and cause us to spawn a duplicate `zero serve`.
      const res = await this.#fetchImpl(`http://127.0.0.1:${gatewayPort}/health`, { signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async #readInfo(gatewayPort: number): Promise<DaemonInfo | null> {
    // The gateway-key file is written just after the gateway's HTTP server
    // starts listening (packages/daemon/src/main.ts), so it can lag a
    // healthy /health response by a few ms - retry briefly before giving up.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const apiKey = (await this.#readFile(`${this.#root}/.zero/gateway-key`)).trim();
        return { port: gatewayPort, apiKey };
      } catch {
        await this.#sleep(100);
      }
    }
    return null;
  }
}

function defaultSpawn(command: string, args: string[], opts: { cwd: string; detached: boolean; stdio: "ignore" }) {
  return spawn(command, args, opts);
}

async function defaultReadFile(path: string): Promise<string> {
  return readFile(path, "utf8");
}
