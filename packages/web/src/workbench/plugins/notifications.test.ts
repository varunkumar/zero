import { expect, test } from "bun:test";
import { NotificationHub } from "./notifications";

test("dispatch calls every subscriber registered for that method", () => {
  const hub = new NotificationHub();
  const calls: unknown[] = [];
  hub.subscribe("fs/changed", (p) => calls.push(p));
  hub.subscribe("fs/changed", (p) => calls.push(p));
  hub.dispatch("fs/changed", { path: "a.ts" });
  expect(calls).toEqual([{ path: "a.ts" }, { path: "a.ts" }]);
});

test("dispatch does not call subscribers of a different method", () => {
  const hub = new NotificationHub();
  const calls: unknown[] = [];
  hub.subscribe("fs/changed", (p) => calls.push(p));
  hub.dispatch("pty/output", { sessionId: "x", data: "y" });
  expect(calls).toEqual([]);
});

test("the unsubscribe function returned by subscribe removes only that handler", () => {
  const hub = new NotificationHub();
  const calls: string[] = [];
  const unsubA = hub.subscribe("fs/changed", () => calls.push("a"));
  hub.subscribe("fs/changed", () => calls.push("b"));
  unsubA();
  hub.dispatch("fs/changed", {});
  expect(calls).toEqual(["b"]);
});

test("dispatch with no subscribers for a method is a no-op", () => {
  const hub = new NotificationHub();
  expect(() => hub.dispatch("nothing/here", {})).not.toThrow();
});
