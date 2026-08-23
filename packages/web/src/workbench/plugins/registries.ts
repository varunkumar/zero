export interface StatusBarItem {
  id: string;
  mount(el: HTMLElement): () => void;
}

export class StatusBarRegistry {
  #items = new Map<string, StatusBarItem>();
  #listeners = new Set<() => void>();

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }

  register(item: StatusBarItem): void {
    this.#items.set(item.id, item);
    this.#notify();
  }

  unregister(id: string): void {
    this.#items.delete(id);
    this.#notify();
  }

  list(): StatusBarItem[] {
    return [...this.#items.values()];
  }

  /** Same subscribe convention as TabStore: plugins register late (after an
   * async plugin/list RPC + dynamic import()), so hosts need a signal to
   * re-render once contributions land. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
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
  #listeners = new Set<() => void>();

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }

  register(panel: SidebarPanelSpec): void {
    this.#panels.set(panel.id, panel);
    this.#notify();
  }

  unregister(id: string): void {
    this.#panels.delete(id);
    this.#notify();
  }

  get(id: string): SidebarPanelSpec | undefined {
    return this.#panels.get(id);
  }

  list(): SidebarPanelSpec[] {
    return [...this.#panels.values()];
  }

  /** See StatusBarRegistry.subscribe. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
