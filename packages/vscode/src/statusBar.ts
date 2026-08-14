export type ZeroStatus =
  | { kind: "daemon-not-found" }
  | { kind: "no-model"; reason: string | null }
  | { kind: "active"; model: string };

export interface StatusBarItemLike {
  text: string;
  tooltip?: string;
  show(): void;
}

export function renderStatus(status: ZeroStatus): { text: string; tooltip: string } {
  switch (status.kind) {
    case "daemon-not-found":
      return {
        text: "$(circle-slash) Zero",
        tooltip: "Zero: daemon not found — install the zero CLI and ensure it's on PATH",
      };
    case "no-model":
      return {
        text: "$(circle-slash) Zero",
        tooltip: `Zero: no model available${status.reason ? ` (${status.reason})` : ""}`,
      };
    case "active":
      return {
        text: `$(zap) Zero: ${status.model}`,
        tooltip: `Zero completions active — model: ${status.model}`,
      };
  }
}

export function updateStatusBar(item: StatusBarItemLike, status: ZeroStatus): void {
  const { text, tooltip } = renderStatus(status);
  item.text = text;
  item.tooltip = tooltip;
  item.show();
}
