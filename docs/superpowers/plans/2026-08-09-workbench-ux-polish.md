# Workbench UX Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a batch of independent UX/DX fixes to the web workbench and daemon (favicon, git status, tabbed terminal/chat with live theming, a real PTY-flakiness fix, chat UX improvements, file CRUD, clearer model/context indicators, tab icons) as one worktree and one PR.

**Architecture:** No new subsystems - every task extends an existing pattern already in the codebase (daemon `daemon.rpc.register` RPCs following the `fs/*`/`pty/*` template, `Bun.spawn(["git", ...])` shell-outs following `gitCheckpoint.ts`, dockview panels/`CommandRegistry` in `Workbench.tsx`, `--zero-*` CSS custom properties from `theme.css`, the existing `AgentRuntimeStatus`/`chat/status` status-push path).

**Tech Stack:** Bun, TypeScript (strict, ESM), React, dockview-react, `@xterm/xterm`, Zod (daemon RPC schemas), `bun:test`.

## Global Constraints

- `@zero/core` and `@zero/protocol` must never import DOM or Node/Bun APIs; all capabilities are injected.
- All packages: TypeScript `strict: true`, ESM only.
- Daemon binds `127.0.0.1` only; WebSocket connections without the session token are rejected.
- The editor must stay fully usable when no model is available - degrade the failing subsystem only, never break editing (this project's convention, already followed by `PtyService` and `GitCheckpoint`: catch, warn once, return a neutral/null result - never throw out to the caller for an optional subsystem).
- Token estimate convention: `Math.ceil(chars / 4)` (`packages/core/src/tokens.ts`, `estimateTokens`).
- New behavior needs tests alongside it (co-located `*.test.ts`), `@zero/core` in particular expects dense unit coverage with injected fakes.
- Commit after each coherent unit of work; conventional-commit style messages.
- Version bump is a patch bump on `package.json` (root), done once at the end - no milestone doc update.

---

## File Structure

New files:
- `packages/daemon/src/gitInfo.ts` - `git/status` + remote-URL shell-outs (mirrors `gitCheckpoint.ts`'s `Bun.spawn` pattern), plus its test.
- `packages/web/public/favicon.svg` - favicon asset derived from `Logomark`.

Modified files (grouped by task below): `packages/protocol/src/messages.ts`, `packages/daemon/src/workspace.ts`, `packages/daemon/src/main.ts`, `packages/web/index.html`, `packages/web/src/workbench/StatusBar.tsx`, `packages/web/src/workbench/layout/Workbench.tsx`, `packages/web/src/workbench/terminal/TerminalHost.tsx`, `packages/web/src/workbench/terminal/theme.ts`, `packages/web/src/workbench/chat/ChatPanel.tsx`, `packages/web/src/workbench/chat/store.ts`, `packages/web/src/workbench/chat/turnStore.ts`, `packages/web/src/workbench/filetree/FileTreePanel.tsx`, `packages/web/src/StatusPill.tsx`, `packages/core/src/agentRuntime.ts`, `packages/daemon/src/pty.ts` (pending spike findings), `package.json`.

---

### Task 1: Favicon

**Files:**
- Create: `packages/web/public/favicon.svg`
- Modify: `packages/web/index.html`

**Interfaces:** None (static asset).

- [ ] **Step 1: Read the existing Logomark to derive the favicon from the same mark**

Read `packages/web/src/workbench/theme/Logomark.tsx` and copy its SVG path/shape data (not the React wrapper) into a standalone SVG document sized for a favicon.

- [ ] **Step 2: Create the favicon SVG**

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
  <!-- paste the path(s) from Logomark.tsx here, scaled to fit the 0 0 32 32 viewBox -->
</svg>
```

(The exact `<path>` data must be copied from `Logomark.tsx` at implementation time - do not invent new geometry, the favicon must render the same mark used elsewhere in the app.)

- [ ] **Step 3: Wire it into index.html**

Open `packages/web/index.html`, and inside `<head>` add:

```html
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
```

- [ ] **Step 4: Verify in the dev server**

Run: `bun run --cwd packages/web dev` and load the app in a browser; confirm the tab icon shows the mark, not the default Vite icon.

- [ ] **Step 5: Commit**

```bash
git add packages/web/public/favicon.svg packages/web/index.html
git commit -m "feat(web): add Zero favicon"
```

---

### Task 2: Git status + GitHub remote link in the status bar

**Files:**
- Create: `packages/daemon/src/gitInfo.ts`
- Create: `packages/daemon/src/gitInfo.test.ts`
- Modify: `packages/protocol/src/messages.ts`
- Modify: `packages/daemon/src/main.ts`
- Modify: `packages/web/src/workbench/StatusBar.tsx`
- Modify: `packages/web/src/workbench/layout/Workbench.tsx`

**Interfaces:**
- Produces: `GitStatusResult` type (`packages/protocol`), `git/status` RPC (daemon), `<StatusBar gitStatus={...} />` prop.

- [ ] **Step 1: Add the protocol type**

In `packages/protocol/src/messages.ts`, add:

```ts
export interface GitStatusResult {
  branch: string;
  dirtyCount: number;
  ahead: number;
  behind: number;
  remoteUrl: string | null;
}
```

- [ ] **Step 2: Write the failing daemon test**

Create `packages/daemon/src/gitInfo.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getGitStatus } from "./gitInfo";

async function git(cwd: string, args: string[]) {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  await proc.exited;
}

describe("getGitStatus", () => {
  test("returns null for a non-git directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "zero-nogit-"));
    expect(await getGitStatus(root)).toBeNull();
  });

  test("reports branch, dirty count, and null remote for a clean local-only repo", async () => {
    const root = mkdtempSync(join(tmpdir(), "zero-git-"));
    await git(root, ["init", "-b", "main"]);
    await git(root, ["config", "user.email", "t@example.com"]);
    await git(root, ["config", "user.name", "t"]);
    writeFileSync(join(root, "a.txt"), "hi");
    await git(root, ["add", "a.txt"]);
    await git(root, ["commit", "-m", "init"]);

    const status = await getGitStatus(root);
    expect(status).toEqual({ branch: "main", dirtyCount: 0, ahead: 0, behind: 0, remoteUrl: null });
  });

  test("counts dirty files", async () => {
    const root = mkdtempSync(join(tmpdir(), "zero-git-dirty-"));
    await git(root, ["init", "-b", "main"]);
    await git(root, ["config", "user.email", "t@example.com"]);
    await git(root, ["config", "user.name", "t"]);
    writeFileSync(join(root, "a.txt"), "hi");
    await git(root, ["add", "a.txt"]);
    await git(root, ["commit", "-m", "init"]);
    writeFileSync(join(root, "a.txt"), "changed");
    writeFileSync(join(root, "b.txt"), "new");

    const status = await getGitStatus(root);
    expect(status?.dirtyCount).toBe(2);
  });
});
```

- [ ] **Step 2b: Run test to verify it fails**

Run: `bun test packages/daemon/src/gitInfo.test.ts`
Expected: FAIL with "Cannot find module './gitInfo'"

- [ ] **Step 3: Implement `gitInfo.ts`**

```ts
export interface GitStatus {
  branch: string;
  dirtyCount: number;
  ahead: number;
  behind: number;
  remoteUrl: string | null;
}

async function git(root: string, args: string[]): Promise<{ exitCode: number; output: string }> {
  const proc = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, output: (stdout + stderr).trim() };
}

