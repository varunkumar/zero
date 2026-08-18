import type { RpcClient, FsReadBinaryResult } from "@zero/protocol";

export function fetchBinaryFile(client: RpcClient, path: string): Promise<FsReadBinaryResult> {
  return client.request<FsReadBinaryResult>("fs/readBinary", { path });
}

export function base64ToDataUrl(base64: string, mimeType: string): string {
  return `data:${mimeType};base64,${base64}`;
}

/** Blob URLs have no practical size cap (unlike data: URLs, which some
 * browsers cap around 2MB for `<embed>`/`<iframe>`) — used for the PDF
 * viewer, which embeds via `<embed>`. Callers must revoke the returned URL
 * (`URL.revokeObjectURL`) when done with it. */
export function base64ToObjectUrl(base64: string, mimeType: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
}
