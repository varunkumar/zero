import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { CompletionEngine } from "@zero/core";
import { StatusBar } from "./StatusBar";

// StatusPill calls `engine.status()` synchronously during render and wires
// up `onStatusChange` in an effect (which renderToStaticMarkup never runs),
// so a minimal fake covering just the synchronous call is enough here.
const fakeEngine = {
  status: () => ({ activeModel: null, reason: null }),
  onStatusChange: () => {},
} as unknown as CompletionEngine;

function render(gitStatus: { branch: string; dirtyCount: number; remoteUrl: string | null } | null) {
  return renderToStaticMarkup(
    <StatusBar
      engine={fakeEngine}
      path={null}
      cursor={null}
      theme="dark"
      onToggleTheme={() => {}}
      lspStatus={null}
      gitStatus={gitStatus}
    />,
  );
}

describe("StatusBar git pill", () => {
  test("renders nothing for the git pill when gitStatus is null", () => {
    const html = render(null);
    expect(html).not.toContain("GitHub");
  });

  test("renders the branch name and a GitHub link when gitStatus is provided", () => {
    const html = render({
      branch: "main",
      dirtyCount: 0,
      remoteUrl: "git@github.com:acme/widget.git",
    });
    expect(html).toContain("main");
    expect(html).toContain("GitHub");
    expect(html).toContain("https://github.com/acme/widget");
  });

  test("omits the GitHub link when there's no remote", () => {
    const html = render({ branch: "main", dirtyCount: 0, remoteUrl: null });
    expect(html).toContain("main");
    expect(html).not.toContain("GitHub");
  });
});

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
        gitStatus={null}
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

  test("renders the used/total token counts, comma-formatted", () => {
    const html = renderWithTokenStatus({ usedTokens: 1234, contextWindowTokens: 128_000 });
    expect(html).toContain("1,234 / 128,000 tokens");
  });
});

describe("StatusBar version", () => {
  test("shows the build-time __ZERO_VERSION__", () => {
    const html = render(null);
    expect(html).toContain(`v${__ZERO_VERSION__}`);
  });
});
