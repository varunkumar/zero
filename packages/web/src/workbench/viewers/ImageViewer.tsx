import { useEffect, useState } from "react";
import type { RpcClient } from "@zero/protocol";
import { fetchBinaryFile, base64ToDataUrl } from "./fetchBinary";

const ZOOM_STEP = 0.25;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;

export function ImageViewer(props: { path: string; client: RpcClient }) {
  const [state, setState] = useState<{ status: "loading" } | { status: "error"; message: string } | { status: "ready"; dataUrl: string }>({ status: "loading" });
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    setState({ status: "loading" });
    setZoom(1);
    let cancelled = false;
    fetchBinaryFile(props.client, props.path)
      .then(({ contentBase64, mimeType }) => {
        if (cancelled) return;
        setState({ status: "ready", dataUrl: base64ToDataUrl(contentBase64, mimeType) });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setState({ status: "error", message: e instanceof Error ? e.message : String(e) });
      });
    return () => { cancelled = true; };
  }, [props.client, props.path]);

  if (state.status === "loading") return <div style={{ padding: 16, opacity: 0.6 }}>Loading image…</div>;
  if (state.status === "error") return <div style={{ padding: 16, color: "var(--zero-error, #e5484d)" }}>Could not load image: {state.message}</div>;

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", gap: 8, padding: "4px 8px" }}>
        <button onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z - ZOOM_STEP))} aria-label="Zoom out">−</button>
        <span>{Math.round(zoom * 100)}%</span>
        <button onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z + ZOOM_STEP))} aria-label="Zoom in">+</button>
        <button onClick={() => setZoom(1)} aria-label="Reset zoom">Fit</button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", display: "flex", alignItems: zoom <= 1 ? "center" : "flex-start", justifyContent: zoom <= 1 ? "center" : "flex-start" }}>
        <img
          src={state.dataUrl}
          alt={props.path}
          style={zoom <= 1 ? { maxWidth: "100%", maxHeight: "100%" } : { width: `${zoom * 100}%` }}
        />
      </div>
    </div>
  );
}
