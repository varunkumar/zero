import { expect, test } from "bun:test";
import { TabStore } from "./store";

test("starts with one empty group", () => {
  const store = new TabStore();
  const groups = store.getGroups();
  expect(groups.length).toBe(1);
  expect(groups[0].tabs).toEqual([]);
  expect(groups[0].activeTabId).toBeNull();
});

test("openFile adds a tab and makes it active", () => {
  const store = new TabStore();
  const groupId = store.getGroups()[0].id;
  const tabId = store.openFile(groupId, "a.ts", "hello");
  const group = store.getGroups()[0];
  expect(group.tabs.map((t) => t.path)).toEqual(["a.ts"]);
  expect(group.activeTabId).toBe(tabId);
  expect(group.tabs[0].dirty).toBe(false);
});

test("openFile reuses an existing tab for the same path in the same group", () => {
  const store = new TabStore();
  const groupId = store.getGroups()[0].id;
  const id1 = store.openFile(groupId, "a.ts", "hello");
  const id2 = store.openFile(groupId, "a.ts", "hello-updated-on-disk");
  expect(id1).toBe(id2);
  expect(store.getGroups()[0].tabs.length).toBe(1);
});

test("updateContent marks a tab dirty, markSaved clears it", () => {
  const store = new TabStore();
  const groupId = store.getGroups()[0].id;
  const tabId = store.openFile(groupId, "a.ts", "hello");
  store.updateContent(tabId, "hello world");
  expect(store.findTab(tabId)!.tab.dirty).toBe(true);
  store.markSaved(tabId);
  expect(store.findTab(tabId)!.tab.dirty).toBe(false);
  expect(store.findTab(tabId)!.tab.savedContent).toBe("hello world");
});

test("closeTab removes it and reassigns activeTabId", () => {
  const store = new TabStore();
  const groupId = store.getGroups()[0].id;
  const id1 = store.openFile(groupId, "a.ts", "1");
  const id2 = store.openFile(groupId, "b.ts", "2");
  store.setActiveTab(groupId, id2);
  store.closeTab(id2);
  const group = store.getGroups()[0];
  expect(group.tabs.map((t) => t.id)).toEqual([id1]);
  expect(group.activeTabId).toBe(id1);
});

test("closeTab on the last tab leaves activeTabId null", () => {
  const store = new TabStore();
  const groupId = store.getGroups()[0].id;
  const id1 = store.openFile(groupId, "a.ts", "1");
  store.closeTab(id1);
  expect(store.getGroups()[0].activeTabId).toBeNull();
});

test("splitGroup creates a second empty group", () => {
  const store = new TabStore();
  const groupId = store.getGroups()[0].id;
  const newGroupId = store.splitGroup(groupId);
  expect(store.getGroups().length).toBe(2);
  expect(store.getGroups().find((g) => g.id === newGroupId)?.tabs).toEqual([]);
});

test("subscribe notifies listeners on state changes", () => {
  const store = new TabStore();
  let notifications = 0;
  const unsubscribe = store.subscribe(() => { notifications++; });
  store.openFile(store.getGroups()[0].id, "a.ts", "1");
  expect(notifications).toBe(1);
  unsubscribe();
  store.openFile(store.getGroups()[0].id, "b.ts", "2");
  expect(notifications).toBe(1);
});
