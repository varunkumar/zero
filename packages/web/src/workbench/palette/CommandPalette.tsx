import type { CommandRegistry } from "../commands/registry";
import { Palette } from "./Palette";

export function CommandPalette(props: { registry: CommandRegistry; open: boolean; onClose: () => void }) {
  return (
    <Palette
      open={props.open}
      onClose={props.onClose}
      items={props.registry.list()}
      getLabel={(c) => c.title}
      onSelect={(c) => props.registry.run(c.id)}
      placeholder="Type a command…"
    />
  );
}
