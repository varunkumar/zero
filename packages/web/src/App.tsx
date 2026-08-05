import { useEffect, useState } from "react";
import type { RpcClient } from "@zero/protocol";
import { connect } from "./connection";
import { Workbench } from "./workbench/layout/Workbench";

export function App() {
  const [client, setClient] = useState<RpcClient | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let close: (() => void) | null = null;
    connect()
      .then((conn) => {
        close = conn.close;
        if (cancelled) {
          // StrictMode double-invoked this effect and the first run was cleaned
          // up before connect() resolved; close this now-orphaned connection
          // instead of leaking it.
          conn.close();
          return;
        }
        setClient(conn.client);
      })
      .catch((e: unknown) => {
        if (!cancelled) setConnectError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
      close?.();
    };
  }, []);

  if (connectError) {
    return <div style={{ padding: 16, color: "crimson" }}>Failed to connect: {connectError}</div>;
  }
  if (!client) {
    return <div style={{ padding: 16 }}>Connecting…</div>;
  }

  return <Workbench client={client} />;
}
