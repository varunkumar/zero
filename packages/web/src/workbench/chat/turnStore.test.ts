import { expect, test } from "bun:test";
import { TurnStore } from "./turnStore";
import type { ChatTurnEvent } from "@zero/protocol";

test("fans out events to the listener registered for that turnId only", () => {
  const store = new TurnStore();
  const receivedA: ChatTurnEvent[] = [];
  const receivedB: ChatTurnEvent[] = [];
  store.onEvent("t1", (e) => receivedA.push(e));
  store.onEvent("t2", (e) => receivedB.push(e));

  store.handleEvent("t1", { type: "text", delta: "hi" });
  store.handleEvent("t2", { type: "text", delta: "yo" });

  expect(receivedA).toEqual([{ type: "text", delta: "hi" }]);
  expect(receivedB).toEqual([{ type: "text", delta: "yo" }]);
});

test("unsubscribing stops further delivery", () => {
  const store = new TurnStore();
  const received: ChatTurnEvent[] = [];
  const unsub = store.onEvent("t1", (e) => received.push(e));
  unsub();
  store.handleEvent("t1", { type: "text", delta: "hi" });
  expect(received).toEqual([]);
});

test("isActive is false before any event, true after a text delta, false after done", () => {
  const store = new TurnStore();
  expect(store.isActive("t1")).toBe(false);
  store.handleEvent("t1", { type: "text", delta: "hi" });
  expect(store.isActive("t1")).toBe(true);
  store.handleEvent("t1", {
    type: "done",
    message: { role: "assistant", content: "hi", createdAt: 0 },
    tokensUsed: 0,
  });
  expect(store.isActive("t1")).toBe(false);
});

test("isActive is false after an error event", () => {
  const store = new TurnStore();
  store.handleEvent("t2", { type: "text", delta: "hi" });
  store.handleEvent("t2", { type: "error", message: "boom" });
  expect(store.isActive("t2")).toBe(false);
});
