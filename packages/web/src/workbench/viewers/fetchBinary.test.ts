import { expect, test } from "bun:test";
import type { RpcClient } from "@zero/protocol";
import { fetchBinaryFile, base64ToDataUrl, base64ToObjectUrl } from "./fetchBinary";

test("fetchBinaryFile requests fs/readBinary with the given path", async () => {
  let seenMethod = "";
  let seenParams: unknown;
  const client = {
    request: async (method: string, params: unknown) => {
      seenMethod = method;
      seenParams = params;
      return { contentBase64: "Zm9v", mimeType: "image/png" };
    },
  } as unknown as RpcClient;
  const result = await fetchBinaryFile(client, "a.png");
  expect(seenMethod).toBe("fs/readBinary");
  expect(seenParams).toEqual({ path: "a.png" });
  expect(result).toEqual({ contentBase64: "Zm9v", mimeType: "image/png" });
});

test("base64ToDataUrl builds a data: URL", () => {
  expect(base64ToDataUrl("Zm9v", "image/png")).toBe("data:image/png;base64,Zm9v");
});

test("base64ToObjectUrl builds a blob: URL via URL.createObjectURL", () => {
  const url = base64ToObjectUrl("Zm9v", "application/pdf");
  expect(url.startsWith("blob:")).toBe(true);
});
