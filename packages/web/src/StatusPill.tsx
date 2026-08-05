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
        border: "1px solid #ccc",
        fontSize: 14,
        color: "#555",
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
      {status.activeModel ?? "no model"}
    </div>
  );
}
