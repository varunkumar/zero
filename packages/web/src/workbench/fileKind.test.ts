import { expect, test } from "bun:test";
import { classifyFile, mimeTypeFor } from "./fileKind";

test("classifies markdown files", () => {
  expect(classifyFile("README.md")).toBe("markdown");
  expect(classifyFile("notes.mdx")).toBe("markdown");
});

test("classifies image files", () => {
  for (const ext of ["png", "jpg", "jpeg", "gif", "svg", "webp"]) {
    expect(classifyFile(`a.${ext}`)).toBe("image");
  }
});

test("classifies pdf files", () => {
  expect(classifyFile("doc.pdf")).toBe("pdf");
});

test("everything else is text, including leading-dot files with no extension", () => {
  expect(classifyFile("index.ts")).toBe("text");
  expect(classifyFile(".gitignore")).toBe("text");
  expect(classifyFile("Makefile")).toBe("text");
});

test("mimeTypeFor mirrors the daemon's table for viewer-relevant extensions", () => {
  expect(mimeTypeFor("a.png")).toBe("image/png");
  expect(mimeTypeFor("a.pdf")).toBe("application/pdf");
  expect(mimeTypeFor("a.svg")).toBe("image/svg+xml");
});
