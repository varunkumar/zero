import { expect, test } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./workspace";
import { SessionStore, InvalidSessionIdError } from "./sessions";

function makeStore(): SessionStore {
  const root = mkdtempSync(join(tmpdir(), "zero-"));
  return new SessionStore(new Workspace(root));
}

test("create then get round-trips an empty session", async () => {
  const store = makeStore();
  const id = await store.create("My chat");
  const session = await store.get(id);
  expect(session).toEqual({ id, title: "My chat", messages: [] });
});

test("create defaults the title", async () => {
  const store = makeStore();
  const id = await store.create();
  expect((await store.get(id))?.title).toBe("New chat");
});

test("append replaces the stored message list (compaction shrinks history)", async () => {
  const store = makeStore();
  const id = await store.create();
  await store.append(id, [{ role: "user", content: "hi", createdAt: 1 }]);
  await store.append(id, [{ role: "system", content: "summary", createdAt: 2 }]); // compaction: shrinks, doesn't grow
  expect((await store.get(id))?.messages).toEqual([{ role: "system", content: "summary", createdAt: 2 }]);
});

test("list sorts by most recently updated and reports message counts", async () => {
  const store = makeStore();
  const first = await store.create("First");
  await new Promise((r) => setTimeout(r, 5));
  const second = await store.create("Second");
  await store.append(first, [{ role: "user", content: "a", createdAt: 1 }, { role: "assistant", content: "b", createdAt: 2 }]);
  const list = await store.list();
  expect(list.map((s) => s.id)).toEqual([first, second]);
  expect(list.find((s) => s.id === first)?.messageCount).toBe(2);
});

test("rename updates the title without touching messages", async () => {
  const store = makeStore();
  const id = await store.create("Old");
  await store.append(id, [{ role: "user", content: "hi", createdAt: 1 }]);
  await store.rename(id, "New");
  expect(await store.get(id)).toEqual({ id, title: "New", messages: [{ role: "user", content: "hi", createdAt: 1 }] });
});

test("delete removes the session file", async () => {
  const store = makeStore();
  const id = await store.create();
  await store.delete(id);
  expect(await store.get(id)).toBeNull();
  expect(await store.list()).toEqual([]);
});

test("get/append/rename/delete reject non-UUID ids to block path traversal", async () => {
  const store = makeStore();
  await expect(store.get("../../etc/passwd")).rejects.toThrow(InvalidSessionIdError);
  await expect(store.append("../../etc/passwd", [])).rejects.toThrow(InvalidSessionIdError);
  await expect(store.rename("../../etc/passwd", "x")).rejects.toThrow(InvalidSessionIdError);
  await expect(store.delete("../../etc/passwd")).rejects.toThrow(InvalidSessionIdError);
});

test("list on a workspace with no sessions yet returns empty, not an error", async () => {
  const store = makeStore();
  expect(await store.list()).toEqual([]);
});
