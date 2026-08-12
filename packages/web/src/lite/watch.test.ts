import { expect, test } from "bun:test";
import { startWatch } from "./watch";

test("poll path emits fs/changed for added and removed paths", async () => {
  let entries = [{ path: "a.ts" }];
  const events: string[] = [];
  const w = startWatch(
    { tree: async () => entries },
    (path) => events.push(path),
    { intervalMs: 10, observer: null },
  );
  await Bun.sleep(25);
  entries = [{ path: "a.ts" }, { path: "b.ts" }];
  await Bun.sleep(25);
  entries = [{ path: "b.ts" }];
  await Bun.sleep(25);
  w.stop();
  expect(events).toContain("b.ts");
  expect(events.filter((p) => p === "a.ts").length).toBeGreaterThan(0);
});
