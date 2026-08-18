import { useEffect, useState } from "react";
import type { RpcClient } from "@zero/protocol";
import { fetchBinaryFile, base64ToObjectUrl } from "./fetchBinary";

export function PdfViewer(props: { path: string; client: RpcClient }) {
  const [state, setState] = useState<{ status: "loading" } | { status: "error"; message: string } | { status: "ready"; objectUrl: string }>({ status: "loading" });

  useEffect(() => {
    setState({ status: "loading" });
    let cancelled = false;
    let createdUrl: string | undefined;
    fetchBinaryFile(props.client, props.path)
      .then(({ contentBase64, mimeType }) => {
        if (cancelled) return;
        createdUrl = base64ToObjectUrl(contentBase64, mimeType);
        setState({ status: "ready", objectUrl: createdUrl });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setState({ status: "error", message: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      cancelled = true;
      // Revoke on unmount/path-change to avoid leaking a blob per tab switch.
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [props.client, props.path]);

  if (state.status === "loading") return <div style={{ padding: 16, opacity: 0.6 }}>Loading PDF…</div>;
  if (state.status === "error") return <div style={{ padding: 16, color: "var(--zero-error, #e5484d)" }}>Could not load PDF: {state.message}</div>;

  return <embed src={state.objectUrl} type="application/pdf" style={{ width: "100%", height: "100%", border: "none" }} />;
}