/** Returns null if `root` isn't inside a git work tree, or git isn't installed. */
export async function getGitStatus(root: string): Promise<GitStatus | null> {
  const inTree = await git(root, ["rev-parse", "--is-inside-work-tree"]);
  if (inTree.exitCode !== 0 || inTree.output !== "true") return null;

  const branchResult = await git(root, ["branch", "--show-current"]);
  const branch = branchResult.output || "HEAD";

  const porcelain = await git(root, ["status", "--porcelain=v1", "--branch"]);
  const lines = porcelain.output.split("\n").filter(Boolean);
  const branchLine = lines[0] ?? "";
  const dirtyCount = lines.length > 0 && branchLine.startsWith("##") ? lines.length - 1 : lines.length;
  const aheadMatch = branchLine.match(/ahead (\d+)/);
  const behindMatch = branchLine.match(/behind (\d+)/);

  const remote = await git(root, ["remote", "get-url", "origin"]);
  const remoteUrl = remote.exitCode === 0 && remote.output ? remote.output : null;

  return {
    branch,
    dirtyCount,
    ahead: aheadMatch ? Number(aheadMatch[1]) : 0,
    behind: behindMatch ? Number(behindMatch[1]) : 0,
    remoteUrl,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/daemon/src/gitInfo.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Register the `git/status` RPC**

In `packages/daemon/src/main.ts`, near the other RPC registrations, add:

```ts
import { getGitStatus } from "./gitInfo";
// ...
daemon.rpc.register("git/status", z.object({}).optional().transform(() => ({})),
  async () => ({ status: await getGitStatus(opts.root) }));
```

Update the return type note: this returns `{ status: GitStatusResult | null }`.

- [ ] **Step 6: Add an end-to-end wire test in `main.test.ts`**

Follow the existing `startZero` + `RpcClient` template in `packages/daemon/src/main.test.ts` (see the pty wire test for the exact boilerplate) and add:

```ts
test("git/status returns null outside a git repo, and real data inside one", async () => {
  const root = mkdtempSync(join(tmpdir(), "zero-"));
  const d = await startZero({ root });
  const ws = await new Promise<WebSocket>((res, rej) => {
    const w = new WebSocket(`ws://127.0.0.1:${d.port}/rpc?token=${d.token}`);
    w.onopen = () => res(w); w.onerror = rej;
  });
  const client = new RpcClient(wsAdapter(ws));

  const before = await client.request<{ status: unknown }>("git/status");
  expect(before.status).toBeNull();

  ws.close();
  d.stop();
});
```

- [ ] **Step 7: Run daemon tests**

Run: `bun test packages/daemon`
Expected: PASS, no regressions.

- [ ] **Step 8: Render the git pill in `StatusBar.tsx`**

Add a `gitStatus` prop and render branch + dirty indicator + remote link:

```tsx
gitStatus?: { branch: string; dirtyCount: number; remoteUrl: string | null } | null;
```

```tsx
{props.gitStatus && (
  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
    <span>{props.gitStatus.branch}</span>
    {props.gitStatus.dirtyCount > 0 && (
      <span title={`${props.gitStatus.dirtyCount} uncommitted change(s)`}
        style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--zero-accent)" }} />
    )}
    {props.gitStatus.remoteUrl && (
      <a href={toHttpsUrl(props.gitStatus.remoteUrl)} target="_blank" rel="noreferrer"
        style={{ color: "inherit" }} title="Open repository on GitHub">GitHub</a>
    )}
  </span>
)}
```

Add a small helper in the same file to normalize `git@github.com:x/y.git` / `https://github.com/x/y.git` remote strings into an https browsable URL:

```ts
function toHttpsUrl(remote: string): string {
  const sshMatch = remote.match(/^git@([^:]+):(.+?)(\.git)?$/);
  if (sshMatch) return `https://${sshMatch[1]}/${sshMatch[2]}`;
  return remote.replace(/\.git$/, "");
}
```

- [ ] **Step 9: Poll `git/status` from `Workbench.tsx`**

Follow the exact pattern already used for `graphStatus` polling in `Workbench.tsx` (find the `graph/status` polling `useEffect` and copy its interval/cleanup shape) to add a `gitStatus` state, poll `git/status` on the same cadence, and pass it into `<StatusBar gitStatus={gitStatus} ... />`.

- [ ] **Step 10: Add a `StatusBar.test.tsx`-style unit test (or extend an existing one) for the new pill**

If `StatusBar.tsx` has no existing test file, create `packages/web/src/workbench/StatusBar.test.tsx` following the testing-library conventions used elsewhere in `packages/web` (check `Editor.layout.test.ts` for the project's preferred React test setup) asserting the branch name and remote link render when `gitStatus` is provided, and that nothing renders when it's `null`.

- [ ] **Step 11: Run web tests**

Run: `bun test packages/web`
Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add packages/daemon/src/gitInfo.ts packages/daemon/src/gitInfo.test.ts packages/daemon/src/main.ts packages/daemon/src/main.test.ts packages/protocol/src/messages.ts packages/web/src/workbench/StatusBar.tsx packages/web/src/workbench/layout/Workbench.tsx
git commit -m "feat: show git branch/dirty status and GitHub remote link in status bar"
```

---

### Task 3: PTY intermittent-load bug (debugging spike)

This task is investigative, not TDD from a known fix - it follows `superpowers:systematic-debugging`, not the write-test-first flow. Do this task **before** Task 4 (terminal/chat tabbing) so any terminal restructuring in later tasks sits on a fixed foundation. If the earlier subagent conversation history did not reproduce the bug directly, the implementer must first reproduce it, then fix it - this task cannot be completed by guessing.

**Files:**
- Modify: `packages/daemon/src/pty.ts` (fix location TBD by findings)
- Modify: `packages/daemon/src/pty-worker.js` (fix location TBD by findings)
- Modify/create: `packages/daemon/src/pty.test.ts` (regression test for whatever is found)

**Interfaces:**
- Consumes: `PtyService` (`packages/daemon/src/pty.ts`) - constructor `(cwd, onOutput, onExit)`, methods `open`, `input`, `resize`, `close`, `list`, `workerPid`, `closeAll`.
- Produces: same public API, unchanged signatures - this task fixes an internal race/timing bug, it does not change `PtyService`'s interface.

- [ ] **Step 1: Reproduce**

