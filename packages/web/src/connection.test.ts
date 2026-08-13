import { expect, test } from "bun:test";
import { shouldUseDaemon } from "./connection";

test("token query param means daemon mode", () => {
  expect(shouldUseDaemon("?token=abc")).toBe(true);
  expect(shouldUseDaemon("?foo=1", "envtok")).toBe(true);
  expect(shouldUseDaemon("")).toBe(false);
  expect(shouldUseDaemon("?foo=1")).toBe(false);
});
