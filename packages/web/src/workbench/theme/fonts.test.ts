import { describe, expect, test } from "bun:test";
import { ZERO_MONO_FONT } from "./fonts";

describe("ZERO_MONO_FONT", () => {
  test("is the FiraCode stack with a generic monospace fallback", () => {
    expect(ZERO_MONO_FONT).toBe("'FiraCode Nerd Font', 'Fira Code', monospace");
  });
});
