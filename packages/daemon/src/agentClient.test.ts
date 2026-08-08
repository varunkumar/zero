import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { SessionStore } from "./sessions";
import { Workspace } from "./workspace";
import { createAgentRuntimeClient } from "./agentClient";

test("adapts chat/get and chat/append onto SessionStore in-process", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zero-agentclient-"));
  const ws = new Workspace(dir);
  const sessions = new SessionStore(ws);
  const id = await sessions.create("t");
  const client = createAgentRuntimeClient(sessions);

  const got = await client.request<{ messages: unknown[] }>("chat/get", { id });
  expect(got.messages).toEqual([]);

  await client.request("chat/append", { id, messages: [{ role: "user", content: "hi", createdAt: 1 }] });
  const after = await client.request<{ messages: unknown[] }>("chat/get", { id });
  expect(after.messages).toHaveLength(1);
});

test("throws for an unknown method", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zero-agentclient-"));
  const client = createAgentRuntimeClient(new SessionStore(new Workspace(dir)));
  await expect(client.request("bogus/method")).rejects.toThrow("unexpected method");
});
