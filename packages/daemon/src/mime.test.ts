import { expect, test } from "bun:test";
import { mimeTypeFor } from "./mime";

test("maps known extensions to mime types", () => {
  expect(mimeTypeFor("a.png")).toBe("image/png");
  expect(mimeTypeFor("a.jpg")).toBe("image/jpeg");
  expect(mimeTypeFor("a.jpeg")).toBe("image/jpeg");
  expect(mimeTypeFor("a.gif")).toBe("image/gif");
  expect(mimeTypeFor("a.svg")).toBe("image/svg+xml");
  expect(mimeTypeFor("a.webp")).toBe("image/webp");
  expect(mimeTypeFor("a.pdf")).toBe("application/pdf");
});

test("falls back to octet-stream for unknown extensions", () => {
  expect(mimeTypeFor("a.bin")).toBe("application/octet-stream");
  expect(mimeTypeFor("noext")).toBe("application/octet-stream");
});
