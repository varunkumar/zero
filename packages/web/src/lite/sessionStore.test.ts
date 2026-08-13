import { expect, test } from "bun:test";
import { createMemorySessionDb, LiteSessionStore } from "./sessionStore";

test("sessions are isolated by rootId", async () => {
  const db = createMemorySessionDb();
  const a = new LiteSessionStore("root-a", db);
  const b = new LiteSessionStore("root-b", db);
  const id = await a.create("A");
  expect((await a.list()).map((s) => s.id)).toEqual([id]);
  expect(await b.list()).toEqual([]);
  expect(await b.get(id)).toBeNull();
});

test("rejects non-UUID ids", async () => {
  const store = new LiteSessionStore("r", createMemorySessionDb());
  await expect(store.get("../x")).rejects.toThrow();
});

test("append replaces the message list and get reflects it", async () => {
  const store = new LiteSessionStore("r", createMemorySessionDb());
  const id = await store.create("chat");
  await store.append(id, [{ role: "user", content: "hi", createdAt: 1 }]);
  const got = await store.get(id);
  expect(got?.messages).toEqual([{ role: "user", content: "hi", createdAt: 1 }]);
});

test("rename updates the title reported by list", async () => {
  const store = new LiteSessionStore("r", createMemorySessionDb());
  const id = await store.create("old");
  await store.rename(id, "new");
  expect((await store.list()).find((s) => s.id === id)?.title).toBe("new");
});

test("rename bumps updatedAt so the renamed session sorts to the front of list", async () => {
  const store = new LiteSessionStore("r", createMemorySessionDb());
  const older = await store.create("older");
  await new Promise((r) => setTimeout(r, 5));
  const newer = await store.create("newer");
  // Without a doctored updatedAt, "newer" (created after "older") would
  // already sort first - rename "older" and confirm it jumps ahead.
  await new Promise((r) => setTimeout(r, 5));
  await store.rename(older, "older-renamed");
  const ids = (await store.list()).map((s) => s.id);
  expect(ids[0]).toBe(older);
  expect(ids[1]).toBe(newer);
});

test("delete removes the session", async () => {
  const store = new LiteSessionStore("r", createMemorySessionDb());
  const id = await store.create();
  await store.delete(id);
  expect(await store.get(id)).toBeNull();
  expect(await store.list()).toEqual([]);
});

test("create defaults to 'New chat' when no title is given", async () => {
  const store = new LiteSessionStore("r", createMemorySessionDb());
  const id = await store.create();
  expect((await store.get(id))?.title).toBe("New chat");
});
