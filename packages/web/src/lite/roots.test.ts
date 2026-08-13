import { expect, test } from "bun:test";
import { createMemoryRootStore, findSameRoot, sortByLastOpened, type LiteRoot } from "./roots";
import { createMemRoot } from "./memDir";
import type { DirHandle } from "./browserFs";

test("memory root store save/list/remove", async () => {
  const store = createMemoryRootStore();
  const handle = createMemRoot("proj");
  await store.save({ id: "r1", name: "proj", handle });
  expect((await store.list()).map((r) => r.id)).toEqual(["r1"]);
  await store.remove("r1");
  expect(await store.list()).toEqual([]);
});

test("findSameRoot matches via isSameEntry and reuses the existing id", async () => {
  const projHandle = createMemRoot("proj") as DirHandle & { isSameEntry?(other: DirHandle): Promise<boolean> };
  // The in-memory test double has no isSameEntry, so give this one a
  // structural-identity stand-in the way a real FileSystemDirectoryHandle
  // would behave: same object reference => same entry.
  projHandle.isSameEntry = async (other) => other === projHandle;
  const other = createMemRoot("other");
  const roots: LiteRoot[] = [
    { id: "r-other", name: "other", handle: other },
    { id: "r-proj", name: "proj", handle: projHandle },
  ];

  expect(await findSameRoot(roots, projHandle)).toEqual(roots[1]);
  expect(await findSameRoot(roots, createMemRoot("unrelated"))).toBeUndefined();
});

test("findSameRoot treats a handle without isSameEntry as never matching", async () => {
  const handle = createMemRoot("proj");
  const roots: LiteRoot[] = [{ id: "r1", name: "proj", handle }];
  // createMemRoot's fake handles don't implement isSameEntry - must not throw.
  expect(await findSameRoot(roots, handle)).toBeUndefined();
});

test("sortByLastOpened orders most-recently-opened first, undefined last", () => {
  const a: LiteRoot = { id: "a", name: "a", handle: createMemRoot("a"), lastOpenedAt: 100 };
  const b: LiteRoot = { id: "b", name: "b", handle: createMemRoot("b"), lastOpenedAt: 300 };
  const c: LiteRoot = { id: "c", name: "c", handle: createMemRoot("c") };
  expect(sortByLastOpened([a, b, c]).map((r) => r.id)).toEqual(["b", "a", "c"]);
});
