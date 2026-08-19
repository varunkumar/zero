export interface StatusBarItem {
  id: string;
  mount(el: HTMLElement): () => void;
}

export class StatusBarRegistry {
  #items = new Map<string, StatusBarItem>();

  register(item: StatusBarItem): void {
    this.#items.set(item.id, item);
  }

  unregister(id: string): void {
    this.#items.delete(id);
  }

  list(): StatusBarItem[] {
    return [...this.#items.values()];
  }
}

export interface SidebarPanelSpec {
  id: string;
  title: string;
  icon?: string;
  mount(el: HTMLElement): () => void;
}

export class SidebarPanelRegistry {
  #panels = new Map<string, SidebarPanelSpec>();

  register(panel: SidebarPanelSpec): void {
    this.#panels.set(panel.id, panel);
  }

  unregister(id: string): void {
    this.#panels.delete(id);
  }

  get(id: string): SidebarPanelSpec | undefined {
    return this.#panels.get(id);
  }

  list(): SidebarPanelSpec[] {
    return [...this.#panels.values()];
  }
}
