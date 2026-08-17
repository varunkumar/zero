import * as vscode from "vscode";
import { CompletionEngine } from "@zero/core";
import { DaemonClient } from "./daemonClient";
import { GatewayCompletionProvider } from "./gatewayCompletionProvider";
import { VscodeBufferContext } from "./vscodeBufferContext";
import { createInlineCompletionProvider } from "./inlineCompletion";
import { updateStatusBar, type StatusBarItemLike, type ZeroStatus } from "./statusBar";
import { createChatModelProvider } from "./chatModelProvider";

/**
 * Proactively probes the gateway's unauthenticated /health endpoint right
 * after the daemon comes up, so the status bar reflects reality immediately
 * instead of waiting for the first completion attempt to update it.
 */
async function probeHealth(gatewayPort: number): Promise<ZeroStatus> {
  try {
    const res = await fetch(`http://127.0.0.1:${gatewayPort}/health`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { kind: "no-model", reason: "gateway unreachable" };
    const { provider } = (await res.json()) as { provider: string | null };
    return provider ? { kind: "active", model: provider } : { kind: "no-model", reason: "no model available" };
  } catch {
    return { kind: "no-model", reason: "gateway unreachable" };
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return; // No workspace open; nothing to do.

  const outputChannel = vscode.window.createOutputChannel("Zero");
  context.subscriptions.push(outputChannel);

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  context.subscriptions.push(statusBar);
  // `vscode.StatusBarItem.tooltip` is typed as `string | MarkdownString | undefined`,
  // wider than `StatusBarItemLike.tooltip: string | undefined`, so TypeScript's
  // invariant check on the mutable `tooltip` property rejects a direct structural
  // match even though updateStatusBar only ever assigns a string. Narrow cast is
  // safe here: the real object always satisfies StatusBarItemLike at runtime.
  const setStatus = (status: ZeroStatus) => updateStatusBar(statusBar as unknown as StatusBarItemLike, status);
  setStatus({ kind: "no-model", reason: "starting" });

  const daemon = await new DaemonClient(root).ensureRunning();
  if (!daemon) {
    setStatus({ kind: "daemon-not-found" });
    return;
  }
  setStatus(await probeHealth(daemon.port));

  const gatewayProvider = new GatewayCompletionProvider({
    baseUrl: `http://127.0.0.1:${daemon.port}`,
    apiKey: daemon.apiKey,
    onError: (msg) => outputChannel.appendLine(msg),
  });
  const bufferContext = new VscodeBufferContext(() =>
    vscode.workspace.textDocuments.map((d) => ({ path: d.uri.fsPath, getText: () => d.getText() }))
  );
  const engine = new CompletionEngine({ providers: [gatewayProvider], context: [bufferContext] });

  // The status bar reflects request lifecycle rather than
  // engine.onStatusChange directly: the engine marks a model "active" as
  // soon as it picks a provider, which happens before the network call -
  // wiring that straight to the status bar would flash "active" over the
  // spinner for the whole duration of the actual request. Show the spinner
  // for the request's full lifetime instead, then read the engine's
  // settled status once it ends.
  const provider = createInlineCompletionProvider(engine, {
    onRequestStart: () => setStatus({ kind: "loading" }),
    onRequestEnd: () => {
      const s = engine.status();
      setStatus(s.activeModel ? { kind: "active", model: s.activeModel } : { kind: "no-model", reason: s.reason });
    },
  });
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider({ scheme: "file", pattern: "**" }, provider)
  );

  const chatModelProvider = createChatModelProvider({
    baseUrl: `http://127.0.0.1:${daemon.port}`,
    apiKey: daemon.apiKey,
    makeTextPart: (value) => new vscode.LanguageModelTextPart(value),
    makeToolCallPart: (callId, name, input) => new vscode.LanguageModelToolCallPart(callId, name, input),
  });
  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider("zero", chatModelProvider as unknown as vscode.LanguageModelChatProvider)
  );
  outputChannel.appendLine("Zero: chat model provider registered (enable it via Chat: Manage Models)");
}

export function deactivate(): void {}
