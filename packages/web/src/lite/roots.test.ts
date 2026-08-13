import { expect, test } from "bun:test";
import { createMemoryRootStore } from "./roots";
import { createMemRoot } from "./memDir";

test("memory root store save/list/remove", async () => {
  const store = createMemoryRootStore();
  const handle = createMemRoot("proj");
  await store.save({ id: "r1", name: "proj", handle });
  expect((await store.list()).map((r) => r.id)).toEqual(["r1"]);
  await store.remove("r1");
  expect(await store.list()).toEqual([]);
});
