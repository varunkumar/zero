import { expect, test } from "bun:test";
import { renderStatus, updateStatusBar, type StatusBarItemLike } from "./statusBar";

test("renders daemon-not-found status", () => {
  const { text, tooltip } = renderStatus({ kind: "daemon-not-found" });
  expect(text).toContain("Zero");
  expect(tooltip).toContain("daemon not found");
});

test("renders no-model status with a reason", () => {
  const { tooltip } = renderStatus({ kind: "no-model", reason: "no model available" });
  expect(tooltip).toContain("no model available");
});

test("renders active status with the model id", () => {
  const { text, tooltip } = renderStatus({ kind: "active", model: "zero-gateway" });
  expect(text).toContain("zero-gateway");
  expect(tooltip).toContain("zero-gateway");
});

test("renders loading status with a spinner icon", () => {
  const { text, tooltip } = renderStatus({ kind: "loading" });
  expect(text).toContain("sync~spin");
  expect(tooltip).toContain("fetching completion");
});

test("updateStatusBar writes text/tooltip and shows the item", () => {
  const item: StatusBarItemLike = { text: "", tooltip: "", show() { this.shown = true; }, shown: false } as any;
  updateStatusBar(item, { kind: "active", model: "zero-gateway" });
  expect(item.text).toContain("zero-gateway");
  expect((item as any).shown).toBe(true);
});
