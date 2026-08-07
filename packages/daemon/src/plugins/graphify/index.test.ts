import { expect, test } from "bun:test";
import { createGraphify } from "./index";

test("createGraphify returns factory and getIndexer", () => {
  const graphify = createGraphify();
  expect(typeof graphify.factory).toBe("function");
  expect(typeof graphify.getIndexer).toBe("function");
});

test("createGraphify exposes query() alongside getIndexer()", () => {
  const graphify = createGraphify();
  expect(typeof graphify.query).toBe("function");
  // Before activation the store is empty; query() must not throw.
  expect(() => graphify.query({ q: "anything" })).not.toThrow();
});
