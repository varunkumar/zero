import * as pty from "node-pty";
import { randomUUID } from "node:crypto";
import type { PtySessionInfo } from "@zero/protocol";

interface Session { sessionId: string; shell: string; proc: pty.IPty }

export class PtyService {
  #sessions = new Map<string, Session>();

  constructor(
    private cwd: string,
    private onOutput: (sessionId: string, data: string) => void,
    private onExit: (sessionId: string, exitCode: number) => void,
  ) {}

  open(shell: string | undefined, cols: number, rows: number): { sessionId: string; shell: string } {
    const sessionId = randomUUID();
    const shellCmd = shell ?? (process.platform === "win32" ? "powershell.exe" : (process.env.SHELL ?? "/bin/bash"));
    const proc = pty.spawn(shellCmd, [], {
      name: "xterm-256color", cols, rows, cwd: this.cwd,
      env: process.env as Record<string, string>,
    });
    proc.onData((data) => this.onOutput(sessionId, data));
    proc.onExit(({ exitCode }) => {
      // Skip if the session was already removed by an explicit close()/
      // closeAll(), which notifies onExit synchronously itself — this
      // avoids double-firing onExit once the OS actually reaps the process.
      if (!this.#sessions.has(sessionId)) return;
      this.#sessions.delete(sessionId);
      this.onExit(sessionId, exitCode);
    });
    this.#sessions.set(sessionId, { sessionId, shell: shellCmd, proc });
    return { sessionId, shell: shellCmd };
  }

  input(sessionId: string, data: string): void {
    this.#sessions.get(sessionId)?.proc.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.#sessions.get(sessionId)?.proc.resize(cols, rows);
  }

  close(sessionId: string): void {
    const session = this.#sessions.get(sessionId);
    if (!session) return;
    this.#sessions.delete(sessionId);
    session.proc.kill();
    this.onExit(sessionId, 0);
  }

  list(): PtySessionInfo[] {
    return [...this.#sessions.values()].map((s) => ({ sessionId: s.sessionId, shell: s.shell }));
  }

  closeAll(): void {
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    for (const session of sessions) {
      session.proc.kill();
      this.onExit(session.sessionId, 0);
    }
  }
}
