import { expect, test } from "bun:test";
import { CommandRegistry } from "./registry";

test("register, get, run", () => {
  const reg = new CommandRegistry();
  let ran = false;
  reg.register({ id: "test.cmd", title: "Test Command", run: () => { ran = true; } });
  expect(reg.get("test.cmd")?.title).toBe("Test Command");
  reg.run("test.cmd");
  expect(ran).toBe(true);
});

test("run throws for unknown command", () => {
  const reg = new CommandRegistry();
  expect(() => reg.run("missing")).toThrow();
});

test("list returns all registered commands", () => {
  const reg = new CommandRegistry();
  reg.register({ id: "a", title: "A", run: () => {} });
  reg.register({ id: "b", title: "B", run: () => {}, keybinding: "$mod+P" });
  expect(reg.list().map((c) => c.id).sort()).toEqual(["a", "b"]);
});

test("unregister removes a command", () => {
  const reg = new CommandRegistry();
  reg.register({ id: "a", title: "A", run: () => {} });
  reg.unregister("a");
  expect(reg.get("a")).toBeUndefined();
});

test("registering the same id twice replaces the command", () => {
  const reg = new CommandRegistry();
  let calls = 0;
  reg.register({ id: "a", title: "A1", run: () => { calls++; } });
  reg.register({ id: "a", title: "A2", run: () => { calls += 10; } });
  expect(reg.list().length).toBe(1);
  reg.run("a");
  expect(calls).toBe(10);
});
