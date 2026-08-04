import { expect, mock, test } from "bun:test";
import { CommandRegistry } from "../commands/registry";
import { buildKeyMap } from "./dispatcher";

// NOTE: bun:test has no DOM shim (no global KeyboardEvent/navigator), so we
// cannot dispatch real KeyboardEvents here. Verified empirically: a trivial
// `new KeyboardEvent(...)` in a bun:test file throws `KeyboardEvent is not
// defined`. Instead we unit-test the pure `buildKeyMap` seam that
// `attachKeybindings` wraps with `tinykeys(...)`.

test("buildKeyMap includes an entry for each command with a keybinding", () => {
  const registry = new CommandRegistry();
  let ran = false;
  registry.register({
    id: "palette.open",
    title: "Open Palette",
    run: () => {
      ran = true;
    },
    keybinding: "$mod+Shift+KeyP",
  });

  const keyMap = buildKeyMap(registry);

  expect(Object.keys(keyMap)).toEqual(["$mod+Shift+KeyP"]);
  keyMap["$mod+Shift+KeyP"]!({ preventDefault: () => {} } as KeyboardEvent);
  expect(ran).toBe(true);
});

test("buildKeyMap omits commands without a keybinding", () => {
  const registry = new CommandRegistry();
  registry.register({ id: "no.binding", title: "No Binding", run: () => {} });

  const keyMap = buildKeyMap(registry);

  expect(Object.keys(keyMap)).toEqual([]);
});

test("buildKeyMap dispatches to the correct command id when multiple are bound", () => {
  const registry = new CommandRegistry();
  const calls: string[] = [];
  registry.register({ id: "a", title: "A", run: () => calls.push("a"), keybinding: "$mod+KeyA" });
  registry.register({ id: "b", title: "B", run: () => calls.push("b"), keybinding: "$mod+KeyB" });

  const keyMap = buildKeyMap(registry);
  keyMap["$mod+KeyB"]!({ preventDefault: () => {} } as KeyboardEvent);

  expect(calls).toEqual(["b"]);
});

test("keyMap handler calls preventDefault on the event", () => {
  const registry = new CommandRegistry();
  registry.register({ id: "a", title: "A", run: () => {}, keybinding: "$mod+KeyA" });

  const keyMap = buildKeyMap(registry);
  let prevented = false;
  keyMap["$mod+KeyA"]!({ preventDefault: () => (prevented = true) } as unknown as KeyboardEvent);

  expect(prevented).toBe(true);
});

test("attachKeybindings calls tinykeys with the target and the built key map, and returns its detach fn unchanged", async () => {
  const detach = () => {};
  const tinykeysMock = mock((_target: unknown, _keyMap: unknown) => detach);
  mock.module("tinykeys", () => ({ tinykeys: tinykeysMock }));

  // Re-import so the module picks up the mocked "tinykeys" dependency.
  const { attachKeybindings: attachKeybindingsWithMock } = await import("./dispatcher");

  const registry = new CommandRegistry();
  registry.register({ id: "a", title: "A", run: () => {}, keybinding: "$mod+KeyA" });
  const target = {} as EventTarget;

  const returned = attachKeybindingsWithMock(registry, target);

  expect(tinykeysMock).toHaveBeenCalledTimes(1);
  const [calledTarget, calledKeyMap] = tinykeysMock.mock.calls[0]!;
  expect(calledTarget).toBe(target);
  expect(Object.keys(calledKeyMap as Record<string, unknown>)).toEqual(["$mod+KeyA"]);
  expect(returned).toBe(detach);
});
