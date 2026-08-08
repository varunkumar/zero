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
