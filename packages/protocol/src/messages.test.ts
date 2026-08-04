import { expect, test } from "bun:test";
import { parseMessage, ProtocolError } from "./messages";

test("round-trips a request", () => {
  const msg = { jsonrpc: "2.0", id: 1, method: "fs/read", params: { path: "a.ts" } };
  expect(parseMessage(JSON.stringify(msg))).toEqual(msg);
});
test("classifies notification (no id)", () => {
  const msg = { jsonrpc: "2.0", method: "fs/changed", params: { path: "a.ts" } };
  const parsed = parseMessage(JSON.stringify(msg));
  expect("id" in parsed).toBe(false);
});
test("rejects garbage", () => {
  expect(() => parseMessage("{}")).toThrow(ProtocolError);
  expect(() => parseMessage("not json")).toThrow(ProtocolError);
});
