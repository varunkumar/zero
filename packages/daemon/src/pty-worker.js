import * as pty from "node-pty";
import { createInterface } from "node:readline";

const sessions = new Map();

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function handle(msg) {
  if (msg.type === "open") {
    try {
      const proc = pty.spawn(msg.shell, [], {
        name: "xterm-256color", cols: msg.cols, rows: msg.rows, cwd: msg.cwd,
        env: process.env,
      });
      sessions.set(msg.sessionId, proc);
      proc.onData((data) => {
        if (!sessions.has(msg.sessionId)) return;
        send({ event: "data", sessionId: msg.sessionId, data });
      });
      proc.onExit(({ exitCode }) => {
        if (!sessions.has(msg.sessionId)) return;
        sessions.delete(msg.sessionId);
        send({ event: "exit", sessionId: msg.sessionId, exitCode });
      });
    } catch {
      // node-pty throws synchronously for e.g. a nonexistent shell binary.
      // There is no live session to have been added to `sessions` here (the
      // throw happens before pty.spawn returns), so nothing to remove — just
      // report the failure so the parent's #sessions entry gets cleaned up
      // instead of pointing at a session that never came up.
      send({ event: "exit", sessionId: msg.sessionId, exitCode: 1 });
    }
    return;
  }
  if (msg.type === "input") { sessions.get(msg.sessionId)?.write(msg.data); return; }
  if (msg.type === "resize") { sessions.get(msg.sessionId)?.resize(msg.cols, msg.rows); return; }
  if (msg.type === "close") {
    const proc = sessions.get(msg.sessionId);
    if (!proc) return;
    sessions.delete(msg.sessionId);
    proc.kill();
    return;
  }
  if (msg.type === "closeAll") {
    for (const proc of sessions.values()) proc.kill();
    sessions.clear();
    return;
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  try {
    handle(msg);
  } catch {
    // Defensive: handle() should not throw beyond the try/catch already
    // inside the "open" branch, but never let any other message type's
    // failure take the whole worker (and every live session with it) down.
  }
});

// If the parent daemon dies (or its stdin pipe otherwise closes) without
// calling closeAll(), don't leave this worker (and every real shell process
// it's hosting via node-pty) running as an orphan forever. On Unix a child
// is reparented rather than killed when its parent exits, so without this
// the worker's event loop — kept alive by the live node-pty sessions — would
// never exit on its own.
rl.on("close", () => {
  for (const proc of sessions.values()) proc.kill();
  process.exit(0);
});
