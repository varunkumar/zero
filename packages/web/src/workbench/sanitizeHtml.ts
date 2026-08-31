import createDOMPurify from "dompurify";

// DOMPurify's default export is a factory that binds to a DOM window rather
// than sanitizing directly (its browser-auto-detection only kicks in when a
// global `window` already exists at import time, which isn't guaranteed
// under `bun:test` - see testUtils/domTestSetup.ts). Resolve and cache one
// instance lazily against whatever `window` is available at call time,
// rather than at module load.
let purifier: ReturnType<typeof createDOMPurify> | null = null;

function getPurifier(): ReturnType<typeof createDOMPurify> {
  if (!purifier) {
    if (typeof window === "undefined") {
      throw new Error("sanitizeHtml requires a DOM window (DOMPurify has none to sanitize against)");
    }
    purifier = createDOMPurify(window);
  }
  return purifier;
}

export function sanitizeHtml(html: string): string {
  return getPurifier().sanitize(html);
}
