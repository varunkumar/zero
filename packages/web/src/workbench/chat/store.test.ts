import { expect, test } from "bun:test";
import { ChatStore } from "./store";

test("addSession makes it active; removeSession falls back to the next session", () => {
  const store = new ChatStore();
  store.addSession({ id: "a", title: "A", updatedAt: 1, messageCount: 0 });
  expect(store.getActiveId()).toBe("a");
  store.addSession({ id: "b", title: "B", updatedAt: 2, messageCount: 0 });
  expect(store.getActiveId()).toBe("b");
  store.removeSession("b");
  expect(store.getActiveId()).toBe("a");
  store.removeSession("a");
  expect(store.getActiveId()).toBeNull();
});

test("setSessions replaces the list and clears activeId if it no longer exists", () => {
  const store = new ChatStore();
  store.addSession({ id: "a", title: "A", updatedAt: 1, messageCount: 0 });
  store.setSessions([{ id: "b", title: "B", updatedAt: 2, messageCount: 0 }]);
  expect(store.getSessions()).toEqual([{ id: "b", title: "B", updatedAt: 2, messageCount: 0 }]);
  expect(store.getActiveId()).toBeNull();
});

test("touchSession updates title and bumps updatedAt without changing activeId", () => {
  const store = new ChatStore();
  store.addSession({ id: "a", title: "A", updatedAt: 1, messageCount: 0 });
  store.touchSession("a", "Renamed");
  expect(store.getSessions()[0]).toMatchObject({ id: "a", title: "Renamed" });
  expect(store.getActiveId()).toBe("a");
});

test("subscribe notifies on every mutation", () => {
  const store = new ChatStore();
  let notified = 0;
  store.subscribe(() => { notified++; });
  store.addSession({ id: "a", title: "A", updatedAt: 1, messageCount: 0 });
  store.setActive("a");
  store.touchSession("a");
  store.removeSession("a");
  expect(notified).toBe(4);
});
