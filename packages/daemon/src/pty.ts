import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { PtySessionInfo } from "@zero/protocol";

interface Session { sessionId: string; shell: string }

interface WorkerEvent { event: "data" | "exit"; sessionId: string; data?: string; exitCode?: number }

export class PtyService {
  #sessions = new Map<string, Session>();
  #worker: ChildProcessWithoutNullStreams;
  #dead = false;

  /** Exposed for tests: which node binary the worker was actually
   * spawned with, so ZERO_PTY_NODE_BIN/ZERO_PTY_WORKER_DIR overrides
   * are observable without reaching into #worker's private fields. */
  readonly spawnedNodeBin: string;

  constructor(
    private cwd: string,
    private onOutput: (sessionId: string, data: string) => void,
    private onExit: (sessionId: string, exitCode: number) => void,
  ) {
    // node-pty's native binding does not work under Bun (confirmed: only the
    // first onData event ever arrives, then the stream goes permanently
    // silent — https://github.com/oven-sh/bun/issues/7362). Host it in a
    // plain-JS worker run under real `node` instead, bridged over
    // newline-delimited JSON on stdio.
    //
    // ZERO_PTY_NODE_BIN/ZERO_PTY_WORKER_DIR let a compiled sidecar (Zero
    // IDE's Tauri shell) point this at a bundled portable node + copied
    // pty-worker.js + node_modules/node-pty, since none of those exist on
    // disk relative to import.meta.url inside a `bun build --compile`
    // binary, and a compiled sidecar can't assume `node` is on PATH.
    const overrideBin = process.env.ZERO_PTY_NODE_BIN;
    const overrideDir = process.env.ZERO_PTY_WORKER_DIR;
    if (overrideBin && overrideDir) {
      this.spawnedNodeBin = overrideBin;
      this.#worker = spawn(overrideBin, [join(overrideDir, "pty-worker.js")], { cwd: overrideDir });
    } else {
      const workerPath = fileURLToPath(new URL("./pty-worker.js", import.meta.url));
      this.spawnedNodeBin = "node";
      this.#worker = spawn("node", [workerPath]);
    }

    // A spawn failure (e.g. `node` missing from PATH) emits 'error' on the
    // ChildProcess EventEmitter; with no listener that throws and takes down
    // the whole daemon process. Mark the service dead instead and let every
    // subsequent call become a no-op — degrade this subsystem only, per the
    // project's "never break editing" constraint.
    this.#worker.on("error", () => {
      this.#dead = true;
    });
    this.#worker.on("exit", () => {
      this.#dead = true;
      // The worker process itself died (crash, OOM, etc.), not an
      // individual PTY session inside it. Without this, #sessions still
      // reports every session as alive: list() keeps reporting them (so a
      // page reload reattaches phantom tabs), input()/resize() silently
      // no-op forever (they pass the #sessions.has() check, then #send
      // degrades quietly since #dead is now true), and no pty/exit ever
      // reaches clients. Drain the map and report every session as exited,
      // same as a single session's own natural-exit path above.
      for (const id of [...this.#sessions.keys()]) {
        this.#sessions.delete(id);
        this.onExit(id, 1);
      }
    });
    // A broken stdin pipe (e.g. after the worker has already died) would
    // otherwise also throw as an unhandled 'error' event.
    this.#worker.stdin.on("error", () => {
      this.#dead = true;
    });

    const rl = createInterface({ input: this.#worker.stdout });
    rl.on("line", (line) => {
      let msg: WorkerEvent;
      try { msg = JSON.parse(line) as WorkerEvent; } catch { return; }
      if (msg.event === "data") this.onOutput(msg.sessionId, msg.data ?? "");
      else if (msg.event === "exit") {
        // A natural exit (the shell process died on its own, or the worker
        // reports a spawn failure for a session that never came up) still
        // needs reporting; an exit for a session close()/closeAll() already
        // removed is filtered by the worker itself (see pty-worker.js),
        // so anything reaching here is a genuine, previously-unknown exit.
        if (!this.#sessions.delete(msg.sessionId)) return;
        this.onExit(msg.sessionId, msg.exitCode ?? 0);
      }
    });
  }

  #send(msg: unknown): void {
    if (this.#dead) return;
    try {
      this.#worker.stdin.write(JSON.stringify(msg) + "\n");
    } catch {
      this.#dead = true;
    }
  }

  open(shell: string | undefined, cols: number, rows: number): { sessionId: string; shell: string } {
    const sessionId = randomUUID();
    const shellCmd = shell ?? (process.platform === "win32" ? "powershell.exe" : (process.env.SHELL ?? "/bin/bash"));
    this.#sessions.set(sessionId, { sessionId, shell: shellCmd });
    this.#send({ type: "open", sessionId, shell: shellCmd, cols, rows, cwd: this.cwd });
    return { sessionId, shell: shellCmd };
  }

  input(sessionId: string, data: string): void {
    if (!this.#sessions.has(sessionId)) return;
    this.#send({ type: "input", sessionId, data });
  }

  resize(sessionId: string, cols: number, rows: number): void {
    if (!this.#sessions.has(sessionId)) return;
    this.#send({ type: "resize", sessionId, cols, rows });
  }

  close(sessionId: string): void {
    if (!this.#sessions.delete(sessionId)) return;
    this.#send({ type: "close", sessionId });
  }

  list(): PtySessionInfo[] {
    return [...this.#sessions.values()].map((s) => ({ sessionId: s.sessionId, shell: s.shell }));
  }

  /** The bridge worker's own pid (see the constructor comment for why a
   * worker exists at all). Exposed for tests that need to simulate the
   * worker itself crashing, distinct from an individual PTY session
   * exiting. */
  get workerPid(): number | undefined {
    return this.#worker.pid;
  }

  closeAll(): void {
    this.#sessions.clear();
    this.#send({ type: "closeAll" });
    this.#worker.kill();
  }
}
