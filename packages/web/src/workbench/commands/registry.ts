export interface Command {
  id: string;
  title: string;
  run: () => void;
  keybinding?: string;
}

export class CommandRegistry {
  #commands = new Map<string, Command>();

  register(command: Command): void {
    this.#commands.set(command.id, command);
  }

  unregister(id: string): void {
    this.#commands.delete(id);
  }

  get(id: string): Command | undefined {
    return this.#commands.get(id);
  }

  list(): Command[] {
    return [...this.#commands.values()];
  }

  run(id: string): void {
    const command = this.#commands.get(id);
    if (!command) throw new Error(`no such command: ${id}`);
    command.run();
  }
}
