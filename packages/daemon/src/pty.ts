import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import type { PtySessionInfo } from "@zero/protocol";

interface Session { sessionId: string; shell: string }

interface WorkerEvent { event: "data" | "exit"; sessionId: string; data?: string; exitCode?: number }

export class PtyService {
  #sessions = new Map<string, Session>();
  #worker: ChildProcessWithoutNullStreams;

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
    this.#worker = spawn("node", [new URL("./pty-worker.js", import.meta.url).pathname]);
    const rl = createInterface({ input: this.#worker.stdout });
    rl.on("line", (line) => {
      let msg: WorkerEvent;
      try { msg = JSON.parse(line) as WorkerEvent; } catch { return; }
      if (msg.event === "data") this.onOutput(msg.sessionId, msg.data ?? "");
      else if (msg.event === "exit") {
        // A natural exit (the shell process died on its own) still needs
        // reporting; an exit for a session close()/closeAll() already
        // removed is filtered by the worker itself (see pty-worker.js),
        // so anything reaching here is a genuine, previously-unknown exit.
        if (!this.#sessions.delete(msg.sessionId)) return;
        this.onExit(msg.sessionId, msg.exitCode ?? 0);
      }
    });
  }

  #send(msg: unknown): void {
    this.#worker.stdin.write(JSON.stringify(msg) + "\n");
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

  closeAll(): void {
    this.#sessions.clear();
    this.#send({ type: "closeAll" });
    this.#worker.kill();
  }
}
