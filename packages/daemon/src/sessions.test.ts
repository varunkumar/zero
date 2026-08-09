import { expect, test } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, InvalidSessionIdError } from "./sessions";
import { useTempZeroHome } from "./testSupport/zeroHome";
import { sessionsDir } from "./paths";

useTempZeroHome();

function makeStore(root = mkdtempSync(join(tmpdir(), "zero-"))): SessionStore {
  return new SessionStore(root);
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

test("list skips a stray non-UUID filename instead of failing entirely", async () => {
  const root = mkdtempSync(join(tmpdir(), "zero-"));
  const store = new SessionStore(root);
  const id = await store.create("Valid session");
  const dir = sessionsDir(root);
  await writeFile(join(dir, "not-a-uuid.json"), "{}", "utf8");
  const list = await store.list();
  expect(list.map((s) => s.id)).toEqual([id]);
});

test("append on a deleted session is a no-op and does not recreate it", async () => {
  const store = makeStore();
  const id = await store.create("Gone");
  await store.delete(id);
  await store.append(id, [{ role: "user", content: "hi", createdAt: 1 }]);
  expect(await store.get(id)).toBeNull();
});

test("sessions from different workspace roots are stored and listed separately", async () => {
  const rootA = mkdtempSync(join(tmpdir(), "zero-a-"));
  const rootB = mkdtempSync(join(tmpdir(), "zero-b-"));
  const storeA = new SessionStore(rootA);
  const storeB = new SessionStore(rootB);

  const idA = await storeA.create("chat in A");
  await storeB.create("chat in B");

  expect(await storeA.get(idA)).not.toBeNull();
  expect((await storeA.list()).map((s) => s.title)).toEqual(["chat in A"]);
  expect((await storeB.list()).map((s) => s.title)).toEqual(["chat in B"]);
  expect(existsSync(sessionsDir(rootA))).toBe(true);
  expect(existsSync(sessionsDir(rootB))).toBe(true);
});
