import { z } from "zod";

export class ProtocolError extends Error {}

const request = z.object({ jsonrpc: z.literal("2.0"), id: z.number(),
  method: z.string(), params: z.unknown().optional() });
const response = z.object({ jsonrpc: z.literal("2.0"), id: z.number(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional() });
const notification = z.object({ jsonrpc: z.literal("2.0"),
  method: z.string(), params: z.unknown().optional() });

export type RpcRequest = z.infer<typeof request>;
export type RpcResponse = z.infer<typeof response>;
export type RpcError = NonNullable<RpcResponse["error"]>;
export type RpcNotification = z.infer<typeof notification>;

export function parseMessage(raw: string): RpcRequest | RpcResponse | RpcNotification {
  let data: unknown;
  try { data = JSON.parse(raw); } catch { throw new ProtocolError("invalid json"); }
  for (const schema of [request, response, notification]) {
    const r = schema.safeParse(data);
    if (r.success) return r.data;
  }
  throw new ProtocolError("not a jsonrpc message");
}

export interface TreeEntry { path: string; kind: "file" | "dir" }
export interface FsReadParams { path: string }
export interface FsReadResult { content: string }
export interface FsReadBinaryParams { path: string }
export interface FsReadBinaryResult { contentBase64: string; mimeType: string }
export interface FsWriteParams { path: string; content: string }
export interface FsTreeResult { entries: TreeEntry[] }
export interface FsChangedEvent { path: string }
export interface FsSearchParams { query: string; caseSensitive?: boolean }
export interface FsSearchMatch { path: string; line: number; column: number; text: string }
export interface FsSearchResult { matches: FsSearchMatch[]; truncated: boolean }
export interface FsCreateParams { path: string; kind: "file" | "dir" }
export interface FsRenameParams { path: string; newPath: string }
export interface FsDeleteParams { path: string }
export interface FsMoveParams { path: string; newPath: string }
export interface FsCopyParams { path: string; newPath: string }
export interface SettingsGetParams { key: string }
export interface SettingsGetResult { value: unknown }
export interface SettingsSetParams { key: string; value: unknown }
export interface PtyOpenParams { shell?: string; cols: number; rows: number }
export interface PtyOpenResult { sessionId: string; shell: string }
export interface PtyInputParams { sessionId: string; data: string }
export interface PtyResizeParams { sessionId: string; cols: number; rows: number }
export interface PtyCloseParams { sessionId: string }
export interface PtySessionInfo { sessionId: string; shell: string }
export interface PtyListResult { sessions: PtySessionInfo[] }
export interface PtyOutputEvent { sessionId: string; data: string }
export interface PtyExitEvent { sessionId: string; exitCode: number }
export interface LspPosition { line: number; character: number }
export interface LspRange { start: LspPosition; end: LspPosition }
/** 1=Error, 2=Warning, 3=Information, 4=Hint — matches LSP's DiagnosticSeverity. */
export interface LspDiagnostic { range: LspRange; severity: 1 | 2 | 3 | 4; message: string; source?: string }
export interface LspDiagnosticsEvent { path: string; diagnostics: LspDiagnostic[] }
export interface LspSyncParams { path: string; content: string }
export interface LspHoverParams { path: string; position: LspPosition }
export interface LspHoverResult { contents: string | null }
export interface LspDefinitionParams { path: string; position: LspPosition }
export interface LspDefinitionLocation { path: string; range: LspRange }
export interface LspDefinitionResult { locations: LspDefinitionLocation[] }
export interface LspContextAtParams { path: string; position: LspPosition }
export interface LspContextChunk { text: string; score: number }
export interface LspContextAtResult { chunks: LspContextChunk[] }

/** 0-based line/character (LSP-style). */
export interface GraphPosition { line: number; character: number }

export interface GraphContextAtParams {
  path: string;
  position: GraphPosition;
  maxChunks?: number;
}
export interface GraphContextChunk { text: string; score: number; source?: string }
export interface GraphContextAtResult { chunks: GraphContextChunk[]; ready: boolean }

export interface GraphQueryParams {
  q: string;
  mode?: "neighbors" | "symbol" | "path";
  budgetTokens?: number;
}
export interface GraphQueryResult {
  nodes: { id: string; label: string; source_file?: string; kind?: string }[];
  edges: { source: string; target: string; relation: string }[];
  text: string;
}

export interface GraphStatusResult {
  ready: boolean;
  indexing: boolean;
  fileCount: number;
  nodeCount: number;
  edgeCount: number;
  lastError?: string;
  languages: string[];
}
export interface GraphStatusEvent {
  ready: boolean;
  indexing: boolean;
  nodeCount?: number;
  edgeCount?: number;
}

export interface PluginHealthInfo { ok: boolean; detail?: string }
export interface PluginListEntry {
  id: string;
  name: string;
  version: string;
  health: PluginHealthInfo;
  contributions: {
    rpcMethods?: string[];
    contextProviders?: string[];
    tools?: string[];
    commands?: string[];
  };
}
export interface PluginListResult { plugins: PluginListEntry[] }
export interface PluginHealthResult {
  ok: boolean;
  plugins: Record<string, PluginHealthInfo>;
}

export interface ChatToolCall { id: string; name: string; args: unknown }
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ChatToolCall[];
  toolCallId?: string;
  toolName?: string;
  createdAt: number;
}
export interface ChatSessionSummary { id: string; title: string; updatedAt: number; messageCount: number }

export interface ChatCreateParams { title?: string }
export interface ChatCreateResult { id: string }
export interface ChatListResult { sessions: ChatSessionSummary[] }
export interface ChatGetParams { id: string }
export interface ChatGetResult { id: string; title: string; messages: ChatMessage[] }
export interface ChatAppendParams { id: string; messages: ChatMessage[] }
export interface ChatRenameParams { id: string; title: string }
export interface ChatDeleteParams { id: string }

export type ChatTurnEvent =
  | { type: "text"; delta: string }
  | { type: "toolCall"; call: ChatToolCall }
  | { type: "toolResult"; call: ChatToolCall; result: string }
  | { type: "approvalRequest"; call: ChatToolCall; preview: string }
  | { type: "done"; message: ChatMessage }
  | { type: "error"; message: string };

export interface ChatTurnParams { sessionId: string; userText: string }
export interface ChatTurnResult { turnId: string }
export interface ChatTurnEventPayload { turnId: string; event: ChatTurnEvent }
export interface ChatApproveParams { turnId: string; callId: string; approved: boolean }
export interface ChatAbortParams { turnId: string }
export interface ChatStatusResult {
  activeModel: string | null;
  reason: string | null;
  usedTokens: number | null;
  contextWindowTokens: number | null;
}

export interface GitStatusResult {
  branch: string;
  dirtyCount: number;
  ahead: number;
  behind: number;
  remoteUrl: string | null;
}

export interface WhoamiResult {
  username: string;
}

export interface WorkspaceCapabilities {
  pty: boolean;
  lsp: boolean;
  graph: boolean;
  git: boolean;
  models: Array<"nano" | "openai-compat">;
}

export interface SessionHelloResult {
  capabilities: WorkspaceCapabilities;
  workspace: { name: string; kind: "daemon" | "browser-fs" };
}
