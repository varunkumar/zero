import { Command } from "cmdk";

export function Palette<T>(props: {
  open: boolean;
  onClose: () => void;
  items: T[];
  getLabel: (item: T) => string;
  onSelect: (item: T) => void;
  placeholder: string;
  /** Live input value, for callers that rank/cap `items` themselves. */
  onQueryChange?: (query: string) => void;
  /** Set false when the caller has already filtered `items` (the file opener
   * ranks with `command-score` and caps the list); cmdk would otherwise
   * re-filter and could drop already-ranked entries. */
  filter?: boolean;
}) {
  if (!props.open) return null;
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.4)",
        display: "flex",
        justifyContent: "center",
        paddingTop: "10vh",
        zIndex: 1000,
      }}
      onClick={props.onClose}
      onKeyDown={(e) => { if (e.key === "Escape") props.onClose(); }}
    >
      <div
        style={{
          background: "var(--zero-editor-bg)",
          color: "var(--zero-editor-fg)",
          width: 480,
          maxHeight: "60vh",
          borderRadius: 8,
          border: "1px solid var(--zero-border)",
          overflow: "hidden",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <Command label={props.placeholder} shouldFilter={props.filter ?? true}>
          <Command.Input
            autoFocus
            placeholder={props.placeholder}
            onValueChange={props.onQueryChange}
            style={{
              width: "100%",
              padding: 12,
              border: "none",
              borderBottom: "1px solid var(--zero-border)",
              background: "transparent",
              color: "inherit",
              outline: "none",
              boxSizing: "border-box",
            }}
          />
          <Command.List style={{ maxHeight: "50vh", overflow: "auto", padding: 4 }}>
            <Command.Empty style={{ padding: 12, opacity: 0.6 }}>No results.</Command.Empty>
            {props.items.map((item, i) => (
              <Command.Item
                key={`${props.getLabel(item)}:${i}`}
                value={props.getLabel(item)}
                onSelect={() => {
                  props.onSelect(item);
                  props.onClose();
                }}
                style={{ padding: "8px 12px", borderRadius: 4, cursor: "pointer" }}
              >
                {props.getLabel(item)}
              </Command.Item>
            ))}
          </Command.List>
        </Command>
      </div>
    </div>
  );
}
