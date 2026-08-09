import { useEffect, useState } from "react";
import type { CompletionEngine, EngineStatus } from "@zero/core";

export function StatusPill(props: { engine: CompletionEngine }) {
  const [status, setStatus] = useState<EngineStatus>(() => props.engine.status());

  useEffect(() => {
    setStatus(props.engine.status());
    props.engine.onStatusChange(setStatus);
  }, [props.engine]);

  const active = status.activeModel !== null;

  return (
    <div
      title={status.reason ?? undefined}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "2px 8px",
        borderRadius: 12,
        border: "1px solid var(--zero-border)",
        fontSize: 14,
        color: "var(--zero-statusbar-fg)",
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: active ? "#2ecc71" : "#999",
          flexShrink: 0,
        }}
      />
      <span style={{ opacity: 0.7, marginRight: 4 }}>Completion:</span>
      {status.activeModel ?? "no model"}
    </div>
  );
}
