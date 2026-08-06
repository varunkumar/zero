import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { RpcClient } from "@zero/protocol";
import type { PtyStore } from "./store";
import "@xterm/xterm/css/xterm.css";

export function TerminalHost(props: {
  client: RpcClient;
  ptyStore: PtyStore;
  sessionId: string;
  visible: boolean;
  theme: "light" | "dark";
}) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal>();
  const fit = useRef<FitAddon>();

  useEffect(() => {
    const t = new Terminal({
      convertEol: true,
      fontFamily: "'FiraCode Nerd Font', 'Fira Code', monospace",
      // xterm.js defaults cursor/cursorAccent to white when unset, which is
      // invisible against a white terminal background - both themes must
      // set it explicitly, not just override background/foreground.
      theme: props.theme === "dark"
        ? { background: "#1e1e2e", foreground: "#cdd6f4", cursor: "#cdd6f4", cursorAccent: "#1e1e2e" }
        : { background: "#ffffff", foreground: "#1d1d1f", cursor: "#1d1d1f", cursorAccent: "#ffffff" },
    });
    const f = new FitAddon();
    t.loadAddon(f);
    t.open(host.current!);
    f.fit();
    term.current = t;
    fit.current = f;

    t.onData((data) => {
      void props.client.request("pty/input", { sessionId: props.sessionId, data });
    });

    const unsubscribeOutput = props.ptyStore.onOutput(props.sessionId, (data) => t.write(data));

    const onResize = () => {
      f.fit();
      void props.client.request("pty/resize", { sessionId: props.sessionId, cols: t.cols, rows: t.rows });
    };
    const observer = new ResizeObserver(onResize);
    observer.observe(host.current!);

    return () => {
      unsubscribeOutput();
      observer.disconnect();
      t.dispose();
    };
    // A TerminalHost is created once per sessionId (key'd by the caller) and
    // never reconfigured, so this effect intentionally runs once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (props.visible) fit.current?.fit();
  }, [props.visible]);

  return <div ref={host} style={{ height: "100%", display: props.visible ? "block" : "none", padding: 4 }} />;
}
