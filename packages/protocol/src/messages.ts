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
export interface FsWriteParams { path: string; content: string }
export interface FsTreeResult { entries: TreeEntry[] }
export interface FsChangedEvent { path: string }
export interface FsSearchParams { query: string; caseSensitive?: boolean }
export interface FsSearchMatch { path: string; line: number; column: number; text: string }
export interface FsSearchResult { matches: FsSearchMatch[]; truncated: boolean }
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
