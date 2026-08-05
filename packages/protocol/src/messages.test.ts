import { expect, test } from "bun:test";
import { parseMessage, ProtocolError, FsSearchParams, FsSearchResult, SettingsSetParams } from "./messages";

test("round-trips a request", () => {
  const msg = { jsonrpc: "2.0" as const, id: 1, method: "fs/read", params: { path: "a.ts" } };
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
test("fs/search and settings params/results are plain JSON-serializable shapes", () => {
  const search: FsSearchParams = { query: "foo", caseSensitive: true };
  const result: FsSearchResult = { matches: [{ path: "a.ts", line: 1, column: 0, text: "foo()" }], truncated: false };
  expect(JSON.parse(JSON.stringify(search))).toEqual(search);
  expect(JSON.parse(JSON.stringify(result))).toEqual(result);

  const setParams: SettingsSetParams = { key: "workbench", value: { theme: "dark" } };
  expect(JSON.parse(JSON.stringify(setParams))).toEqual(setParams);
});
