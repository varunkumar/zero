import { tinykeys } from "tinykeys";
import type { CommandRegistry } from "../commands/registry";

/**
 * Builds a tinykeys key-binding map from every command that declares a
 * `keybinding`. Exported separately from `attachKeybindings` so it can be
 * unit-tested without dispatching real DOM `KeyboardEvent`s (bun:test has no
 * DOM shim providing `KeyboardEvent`/`navigator`).
 */
export function buildKeyMap(registry: CommandRegistry): Record<string, (event: KeyboardEvent) => void> {
  const keyMap: Record<string, (event: KeyboardEvent) => void> = {};
  for (const command of registry.list()) {
    if (!command.keybinding) continue;
    keyMap[command.keybinding] = (event) => {
      event.preventDefault();
      registry.run(command.id);
    };
  }
  return keyMap;
}

export function attachKeybindings(registry: CommandRegistry, target: EventTarget = window): () => void {
  return tinykeys(target as Window, buildKeyMap(registry));
}
