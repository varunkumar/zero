import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { RpcClient } from "@zero/protocol";
import type { PtyStore } from "./store";
import { ZERO_MONO_FONT } from "../theme/fonts";
import { terminalTheme } from "./theme";
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
      fontFamily: ZERO_MONO_FONT,
      theme: terminalTheme(props.theme),
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

  useEffect(() => {
    if (!term.current) return;
    term.current.options.theme = terminalTheme(props.theme);
  }, [props.theme]);

  return <div ref={host} style={{ height: "100%", display: props.visible ? "block" : "none", padding: 4 }} />;
}
