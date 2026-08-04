import { expect, test } from "bun:test";
import { buildFimPrompt, estimateTokens } from "./index";

const caps = { id: "fake", contextWindowTokens: 100, supportsFim: true };
const req = { path: "a.ts", prefix: "const a = ", suffix: ";\n" };

test("estimateTokens is ceil(chars/4)", () => {
  expect(estimateTokens("abcde")).toBe(2);
});

test("includes high-score chunks and fim markers", () => {
  const p = buildFimPrompt(
    req,
    [
      {
        source: "buffer",
        text: "function helper() {}",
        score: 0.9,
        tokenCost: 5,
      },
    ],
    caps
  );
  expect(p).toContain("function helper() {}");
  expect(p).toContain(
    "<|fim_prefix|>const a = <|fim_suffix|>;\n<|fim_middle|>"
  );
});

test("drops chunks over budget, highest score wins", () => {
  const big = "x".repeat(200); // 50 tokens
  const p = buildFimPrompt(
    req,
    [
      { source: "low", text: big + "LOW", score: 0.1, tokenCost: 51 },
      { source: "high", text: big + "HIGH", score: 0.9, tokenCost: 51 },
    ],
    caps
  );
  expect(p).toContain("HIGH");
  expect(p).not.toContain("LOW");
});

test("trims prefix from the left to fit tiny windows", () => {
  const tiny = { ...caps, contextWindowTokens: 70 };
  const longPrefix = "y".repeat(1000) + "NEAR_CURSOR";
  const p = buildFimPrompt({ ...req, prefix: longPrefix }, [], tiny);
  expect(p).toContain("NEAR_CURSOR");
  expect(p.length).toBeLessThan(1000);
});
