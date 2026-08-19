import "../../testUtils/domTestSetup";
import { expect, test } from "bun:test";
import { StatusBarRegistry, SidebarPanelRegistry } from "./registries";

test("StatusBarRegistry: register/list/unregister", () => {
  const reg = new StatusBarRegistry();
  reg.register({ id: "git", mount: () => () => {} });
  expect(reg.list().map((i) => i.id)).toEqual(["git"]);
  reg.unregister("git");
  expect(reg.list()).toEqual([]);
});

test("StatusBarRegistry: registering the same id twice replaces it", () => {
  const reg = new StatusBarRegistry();
  let mounted = "";
  reg.register({ id: "git", mount: () => { mounted = "first"; return () => {}; } });
  reg.register({ id: "git", mount: () => { mounted = "second"; return () => {}; } });
  expect(reg.list().length).toBe(1);
  reg.list()[0]!.mount(document.createElement("div"));
  expect(mounted).toBe("second");
});

test("SidebarPanelRegistry: register/get/list/unregister", () => {
  const reg = new SidebarPanelRegistry();
  reg.register({ id: "todos", title: "TODOs", mount: () => () => {} });
  expect(reg.get("todos")?.title).toBe("TODOs");
  expect(reg.list().map((p) => p.id)).toEqual(["todos"]);
  reg.unregister("todos");
  expect(reg.get("todos")).toBeUndefined();
  expect(reg.list()).toEqual([]);
});
