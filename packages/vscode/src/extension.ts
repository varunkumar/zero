import * as vscode from "vscode";
import { CompletionEngine } from "@zero/core";
import { DaemonClient, DEFAULT_GATEWAY_PORT } from "./daemonClient";
import { GatewayCompletionProvider } from "./gatewayCompletionProvider";
import { VscodeBufferContext } from "./vscodeBufferContext";
import { createInlineCompletionProvider } from "./inlineCompletion";
import { updateStatusBar, type StatusBarItemLike, type ZeroStatus } from "./statusBar";

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

  const gatewayPort = vscode.workspace.getConfiguration("zero").get<number>("gatewayPort", DEFAULT_GATEWAY_PORT);
  const daemon = await new DaemonClient(root).ensureRunning(gatewayPort);
  if (!daemon) {
    setStatus({ kind: "daemon-not-found" });
    return;
  }

  const gatewayProvider = new GatewayCompletionProvider({
    baseUrl: `http://127.0.0.1:${daemon.port}`,
    apiKey: daemon.apiKey,
    onError: (msg) => outputChannel.appendLine(msg),
  });
  const bufferContext = new VscodeBufferContext(() =>
    vscode.workspace.textDocuments.map((d) => ({ path: d.uri.fsPath, getText: () => d.getText() }))
  );
  const engine = new CompletionEngine({ providers: [gatewayProvider], context: [bufferContext] });
  engine.onStatusChange((s) => {
    setStatus(s.activeModel ? { kind: "active", model: s.activeModel } : { kind: "no-model", reason: s.reason });
  });

  const provider = createInlineCompletionProvider(engine);
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider({ scheme: "file", pattern: "**" }, provider)
  );
}

export function deactivate(): void {}
