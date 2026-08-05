import * as pty from "node-pty";
import { createInterface } from "node:readline";

const sessions = new Map();

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function handle(msg) {
  if (msg.type === "open") {
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
  handle(msg);
});
