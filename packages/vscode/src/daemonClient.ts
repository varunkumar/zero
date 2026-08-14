import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

export interface DaemonClientDeps {
  fetchImpl?: typeof fetch;
  spawnImpl?: (command: string, args: string[], opts: { cwd: string; detached: boolean; stdio: "ignore" }) => { unref(): void };
  readFile?: (path: string) => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
  /** Health-check retry budget after spawning. Defaults to 20 (~10s at 500ms). */
  maxAttempts?: number;
}

export interface DaemonInfo { port: number; apiKey: string }

interface DiscoveryFile { mainPort: number; gatewayPort: number; gatewayApiKey: string }

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

  /**
   * Discovers or starts the daemon for this workspace folder. Identity comes
   * from `<root>/.zero/zero.json`, not a shared default port - two folders
   * each get their own daemon on their own (dynamically assigned) ports, so
   * this never mistakes another folder's daemon for this one.
   */
  async ensureRunning(): Promise<DaemonInfo | null> {
    const existing = await this.#discover();
    if (existing) return existing;

    try {
      this.#spawnImpl("zero", ["serve", this.#root, "--port", "0", "--gateway-port", "0"], {
        cwd: this.#root, detached: true, stdio: "ignore",
      }).unref();
    } catch {
      return null;
    }

    for (let attempt = 0; attempt < this.#maxAttempts; attempt++) {
      await this.#sleep(500);
      const info = await this.#discover();
      if (info) return info;
    }
    return null;
  }

  async #discover(): Promise<DaemonInfo | null> {
    const discovery = await this.#readDiscoveryFile();
    if (!discovery) return null;
    if (!(await this.#healthy(discovery.gatewayPort))) return null;
    return { port: discovery.gatewayPort, apiKey: discovery.gatewayApiKey };
  }

  async #readDiscoveryFile(): Promise<DiscoveryFile | null> {
    try {
      const raw = await this.#readFile(`${this.#root}/.zero/zero.json`);
      const parsed = JSON.parse(raw);
      if (typeof parsed.gatewayPort === "number" && typeof parsed.gatewayApiKey === "string") {
        return parsed as DiscoveryFile;
      }
      return null;
    } catch {
      return null;
    }
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
}

function defaultSpawn(command: string, args: string[], opts: { cwd: string; detached: boolean; stdio: "ignore" }) {
  return spawn(command, args, opts);
}

async function defaultReadFile(path: string): Promise<string> {
  return readFile(path, "utf8");
}