Launch the app repeatedly via `bun run --cwd packages/daemon bin/zero.ts serve <some-path>` (and separately via the TUI path, `bun run --cwd packages/daemon bin/zero.ts <some-path>`) and open a terminal panel each time, in a loop (10-20 iterations), watching for the panel that "doesn't load" - i.e. a `pty/open` that either never resolves, resolves but no `pty/output` events ever arrive, or the worker silently never starts. Capture: does it correlate with rapid app reloads, cold start right after `bun install`, or a specific OS `node` binary resolution issue (e.g. `spawn("node", ...)` in `pty.ts` finding a stale/wrong `node` on `PATH`, or a `nvm`-shim `node` that's slow to hand off `exec`)? Add temporary `console.error` timestamps around `this.#worker = spawn("node", [workerPath])`, the `worker.on("error"/"exit")` handlers, and the first `readline` `"line"` event, to pin down whether the failure is: (a) spawn failing silently, (b) the worker starting but `pty/open`'s underlying `node-pty` call inside the worker throwing before it ever writes a line, or (c) a genuine race where `open()` is called before the worker's `readline` interface has attached its `"line"` listener.

**Note for the implementer:** a baseline `bun test` run in this worktree (before this task started) already reproduces PTY test failures/timeouts directly: `open spawns a shell, input/output round-trips, close kills it`, `two concurrent sessions keep independent output streams (second terminal tab)`, `pty methods over the wire: open, input/output, resize, close`, and `onExit fires for a natural process exit and the session drops from list()` all failed or timed out in `packages/daemon/src/pty.test.ts` and `packages/daemon/src/main.test.ts`. Start by re-running exactly those tests (`bun test packages/daemon/src/pty.test.ts packages/daemon/src/main.test.ts`) to get a fast, reliable repro loop before reaching for the manual `bin/zero.ts serve` loop above.

- [ ] **Step 2: Identify root cause**

Narrow to one of the hypotheses in Step 1 (or a new one found via the logs) with a reliable repro. Write down the exact trigger condition before touching code.

- [ ] **Step 3: Write a regression test that fails under the bug's conditions**

The exact test depends on Step 2's finding. If it's a startup race (most likely candidate given the architecture: `#worker = spawn(...)` and any `open()` call immediately after have no synchronization point today), the test should look like:

```ts
test("pty/open works even when called immediately after PtyService construction (no warmup delay)", async () => {
  const output: string[] = [];
  const service = new PtyService(process.cwd(), (id, data) => output.push(data), () => {});
  // No delay here - this is the point: today `open()` is called
  // synchronously right after construction, before the worker's readline
  // listener is guaranteed attached.
  const session = await service.open(undefined, 80, 24);
  service.input(session.sessionId, "echo ready\n");
  await new Promise<void>((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(() => {
      if (output.join("").includes("ready")) { clearInterval(iv); resolve(); }
      if (Date.now() - start > 10000) { clearInterval(iv); reject(new Error("timed out waiting for pty output")); }
    }, 50);
  });
  service.close(session.sessionId);
});
```

Adjust this test to match whatever Step 2 actually found (e.g. if it's a `node` PATH resolution issue, the test would instead assert `PtyService` degrades to `#dead = true` gracefully rather than hanging forever, and that a health-check/retry path recovers it).

- [ ] **Step 4: Run the test to verify it fails (or flakes) under current code**

Run: `bun test packages/daemon/src/pty.test.ts --rerun-each 10`
Expected: intermittent FAIL, matching the reported bug's flakiness.

- [ ] **Step 5: Implement the fix**

Depends on findings. Most likely fix shape if it's the startup race from Step 1(c): buffer/queue `open()`/`input()` calls made before the worker's `readline` interface is ready, flushing them once a `"ready"` signal (add one) comes back from `pty-worker.js`'s own startup, e.g. worker sends `{"event":"ready"}` as its first line once its `readline` on `process.stdin` is attached, and `PtyService` queues outbound `#send()` calls until that arrives instead of assuming the worker is immediately live.

- [ ] **Step 6: Run the test 20x to confirm the fix holds**

Run: `bun test packages/daemon/src/pty.test.ts --rerun-each 20`
Expected: PASS consistently, 0 flakes.

- [ ] **Step 7: Run full daemon suite**

Run: `bun test packages/daemon`
Expected: PASS, no regressions (in particular the existing worker-crash-recovery test in `pty.test.ts` must still pass).

- [ ] **Step 8: Commit**

```bash
git add packages/daemon/src/pty.ts packages/daemon/src/pty-worker.js packages/daemon/src/pty.test.ts
git commit -m "fix(daemon): eliminate PTY worker startup race causing terminal to sometimes never load"
```

---

### Task 4: Tab Terminal and Chat panels together

**Files:**
- Modify: `packages/web/src/workbench/layout/Workbench.tsx`
- Modify: `packages/web/src/workbench/layout/workbench.css`

**Interfaces:**
- Consumes: existing `TerminalPanel`, `ChatPanel` components (props unchanged).
- Produces: a single `BOTTOM_PANEL_ID` dockview panel replacing the separate `TERMINAL_PANEL_ID`/`CHAT_PANEL_ID` panels; new workbench context state `bottomView: "terminal" | "chat"` and `setBottomView`.

This follows the exact pattern `SidebarPanel` already uses to tab Files/Search together (a single dockview panel that locally toggles between two child components), rather than dockview's native multi-tab grouping, since the app doesn't use dockview's own tab chrome anywhere else (it's CSS-hidden).

- [ ] **Step 1: Add `bottomView` state to the workbench context**

In `Workbench.tsx`, alongside the existing `sidebarView`/`setSidebarView` state, add:

```tsx
const [bottomView, setBottomView] = useState<"terminal" | "chat">("terminal");
```

and add `bottomView, setBottomView` to `WorkbenchContextValue` and its provider value.

- [ ] **Step 2: Replace the two bottom panel components with one**

Replace:

```tsx
function BottomTerminalPanel() { ... }
function BottomChatPanel() { ... }
```

with:

```tsx
function BottomPanel() {
  const w = useWorkbench();
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--zero-editor-bg)", color: "var(--zero-editor-fg)" }}>
      <div className="zero-sidebar-toggle">
        <button aria-pressed={w.bottomView === "terminal"} onClick={() => w.setBottomView("terminal")}>Terminal</button>
        <button aria-pressed={w.bottomView === "chat"} onClick={() => w.setBottomView("chat")}>Chat</button>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {w.bottomView === "terminal" ? (
          <TerminalPanel client={w.client} ptyStore={w.ptyStore} theme={w.theme} />
        ) : (
          <ChatPanel client={w.client} turnStore={w.turnStore} chatStore={w.chatStore} />
        )}
      </div>
    </div>
  );
}
```

Update `DOCKVIEW_COMPONENTS` to `{ sidebar: SidebarPanel, editor: EditorPanel, bottom: BottomPanel }` (drop `terminal`/`chat` entries).

- [ ] **Step 3: Collapse the panel-management actions**

Replace `showTerminalPanel`/`toggleTerminal`/`showChatPanel`/`toggleChat` with:

```tsx
const BOTTOM_PANEL_ID = "bottom";
// ...
showBottomPanel: (view: "terminal" | "chat") => {
  const api = dockApi.current;
  setBottomView(view);
  if (!api) return;
  if (api.getPanel(BOTTOM_PANEL_ID)) return;
  api.addPanel({
    id: BOTTOM_PANEL_ID, component: "bottom", params: {},
    position: { direction: "below" },
    initialHeight: 320,
  });
},
toggleBottomPanel: (view: "terminal" | "chat") => {
  const api = dockApi.current;
  if (!api) return;
  const panel = api.getPanel(BOTTOM_PANEL_ID);
  if (panel && bottomView === view) { api.removePanel(panel); return; }
  actionsRef.current.showBottomPanel(view);
},
newTerminal: () => {
  actionsRef.current.showBottomPanel("terminal");
  void client.request<{ sessionId: string; shell: string }>("pty/open", { cols: 80, rows: 24 })
    .then((s) => ptyStore.addSession(s))
    .catch((e: unknown) => reportRef.current(`Could not open terminal: ${errorText(e)}`));
},
```

- [ ] **Step 4: Update the command bindings**

Replace the `view.toggleTerminal` / `view.toggleChat` command entries:

```tsx
{ id: "view.toggleTerminal", title: "Toggle Terminal", run: () => actionsRef.current.toggleBottomPanel("terminal"), keybinding: "Control+Backquote" },
{ id: "terminal.new", title: "New Terminal", run: () => actionsRef.current.newTerminal() },
{ id: "view.toggleChat", title: "Toggle Chat", run: () => actionsRef.current.toggleBottomPanel("chat"), keybinding: "Control+Shift+KeyC" },
```

- [ ] **Step 5: Update any other call sites referencing `TERMINAL_PANEL_ID`/`CHAT_PANEL_ID`**

Search: `grep -rn "TERMINAL_PANEL_ID\|CHAT_PANEL_ID\|showTerminalPanel\|showChatPanel\|toggleTerminal\|toggleChat" packages/web/src` and update every remaining reference (e.g. session restore-on-load logic that currently calls `showChatPanel`/`showTerminalPanel` directly) to go through `showBottomPanel(view)`.

- [ ] **Step 6: Update/extend Workbench layout tests**

Open `packages/web/src/Editor.layout.test.ts` (or whichever test currently exercises panel add/remove - grep for `TERMINAL_PANEL_ID` in test files) and update assertions to check for the single `bottom` panel id and that clicking the Terminal/Chat toggle buttons swaps rendered content, following the existing test's setup/teardown style.

- [ ] **Step 7: Run web tests**

Run: `bun test packages/web`
Expected: PASS.

- [ ] **Step 8: Manual check**

Run the dev server, open Terminal, open Chat - confirm they now share one panel with a Terminal/Chat toggle (same visual pattern as the Files/Search sidebar toggle), and that toggling doesn't destroy terminal session state (xterm buffer) when switching away and back - if it does, that's expected today (the SidebarPanel pattern also fully unmounts the non-active view) and out of scope to fix here; note it as a follow-up if it feels wrong in practice, but don't silently add state-preservation logic not covered by this plan.

- [ ] **Step 9: Commit**

```bash
git add packages/web/src/workbench/layout/Workbench.tsx packages/web/src/workbench/layout/workbench.css packages/web/src/Editor.layout.test.ts
git commit -m "feat(web): tab Terminal and Chat panels together instead of stacking them"
```

---

### Task 5: Live theme switching for the terminal

**Files:**
- Modify: `packages/web/src/workbench/terminal/TerminalHost.tsx`

**Interfaces:**
- Consumes: `terminalTheme(theme: "light" | "dark"): ITheme` (`terminal/theme.ts`, unchanged signature).
- Produces: no interface change - `TerminalHost` already takes `theme` as a prop; this task makes it *reactive* instead of mount-only.

- [ ] **Step 1: Write a failing test**

Create/extend `packages/web/src/workbench/terminal/TerminalHost.test.ts` (check if one exists first; if not, create it following `theme.test.ts`'s setup style):

```ts
import { describe, expect, test } from "bun:test";
import { terminalTheme } from "./theme";

describe("terminal theme reactivity", () => {
  test("terminalTheme produces different background colors for light vs dark", () => {
    const light = terminalTheme("light");
    const dark = terminalTheme("dark");
    expect(light.background).not.toBe(dark.background);
  });
});
```

(This confirms the pure theme function's contract; the reactive-update behavior itself - that `TerminalHost` calls `term.options.theme = terminalTheme(theme)` on prop change rather than only at mount - is asserted via the DOM-level test in Step 3 below, since it depends on `@xterm/xterm`'s live `Terminal` instance.)

- [ ] **Step 2: Run it to confirm current pass/fail baseline**

Run: `bun test packages/web/src/workbench/terminal`
Expected: PASS (this specific assertion already holds - `terminalTheme` is already pure and theme-aware; it's `TerminalHost` that doesn't re-apply it).

- [ ] **Step 3: Find the mount effect in `TerminalHost.tsx` and make it theme-reactive**

Locate the `useEffect` that constructs `new Terminal({ theme: terminalTheme(props.theme), ... })` (mount-only, per the research: currently only reads `theme` once). Add a second effect:

```tsx
useEffect(() => {
  if (!termRef.current) return;
  termRef.current.options.theme = terminalTheme(props.theme);
}, [props.theme]);
```

Do not put this inside the mount effect's dependency array (that would tear down and recreate the whole `Terminal`/PTY attachment on every theme flip, killing the running shell) - it must be a separate, narrow effect.

- [ ] **Step 4: Manual verification**

Run the dev server, open a terminal, run a command producing colored output (e.g. `ls --color`), then toggle the app theme via the status bar theme button - confirm the terminal's background/foreground restyle immediately without the shell session resetting (scrollback and running process must survive the toggle).

- [ ] **Step 5: Run web tests**

Run: `bun test packages/web`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/workbench/terminal/TerminalHost.tsx packages/web/src/workbench/terminal/TerminalHost.test.ts
git commit -m "fix(web): restyle live terminal instances when the app theme changes"
```

---

### Task 6: Chat panel theming pass

**Files:**
- Modify: `packages/web/src/workbench/chat/ChatPanel.tsx`

**Interfaces:** None - purely a styling pass, no prop/type changes.

- [ ] **Step 1: Inventory hardcoded colors**

Run: `grep -n "background:\|color:\|border:" packages/web/src/workbench/chat/ChatPanel.tsx` and list every inline style that uses a literal color (hex/rgb/named) instead of a `var(--zero-*)` token - per the research, the message list currently has no per-role background at all (just a bold label), and the model-status pill's dot uses literal `#2ecc71`/`#999`.

- [ ] **Step 2: Replace literals with tokens, adding new tokens where the palette doesn't have an equivalent**

For colors that map directly, swap in the existing token (e.g. borders → `var(--zero-border)`, panel background → `var(--zero-editor-bg)`/`var(--zero-sidebar-bg)` as appropriate for the element). For the status-dot green/gray (no existing equivalent), add two new custom properties to `theme.css` under both `:root[data-theme="dark"]` and `:root[data-theme="light"]`:

```css
--zero-status-ok: #2ecc71;
--zero-status-idle: #8a8a8a;
```

and reference them as `var(--zero-status-ok)` / `var(--zero-status-idle)` in `ChatPanel.tsx` in place of the literals.

- [ ] **Step 3: Give each message role a distinct, theme-aware background**

Replace the current bare label+text rendering with a lightly-styled row per message:

```tsx
{messages.filter((m) => m.role !== "system").map((m, i) => (
  <div key={i} style={{
    marginBottom: 8, padding: "6px 10px", borderRadius: 6,
    background: m.role === "user" ? "var(--zero-selection-bg)" : "var(--zero-editor-bg)",
    border: "1px solid var(--zero-border)",
  }}>
    <strong style={{ color: "var(--zero-statusbar-fg)" }}>{m.role === "tool" ? `tool:${m.toolName}` : m.role}</strong>
    <div style={{ whiteSpace: "pre-wrap", color: "var(--zero-editor-fg)" }}>{m.content}</div>
  </div>
))}
```

- [ ] **Step 4: Manual verification in both themes**

Run the dev server, open Chat, send a message (or view an existing session with history), toggle the theme - confirm every element (tab strip, model pill, message rows, input, approval bar) tracks the theme with no leftover hardcoded colors.

- [ ] **Step 5: Run web tests**

Run: `bun test packages/web`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/workbench/chat/ChatPanel.tsx packages/web/src/workbench/theme/theme.css
git commit -m "fix(web): make chat panel follow the app theme instead of hardcoded colors"
```

---

### Task 7: Chat "agent is responding" indicator

**Files:**
- Modify: `packages/web/src/workbench/chat/turnStore.ts`
- Modify: `packages/web/src/workbench/chat/ChatPanel.tsx`
- Test: `packages/web/src/workbench/chat/turnStore.test.ts`

**Interfaces:**
- Produces: `TurnStore.isActive(turnId: string): boolean` - derived from whether a `"done"`/`"error"` event has been seen since the turn started.

- [ ] **Step 1: Write the failing test**

Check whether `packages/web/src/workbench/chat/turnStore.test.ts` already exists (research didn't confirm); if so extend it, otherwise create it:

```ts
import { describe, expect, test } from "bun:test";
import { TurnStore } from "./turnStore";

describe("TurnStore.isActive", () => {
  test("is false before any event, true after a text delta, false after done", () => {
    const store = new TurnStore();
    expect(store.isActive("t1")).toBe(false);
    store.handleEvent("t1", { type: "text", delta: "hi" });
    expect(store.isActive("t1")).toBe(true);
    store.handleEvent("t1", { type: "done", message: { role: "assistant", content: "hi", createdAt: 0 } });
    expect(store.isActive("t1")).toBe(false);
  });

  test("is false after an error event", () => {
    const store = new TurnStore();
    store.handleEvent("t2", { type: "text", delta: "hi" });
    store.handleEvent("t2", { type: "error", message: "boom" });
    expect(store.isActive("t2")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/web/src/workbench/chat/turnStore.test.ts`
Expected: FAIL - `isActive` not defined.

- [ ] **Step 3: Implement `isActive` on `TurnStore`**

Add a `#activeTurns = new Set<string>()` alongside the existing listener map; in `handleEvent`, add the `turnId` to the set on any non-terminal event, delete it on `"done"`/`"error"`. Add:

```ts
isActive(turnId: string): boolean {
  return this.#activeTurns.has(turnId);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/web/src/workbench/chat/turnStore.test.ts`
Expected: PASS.

- [ ] **Step 5: Render the indicator in `ChatPanel.tsx`**

Wherever `ChatPanel` currently tracks the in-flight `turnId` (it must, to wire Stop/abort - locate that state), add:

```tsx
{turnId && turnStore.isActive(turnId) && (
  <div role="status" style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--zero-statusbar-fg)", opacity: 0.8, padding: "4px 10px" }}>
    <span className="zero-typing-dot" />
    <span className="zero-typing-dot" />
    <span className="zero-typing-dot" />
    <span>Zero is thinking…</span>
  </div>
)}
```

Add a small CSS keyframe animation for `.zero-typing-dot` (staggered opacity pulse) to `packages/web/src/workbench/layout/workbench.css` or a chat-scoped stylesheet if one exists.

- [ ] **Step 6: Manual verification**

Send a chat message, confirm the indicator appears while the response streams and disappears once the turn completes or errors.

- [ ] **Step 7: Run web tests**

Run: `bun test packages/web`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/web/src/workbench/chat/turnStore.ts packages/web/src/workbench/chat/turnStore.test.ts packages/web/src/workbench/chat/ChatPanel.tsx packages/web/src/workbench/layout/workbench.css
git commit -m "feat(web): show a typing indicator while the chat agent is responding"
```

---

### Task 8: Chat session switcher as a dropdown

**Files:**
- Modify: `packages/web/src/workbench/chat/ChatPanel.tsx`

**Interfaces:**
- Consumes: `ChatStore.getSessions(): ChatSessionSummary[]`, `getActiveId(): string | null`, `setActive(id: string): void` (all pre-existing, unchanged).

- [ ] **Step 1: Locate the current tab-strip JSX in `ChatPanel.tsx`**

Find the inline `className="zero-tabstrip"` block rendering one `.zero-tab` per session (per research, this duplicates `TabStrip`'s markup rather than importing it).

- [ ] **Step 2: Replace it with a `<select>`-based switcher**

```tsx
<div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderBottom: "1px solid var(--zero-border)" }}>
  <select
    aria-label="Chat session"
    value={chatStore.getActiveId() ?? ""}
    onChange={(e) => chatStore.setActive(e.target.value)}
    style={{
      background: "var(--zero-sidebar-bg)", color: "var(--zero-sidebar-fg)",
      border: "1px solid var(--zero-border)", borderRadius: 4, padding: "4px 8px",
    }}
  >
    {sessions.map((s) => (
      <option key={s.id} value={s.id}>{s.title ?? s.id}</option>
    ))}
  </select>
  <button onClick={() => actions.newSession()} title="New chat session">+</button>
</div>
```

(`sessions` and any "new session" action must reuse whatever local variable/handler the old tab strip already used - do not invent a new `newSession` action name if one already exists under a different name; grep the file first.)

- [ ] **Step 3: Remove the now-dead tab-strip JSX and any now-unused per-tab close/rename handlers that don't apply to a dropdown**

If per-session close/delete existed as a small "x" on each tab, keep that capability but move it to a "Delete session" button next to the dropdown (only enabled when more than one session exists), rather than dropping the capability silently.

- [ ] **Step 4: Manual verification**

Create two chat sessions, confirm the dropdown lists both, switching the selection swaps the visible message history, and the "+"/delete controls still work.

- [ ] **Step 5: Run web tests**

Run: `bun test packages/web`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/workbench/chat/ChatPanel.tsx
git commit -m "feat(web): switch chat sessions via a dropdown instead of a tab strip"
```

---

### Task 9: Chat message avatars and timestamps

**Files:**
- Modify: `packages/web/src/workbench/chat/ChatPanel.tsx`
- Modify: `packages/core/src/chatTypes.ts` (only if `ChatMessage.createdAt` is not already present - verify first)

**Interfaces:**
- Consumes: `ChatMessage.createdAt: number` (per the research excerpt in Task 3's regression test, `createdAt` already exists on `ChatMessage` - e.g. `{ role: "user", content: userText, createdAt: Date.now() }` in `agentRuntime.ts`). Verify it's present on every role, not just synthesized user messages, before writing this task's code.

- [ ] **Step 1: Confirm `createdAt` coverage**

Run: `grep -n "createdAt" packages/core/src/chatTypes.ts packages/core/src/agentRuntime.ts` - confirm the field is on the `ChatMessage` type itself (not just set ad hoc on one construction site). If it's missing from the type or not set on assistant/tool messages, add it there first (required field, backfilled at every construction site in `agentRuntime.ts`) before touching `ChatPanel.tsx`.

- [ ] **Step 2: Add an avatar + timestamp to each message row**

Extend the message row from Task 6 with a small header line:

```tsx
<div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
  <span aria-hidden style={{
    width: 18, height: 18, borderRadius: "50%", display: "inline-flex",
    alignItems: "center", justifyContent: "center", fontSize: 11,
    background: m.role === "user" ? "var(--zero-accent)" : "var(--zero-status-ok)",
    color: "#fff",
  }}>
    {m.role === "user" ? "U" : m.role === "tool" ? "T" : "Z"}
  </span>
  <strong>{m.role === "tool" ? `tool:${m.toolName}` : m.role}</strong>
  <span style={{ marginLeft: "auto", fontSize: 11, opacity: 0.6 }}>
    {new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
  </span>
</div>
```

- [ ] **Step 3: Handle historical messages predating `createdAt`**

If any stored session could have messages without `createdAt` (pre-existing data), guard the render: `m.createdAt ? new Date(m.createdAt).toLocaleTimeString(...) : null`.

- [ ] **Step 4: Manual verification**

View a chat session with multiple message roles, confirm avatars and timestamps render correctly for user/assistant/tool messages.

- [ ] **Step 5: Run web tests**

Run: `bun test packages/web`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/workbench/chat/ChatPanel.tsx
git commit -m "feat(web): add avatars and timestamps to chat messages"
```

---

### Task 10: Chat scroll-to-bottom button

**Files:**
- Modify: `packages/web/src/workbench/chat/ChatPanel.tsx`

**Interfaces:** None - local component state only.

- [ ] **Step 1: Locate the scrollable message-list container**

Find the `<div>` wrapping the message `.map(...)` from Task 6/9 - it needs a `ref` and an `onScroll` handler.

- [ ] **Step 2: Track scroll position and new-message arrival**

```tsx
const listRef = useRef<HTMLDivElement>(null);
const [pinnedToBottom, setPinnedToBottom] = useState(true);

const handleScroll = () => {
  const el = listRef.current;
  if (!el) return;
  const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
  setPinnedToBottom(distanceFromBottom < 40);
};

useEffect(() => {
  if (pinnedToBottom) listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
}, [messages.length, pinnedToBottom]);
```

- [ ] **Step 3: Wire the ref/handler onto the list container and render the button**

```tsx
<div ref={listRef} onScroll={handleScroll} style={{ flex: 1, overflowY: "auto", position: "relative", padding: 10 }}>
  {/* ...existing message map... */}
</div>
{!pinnedToBottom && (
  <button
    onClick={() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" }); setPinnedToBottom(true); }}
    style={{
      position: "absolute", bottom: 60, right: 20, borderRadius: 16, padding: "6px 12px",
      background: "var(--zero-accent)", color: "#fff", border: "none", cursor: "pointer",
    }}
  >
    ↓ New messages
  </button>
)}
```

(Wrap the list + button in a `position: relative` parent if the panel's outer container isn't already positioned.)

- [ ] **Step 4: Manual verification**

Open a chat session with enough history to scroll, scroll up, confirm the button appears; send/receive a new message while scrolled up, confirm the button stays visible (doesn't auto-scroll); click it, confirm it smooth-scrolls to bottom and hides itself.

- [ ] **Step 5: Run web tests**

Run: `bun test packages/web`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/workbench/chat/ChatPanel.tsx
git commit -m "feat(web): add scroll-to-bottom button to chat panel"
```

---

### Task 11: File CRUD - protocol types and daemon RPCs

**Files:**
- Modify: `packages/protocol/src/messages.ts`
- Modify: `packages/daemon/src/workspace.ts`
- Modify: `packages/daemon/src/workspace.test.ts`
- Modify: `packages/daemon/src/main.ts`
- Modify: `packages/daemon/src/main.test.ts`

**Interfaces:**
- Produces: `Workspace.create(rel, kind)`, `Workspace.rename(rel, newRel)`, `Workspace.delete(rel)`, `Workspace.move(rel, newRel)`, `Workspace.copy(rel, newRel)`; RPCs `fs/create`, `fs/rename`, `fs/delete`, `fs/move`, `fs/copy`.

- [ ] **Step 1: Add protocol types**

In `packages/protocol/src/messages.ts`:

```ts
export interface FsCreateParams { path: string; kind: "file" | "dir" }
export interface FsRenameParams { path: string; newPath: string }
export interface FsDeleteParams { path: string }
export interface FsMoveParams { path: string; newPath: string }
export interface FsCopyParams { path: string; newPath: string }
```

- [ ] **Step 2: Write failing `Workspace` tests**

Add to `packages/daemon/src/workspace.test.ts`, following that file's existing setup (a temp dir `Workspace` instance per test):

```ts
test("create makes a file, and a directory", async () => {
  await ws.create("a.txt", "file");
  expect(await ws.read("a.txt")).toBe("");
  await ws.create("sub", "dir");
  expect((await ws.tree()).some((e) => e.path === "sub" && e.kind === "dir")).toBe(true);
});

test("create rejects a path outside the workspace root", async () => {
  await expect(ws.create("../escape.txt", "file")).rejects.toThrow(PathOutsideWorkspaceError);
});

test("rename moves a file to a new relative path", async () => {
  await ws.write("a.txt", "hi");
  await ws.rename("a.txt", "b.txt");
  expect(await ws.read("b.txt")).toBe("hi");
  await expect(ws.read("a.txt")).rejects.toThrow();
});

test("delete removes a file", async () => {
  await ws.write("a.txt", "hi");
  await ws.delete("a.txt");
  await expect(ws.read("a.txt")).rejects.toThrow();
});

test("delete removes a directory recursively", async () => {
  await ws.write("dir/a.txt", "hi");
  await ws.delete("dir");
  expect((await ws.tree()).some((e) => e.path.startsWith("dir"))).toBe(false);
});

test("move relocates a file into another directory", async () => {
  await ws.write("a.txt", "hi");
  await ws.create("dest", "dir");
  await ws.move("a.txt", "dest/a.txt");
  expect(await ws.read("dest/a.txt")).toBe("hi");
});

test("copy duplicates a file, leaving the original in place", async () => {
  await ws.write("a.txt", "hi");
  await ws.copy("a.txt", "b.txt");
  expect(await ws.read("a.txt")).toBe("hi");
  expect(await ws.read("b.txt")).toBe("hi");
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test packages/daemon/src/workspace.test.ts`
Expected: FAIL - methods don't exist.

- [ ] **Step 4: Implement the five `Workspace` methods**

In `packages/daemon/src/workspace.ts`, following the exact `#resolve`/`#resolveReal` guard convention already used by `read`/`write`:

```ts
async create(rel: string, kind: "file" | "dir"): Promise<void> {
  const abs = this.#resolve(rel);
  if (kind === "dir") {
    await fs.mkdir(await this.#resolveReal(rel).catch(() => abs), { recursive: true });
  } else {
    await fs.mkdir(dirname(abs), { recursive: true });
    await fs.writeFile(abs, "", { flag: "wx" });
  }
}

async rename(rel: string, newRel: string): Promise<void> {
  const from = await this.#resolveReal(rel);
  const to = this.#resolve(newRel);
  await fs.mkdir(dirname(to), { recursive: true });
  await fs.rename(from, to);
}

async delete(rel: string): Promise<void> {
  const abs = await this.#resolveReal(rel);
  await fs.rm(abs, { recursive: true, force: false });
}

async move(rel: string, newRel: string): Promise<void> {
  return this.rename(rel, newRel);
}

async copy(rel: string, newRel: string): Promise<void> {
  const from = await this.#resolveReal(rel);
  const to = this.#resolve(newRel);
  await fs.mkdir(dirname(to), { recursive: true });
  await fs.cp(from, to, { recursive: true, errorOnExist: true });
}
```

(`move`/`rename` are the same operation here - kept as two methods only because the RPC layer exposes both `fs/rename` (same-directory rename UX) and `fs/move` (drag-to-folder UX) as distinct client-facing actions per the spec; both are wired below without runtime overlap. `create`'s directory branch resolves against a not-yet-existing path, so it deliberately doesn't use `#resolveReal` before the directory exists - `#resolve`'s lexical check is sufficient there since `mkdir -p` cannot itself escape the root once the lexical check passes.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test packages/daemon/src/workspace.test.ts`
Expected: PASS.

- [ ] **Step 6: Register the five RPCs in `main.ts`**

```ts
daemon.rpc.register("fs/create", z.object({ path: z.string(), kind: z.enum(["file", "dir"]) }),
  async (p) => { await ws.create(p.path, p.kind); return {}; });
daemon.rpc.register("fs/rename", z.object({ path: z.string(), newPath: z.string() }),
  async (p) => { await ws.rename(p.path, p.newPath); return {}; });
daemon.rpc.register("fs/delete", z.object({ path: z.string() }),
  async (p) => { await ws.delete(p.path); return {}; });
daemon.rpc.register("fs/move", z.object({ path: z.string(), newPath: z.string() }),
  async (p) => { await ws.move(p.path, p.newPath); return {}; });
daemon.rpc.register("fs/copy", z.object({ path: z.string(), newPath: z.string() }),
  async (p) => { await ws.copy(p.path, p.newPath); return {}; });
```

- [ ] **Step 7: Add an end-to-end wire test in `main.test.ts`**

Follow the existing `fs/read`/`fs/write` wire-test template in that file (if none exists for `fs/*`, use the pty wire test's `startZero`+`RpcClient` boilerplate as the template instead) to add one test exercising `fs/create` → `fs/rename` → `fs/delete` end to end over the real WebSocket RPC.

- [ ] **Step 8: Run full daemon suite**

Run: `bun test packages/daemon`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/protocol/src/messages.ts packages/daemon/src/workspace.ts packages/daemon/src/workspace.test.ts packages/daemon/src/main.ts packages/daemon/src/main.test.ts
git commit -m "feat(daemon): add fs create/rename/delete/move/copy RPCs"
```

---

### Task 12: File CRUD - context menu and keybindings

**Files:**
- Modify: `packages/web/src/workbench/filetree/FileTreePanel.tsx`
- Modify: `packages/web/src/workbench/layout/Workbench.tsx`

**Interfaces:**
- Consumes: `fs/create`, `fs/rename`, `fs/delete`, `fs/move`, `fs/copy` RPCs from Task 11; `CommandRegistry.register(command)` (existing).
- Produces: `FileTreePanel` gains `onCreate`, `onRename`, `onDelete`, `onMove`, `onCopy` callback props wired by `Workbench.tsx` (keeps `FileTreePanel` itself RPC-agnostic, consistent with its current `{ client, ... }`-only prop style - actually per research `FileTreePanel` already receives `client` directly and calls RPCs itself for its existing operations, so follow *that* precedent instead: have `FileTreePanel` call `props.client.request(...)` directly for the new fs RPCs, then call `props.onOpen`/a new `props.onTreeChanged` to trigger the tree refresh Workbench already does via `refreshToken`).

- [ ] **Step 1: Add a context menu to tree nodes**

In the `Row`/node renderer in `FileTreePanel.tsx`, add an `onContextMenu` handler that opens a small menu (a local `useState<{ x: number; y: number; node: Node } | null>`) with options: New File, New Folder (only for dir nodes or the root), Rename, Delete, Cut, Copy, Paste (Paste only enabled when something's been cut/copied).

```tsx
const [menu, setMenu] = useState<{ x: number; y: number; node: NodeApi<Node> } | null>(null);
const [clipboard, setClipboard] = useState<{ path: string; mode: "cut" | "copy" } | null>(null);
```

- [ ] **Step 2: Implement each action calling the Task 11 RPCs directly**

```tsx
async function handleCreate(kind: "file" | "dir", parentDir: string) {
  const name = window.prompt(kind === "file" ? "New file name" : "New folder name");
  if (!name) return;
  const path = parentDir ? `${parentDir}/${name}` : name;
  await props.client.request("fs/create", { path, kind });
  props.onTreeChanged();
}

async function handleRename(oldPath: string) {
  const name = window.prompt("Rename to", oldPath.split("/").at(-1));
  if (!name) return;
  const newPath = [...oldPath.split("/").slice(0, -1), name].join("/");
  await props.client.request("fs/rename", { path: oldPath, newPath });
  props.onTreeChanged();
}

async function handleDelete(path: string) {
  if (!window.confirm(`Delete ${path}? This cannot be undone.`)) return;
  await props.client.request("fs/delete", { path });
  props.onTreeChanged();
}

async function handlePaste(targetDir: string) {
  if (!clipboard) return;
  const name = clipboard.path.split("/").at(-1);
  const newPath = targetDir ? `${targetDir}/${name}` : name!;
  await props.client.request(clipboard.mode === "cut" ? "fs/move" : "fs/copy", { path: clipboard.path, newPath });
  setClipboard(null);
  props.onTreeChanged();
}
```

- [ ] **Step 3: Add `onTreeChanged` prop and wire it in `Workbench.tsx`**

`FileTreePanel` already takes `refreshToken` to know when to re-fetch the tree (per research); add a new required prop `onTreeChanged: () => void` and have `Workbench.tsx` pass whatever function it already uses to bump `treeRefreshToken` after other fs mutations (grep for where `treeRefreshToken` is incremented today, e.g. after a file watcher event, and reuse that same setter).

- [ ] **Step 4: Render the context menu**

```tsx
{menu && (
  <div style={{
    position: "fixed", left: menu.x, top: menu.y, zIndex: 1000,
    background: "var(--zero-sidebar-bg)", border: "1px solid var(--zero-border)",
    borderRadius: 4, padding: 4, minWidth: 140,
  }} onMouseLeave={() => setMenu(null)}>
    {menu.node.data.kind === "dir" && <MenuItem onClick={() => { handleCreate("file", menu.node.data.id); setMenu(null); }}>New File</MenuItem>}
    {menu.node.data.kind === "dir" && <MenuItem onClick={() => { handleCreate("dir", menu.node.data.id); setMenu(null); }}>New Folder</MenuItem>}
    <MenuItem onClick={() => { handleRename(menu.node.data.id); setMenu(null); }}>Rename</MenuItem>
    <MenuItem onClick={() => { handleDelete(menu.node.data.id); setMenu(null); }}>Delete</MenuItem>
    <MenuItem onClick={() => { setClipboard({ path: menu.node.data.id, mode: "cut" }); setMenu(null); }}>Cut</MenuItem>
    <MenuItem onClick={() => { setClipboard({ path: menu.node.data.id, mode: "copy" }); setMenu(null); }}>Copy</MenuItem>
    {clipboard && menu.node.data.kind === "dir" && <MenuItem onClick={() => { handlePaste(menu.node.data.id); setMenu(null); }}>Paste</MenuItem>}
  </div>
)}
```

with a tiny local `MenuItem` helper (`<div role="menuitem" style={{ padding: "4px 10px", cursor: "pointer" }} onClick={...}>{children}</div>`).

- [ ] **Step 5: Register keybindings in `Workbench.tsx`**

Add to the existing commands array (scoped to when the file tree is focused - reuse whatever focus-tracking the sidebar already has, e.g. only act if `sidebarView === "files"`):

```tsx
{ id: "files.newFile", title: "New File", run: () => actionsRef.current.newFileInSelectedDir(), keybinding: "$mod+Alt+KeyN" },
{ id: "files.newFolder", title: "New Folder", run: () => actionsRef.current.newFolderInSelectedDir(), keybinding: "$mod+Alt+Shift+KeyN" },
{ id: "files.rename", title: "Rename", run: () => actionsRef.current.renameSelected(), keybinding: "F2" },
{ id: "files.delete", title: "Delete", run: () => actionsRef.current.deleteSelected(), keybinding: "$mod+Backspace" },
```

Each `actionsRef.current.*` implementation delegates to the currently-selected tree node (track "selected path" the same way `activePath`/`onOpen` already tracks the open file - if `FileTreePanel` doesn't currently expose "selected but not opened" state to the parent, add a minimal `onSelect: (path: string | null) => void` prop mirroring the existing `onOpen` prop, and store it in `Workbench.tsx` as `selectedTreePath`).

- [ ] **Step 6: Write a `FileTreePanel` test for the new context-menu actions**

Check `packages/web/src/workbench/filetree/` for an existing `FileTreePanel.test.tsx`; if present, extend it, otherwise create one following `FileOpener.test.ts`'s RPC-mocking style (a fake `client.request` that records calls). Assert: right-clicking a node and choosing "New File" calls `client.request("fs/create", { path, kind: "file" })` with the correct parent path, and "Delete" calls `fs/delete` only after confirm.

- [ ] **Step 7: Run web tests**

Run: `bun test packages/web`
Expected: PASS.

- [ ] **Step 8: Manual verification**

Right-click a folder in the file tree, create a file and a folder, rename one, cut/paste it into another folder, copy/paste, delete one with confirm - verify the tree refreshes correctly after each action and the corresponding keybindings work.

- [ ] **Step 9: Commit**

```bash
git add packages/web/src/workbench/filetree/FileTreePanel.tsx packages/web/src/workbench/layout/Workbench.tsx
git commit -m "feat(web): add file tree context menu and keybindings for create/rename/delete/move/copy"
```

---

### Task 13: Clarify the two model indicators

**Files:**
- Modify: `packages/web/src/StatusPill.tsx`
- Modify: `packages/web/src/workbench/chat/ChatPanel.tsx`

**Interfaces:** None - label-only change, no prop/type changes.

- [ ] **Step 1: Label the completion-engine pill**

In `StatusPill.tsx`, find where the active model name is rendered and prefix it with a static label:

```tsx
<span style={{ opacity: 0.7, marginRight: 4 }}>Completion:</span>
```

placed immediately before the existing model-name span, inside the same pill container (don't change the pill's outer structure/tests beyond this label).

- [ ] **Step 2: Label the chat-status pill**

In `ChatPanel.tsx`'s model-status pill (from the research excerpt), add the equivalent prefix:

```tsx
<span style={{ opacity: 0.7, marginRight: 4 }}>Chat:</span>
{status.activeModel ?? "no chat model"}
```

- [ ] **Step 3: Update existing tests referencing the old label text**

Run: `grep -rln "no chat model\|StatusPill" packages/web/src --include=*.test.* 2>/dev/null` (adjust glob for this shell) and update any assertion matching the old rendered text to include the new "Chat:"/"Completion:" prefix.

- [ ] **Step 4: Run web tests**

Run: `bun test packages/web`
Expected: PASS.

- [ ] **Step 5: Manual verification**

Confirm both pills now read clearly, e.g. "Completion: qwen2.5-coder" and "Chat: llama3.1", side by side without ambiguity about which is which.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/StatusPill.tsx packages/web/src/workbench/chat/ChatPanel.tsx
git commit -m "fix(web): label completion vs chat model indicators explicitly"
```

---

### Task 14: Context window usage in the status bar

**Files:**
- Modify: `packages/core/src/agentRuntime.ts`
- Modify: `packages/core/src/agentRuntime.test.ts`
- Modify: `packages/protocol/src/messages.ts`
- Modify: `packages/web/src/workbench/chat/ChatPanel.tsx` (to pass status up) or `packages/web/src/workbench/StatusBar.tsx` directly - see Step 5 for the exact plumbing decision.

**Interfaces:**
- Produces: `AgentRuntimeStatus` gains `usedTokens: number | null` and `contextWindowTokens: number | null`; `ChatStatusResult` (protocol) gains the same two fields.

This is new plumbing end-to-end - there is no existing daemon→web path for token counts today (confirmed during research: `tokenLedger.ts`'s `estimateMessagesTokens`/`needsCompaction` are core-internal, used only for the compaction decision). This task adds the minimum needed to surface it, reusing the `chat/status` RPC that already polls per session rather than inventing a new RPC or broadcast event.

- [ ] **Step 1: Write the failing core test**

In `packages/core/src/agentRuntime.test.ts`, add (matching the file's existing fake-provider/fake-client test setup style - read the top of the file first for the exact fake shapes used):

```ts
test("status reports used and context-window token counts once a turn starts", async () => {
  const { runtime, client } = makeRuntime(); // use whatever existing test factory this file already has
  client.queueResponse("chat/get", { messages: [{ role: "user", content: "hello there", createdAt: 0 }] });
  const events = [];
  for await (const e of runtime.sendMessage("s1", "hi", new AbortController().signal)) events.push(e);
  const status = runtime.status();
  expect(status.contextWindowTokens).toBeGreaterThan(0);
  expect(status.usedTokens).toBeGreaterThan(0);
});
```

(Adapt `makeRuntime()`/`client.queueResponse` to whatever the file's actual helpers are named - grep `agentRuntime.test.ts` for its existing `sendMessage` tests and copy their exact setup boilerplate rather than inventing new helper names.)

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/core/src/agentRuntime.test.ts`
Expected: FAIL - `status.contextWindowTokens` is `undefined`.

- [ ] **Step 3: Extend `AgentRuntimeStatus` and compute the values**

```ts
export interface AgentRuntimeStatus {
  activeModel: string | null;
  reason: string | null;
  usedTokens: number | null;
  contextWindowTokens: number | null;
}
```

In `sendMessage`, after `history = loaded.messages;` (so the count reflects what's about to be sent, before the new user turn is appended) and after `needsCompaction`/compaction handling settles `history`, add a second status update:

```ts
this.#setStatus({
  activeModel: provider.id,
  reason: null,
  usedTokens: estimateMessagesTokens(history),
  contextWindowTokens: provider.capabilities().contextWindowTokens,
});
```

Update every other `#setStatus` call site in the file (the "no chat model available" error path, and any other existing call) to include `usedTokens: null, contextWindowTokens: null` so the type stays consistent everywhere.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/src/agentRuntime.test.ts`
Expected: PASS.

- [ ] **Step 5: Thread it through `chat/status` and the web side**

`packages/protocol/src/messages.ts`:

```ts
export interface ChatStatusResult {
  activeModel: string | null;
  reason: string | null;
  usedTokens: number | null;
  contextWindowTokens: number | null;
}
```

No change needed in `main.ts`'s `chat/status` handler - it already returns `runtime.status()` verbatim, so the new fields flow through automatically. In `ChatPanel.tsx`, where `chat/status`'s result is already polled/stored (the existing `status` variable driving the model pill), pass `status.usedTokens`/`status.contextWindowTokens` up to `Workbench.tsx` the same way chat's `activeModel` likely already isn't shared upward today - simplest correct approach: have `Workbench.tsx` itself poll `chat/status` for the *active* chat session on the same interval it already polls `graph/status`/`git/status` (Task 2), store `{ usedTokens, contextWindowTokens }` in workbench state, and pass it to `StatusBar` as a new `tokenStatus` prop - this avoids threading state up out of `ChatPanel` and keeps `StatusBar` fed the same way as the other polled pills.

- [ ] **Step 6: Render the pill in `StatusBar.tsx`**

```tsx
tokenStatus?: { usedTokens: number | null; contextWindowTokens: number | null } | null;
```

```tsx
{props.tokenStatus?.usedTokens != null && props.tokenStatus.contextWindowTokens != null && (
  <span title="Chat context window usage">
    {props.tokenStatus.usedTokens.toLocaleString()} / {props.tokenStatus.contextWindowTokens.toLocaleString()} tokens
  </span>
)}
```

- [ ] **Step 7: Run full test suite**

Run: `bun test`
Expected: PASS.

- [ ] **Step 8: Manual verification**

Open a chat session, send a message, confirm the status bar shows a used/total token count that updates as the conversation grows.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/agentRuntime.ts packages/core/src/agentRuntime.test.ts packages/protocol/src/messages.ts packages/web/src/workbench/chat/ChatPanel.tsx packages/web/src/workbench/StatusBar.tsx packages/web/src/workbench/layout/Workbench.tsx
git commit -m "feat: surface chat context-window token usage in the status bar"
```

---

### Task 15: Editor tab file-type icons

**Files:**
- Modify: `packages/web/src/workbench/layout/Workbench.tsx`

**Interfaces:**
- Consumes: `iconFor(name: string, isDir: boolean): string` (`workbench/icons/iconFor.ts`, already implemented and tested - no changes needed there).

- [ ] **Step 1: Write a failing test for the tab icon**

If `Workbench.tsx`'s `TabStrip` has no dedicated test, extend `packages/web/src/Editor.layout.test.ts` (or wherever tab rendering is already tested) with:

```ts
test("editor tabs render a file-type icon matching iconFor", () => {
  // render a group with a tab for "index.ts", assert an <img> with src === iconFor("index.ts", false) is present
});
```

Match this to the file's actual existing render-testing helpers rather than inventing new ones - read a neighboring test in the same file first.

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/web/src/Editor.layout.test.ts`
Expected: FAIL - no icon rendered.

- [ ] **Step 3: Add the icon to `TabStrip`**

In `Workbench.tsx`'s `TabStrip` component, import `iconFor` and add an `<img>` before the tab label:

```tsx
import { iconFor } from "../icons/iconFor";
// ...
<img src={iconFor(tab.path.split("/").at(-1) ?? "", false)} alt="" width={14} height={14} style={{ flexShrink: 0 }} />
<span>{tab.path.split("/").at(-1)}</span>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/web/src/Editor.layout.test.ts`
Expected: PASS.

- [ ] **Step 5: Manual verification**

Open a `.ts`, a `.py`, and a `.md` file as tabs, confirm each shows its distinct icon matching what the file tree already shows for the same files.

- [ ] **Step 6: Run web tests**

Run: `bun test packages/web`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/workbench/layout/Workbench.tsx packages/web/src/Editor.layout.test.ts
git commit -m "feat(web): show file-type icons on editor tabs"
```

---

### Task 16: `zero serve` + PTY regression test

**Files:**
- Modify: `packages/daemon/src/main.test.ts`

**Interfaces:** None - test-only task confirming existing behavior.

- [ ] **Step 1: Write the regression test**

Add to `packages/daemon/src/main.test.ts`, reusing the existing pty wire-test's `startZero`/`RpcClient` boilerplate exactly (this is the same code path `bin/zero.ts`'s `serve` branch uses - `startZero`):

```ts
test("pty/* RPCs are available on the same startZero path bin/zero.ts's serve command uses", async () => {
  const root = mkdtempSync(join(tmpdir(), "zero-"));
  const d = await startZero({ root, port: 0, webDist: undefined as unknown as string });
  const ws = await new Promise<WebSocket>((res, rej) => {
    const w = new WebSocket(`ws://127.0.0.1:${d.port}/rpc?token=${d.token}`);
    w.onopen = () => res(w); w.onerror = rej;
  });
  const client = new RpcClient(wsAdapter(ws));

  const session = await client.request<{ sessionId: string; shell: string }>("pty/open", { cols: 80, rows: 24 });
  expect(session.sessionId).toBeTruthy();
  const list = await client.request<{ sessions: unknown[] }>("pty/list");
  expect(list.sessions.length).toBeGreaterThan(0);

  ws.close();
  d.stop();
});
```

(If `startZero`'s options type requires `webDist` to be a real path rather than accepting `undefined`, check the existing tests in the same file for how they already satisfy that parameter and copy that instead of the placeholder above.)

- [ ] **Step 2: Run it to verify it passes**

Run: `bun test packages/daemon/src/main.test.ts`
Expected: PASS immediately - this task confirms existing behavior (per research, `main.ts` already registers `pty/*` unconditionally), it does not require a code change to `main.ts` itself. If it unexpectedly fails, that's a real bug to fix before continuing (surfacing it takes priority over the rest of this task list - stop and root-cause via systematic-debugging rather than skipping it).

- [ ] **Step 3: Run full daemon suite**

Run: `bun test packages/daemon`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/daemon/src/main.test.ts
git commit -m "test(daemon): add regression test confirming zero serve starts PTY support"
```

---

### Task 17: Version bump

**Files:**
- Modify: `package.json`

**Interfaces:** None.

- [ ] **Step 1: Bump the version**

In `package.json`, change `"version": "0.5.1"` to `"version": "0.5.2"`.

- [ ] **Step 2: Run the full test suite and typecheck one final time**

Run: `bun test && bun run typecheck`
Expected: PASS, no errors.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: bump version to 0.5.2"
```

---

## Final Steps

- [ ] Run `bun test` and `bun run typecheck` at the repo root one more time to confirm the whole tree is green after all 17 tasks.
- [ ] Open the PR from the worktree branch against `main`, summarizing all 17 changes (favicon, GitHub link + git status pill, PTY fix, tabbed terminal/chat, live terminal theming, chat theming/typing indicator/session dropdown/avatars+timestamps/scroll-to-bottom, file CRUD, model indicator labels, context-window status, editor tab icons, serve+PTY regression test, version bump).
