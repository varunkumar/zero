import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { CompletionEngine } from "@zero/core";
import { StatusBar, formatCompactTokens } from "./StatusBar";

// StatusPill calls `engine.status()` synchronously during render and wires
// up `onStatusChange` in an effect (which renderToStaticMarkup never runs),
// so a minimal fake covering just the synchronous call is enough here.
const fakeEngine = {
  status: () => ({ activeModel: null, reason: null }),
  onStatusChange: () => {},
} as unknown as CompletionEngine;

function render() {
  return renderToStaticMarkup(
    <StatusBar
      engine={fakeEngine}
      path={null}
      cursor={null}
      theme="dark"
      onToggleTheme={() => {}}
      lspStatus={null}
    />,
  );
}

describe("StatusBar token pill", () => {
  function renderWithTokenStatus(
    tokenStatus: { usedTokens: number | null; contextWindowTokens: number | null } | null,
  ) {
    return renderToStaticMarkup(
      <StatusBar
        engine={fakeEngine}
        path={null}
        cursor={null}
        theme="dark"
        onToggleTheme={() => {}}
        lspStatus={null}
        tokenStatus={tokenStatus}
      />,
    );
  }

  test("renders nothing when tokenStatus is null", () => {
    const html = renderWithTokenStatus(null);
    expect(html).not.toContain("tokens");
  });

  test("renders nothing when a turn hasn't run yet (both fields null)", () => {
    const html = renderWithTokenStatus({ usedTokens: null, contextWindowTokens: null });
    expect(html).not.toContain("tokens");
  });

  test("renders the used/total token counts compacted, with the exact counts in the tooltip", () => {
    const html = renderWithTokenStatus({ usedTokens: 6853, contextWindowTokens: 262_144 });
    expect(html).toContain("6K / 262K tokens");
    expect(html).toContain('title="6,853 / 262,144 tokens"');
  });
});

describe("formatCompactTokens", () => {
  test("leaves counts under 1,000 as-is", () => {
    expect(formatCompactTokens(853)).toBe("853");
  });

  test("truncates (not rounds) thousands to K", () => {
    expect(formatCompactTokens(6853)).toBe("6K");
    expect(formatCompactTokens(262_144)).toBe("262K");
    expect(formatCompactTokens(999_900)).toBe("999K");
  });

  test("formats millions with one decimal place", () => {
    expect(formatCompactTokens(1_250_000)).toBe("1.2M");
  });
});

describe("StatusBar version", () => {
  test("shows the build-time __ZERO_VERSION__", () => {
    const html = render();
    expect(html).toContain(`v${__ZERO_VERSION__}`);
  });
});
