export interface Tab { id: string; path: string; content: string; savedContent: string; dirty: boolean }
export interface Group { id: string; tabs: Tab[]; activeTabId: string | null }

export class TabStore {
  #groups: Group[];
  #nextId = 1;
  #listeners = new Set<() => void>();

  constructor() {
    this.#groups = [{ id: "group-1", tabs: [], activeTabId: null }];
  }

  #notify() {
    for (const listener of this.#listeners) listener();
  }

  #group(groupId: string): Group {
    const group = this.#groups.find((g) => g.id === groupId);
    if (!group) throw new Error(`no such group: ${groupId}`);
    return group;
  }

  getGroups(): Group[] {
    return this.#groups;
  }

  openFile(groupId: string, path: string, content: string): string {
    const group = this.#group(groupId);
    const existing = group.tabs.find((t) => t.path === path);
    if (existing) {
      group.activeTabId = existing.id;
      this.#notify();
      return existing.id;
    }
    const id = `tab-${this.#nextId++}`;
    group.tabs.push({ id, path, content, savedContent: content, dirty: false });
    group.activeTabId = id;
    this.#notify();
    return id;
  }

  updateContent(tabId: string, content: string): void {
    const found = this.findTab(tabId);
    if (!found) return;
    found.tab.content = content;
    found.tab.dirty = content !== found.tab.savedContent;
    this.#notify();
  }

  markSaved(tabId: string): void {
    const found = this.findTab(tabId);
    if (!found) return;
    found.tab.savedContent = found.tab.content;
    found.tab.dirty = false;
    this.#notify();
  }

  closeTab(tabId: string): void {
    for (const group of this.#groups) {
      const idx = group.tabs.findIndex((t) => t.id === tabId);
      if (idx === -1) continue;
      group.tabs.splice(idx, 1);
      if (group.activeTabId === tabId) {
        group.activeTabId = group.tabs[idx]?.id ?? group.tabs[idx - 1]?.id ?? null;
      }
      this.#notify();
      return;
    }
  }

  setActiveTab(groupId: string, tabId: string): void {
    this.#group(groupId).activeTabId = tabId;
    this.#notify();
  }

  splitGroup(fromGroupId: string): string {
    this.#group(fromGroupId); // validate it exists
    const id = `group-${this.#nextId++}`;
    this.#groups.push({ id, tabs: [], activeTabId: null });
    this.#notify();
    return id;
  }

  /** What `removeGroup(groupId)` would do: which group disappears and which
   * neighbour absorbs its tabs. `undefined` when the removal is refused (last
   * group, or no such group). Shared so callers can inspect the outcome
   * before committing to it. */
  #removalPlan(groupId: string): { idx: number; removed: Group; target: Group } | undefined {
    if (this.#groups.length <= 1) return undefined;
    const idx = this.#groups.findIndex((g) => g.id === groupId);
    if (idx === -1) return undefined;
    const survivors = this.#groups.filter((_, i) => i !== idx);
    return { idx, removed: this.#groups[idx]!, target: survivors[idx - 1] ?? survivors[0]! };
  }

  /** Tabs with unsaved edits that `removeGroup(groupId)` would destroy rather
   * than move: the merge drops a tab whose path is already open in the target
   * group, so those buffers would vanish. Callers use this to refuse the
   * close instead of losing work. */
  dirtyTabsLostOnRemoveGroup(groupId: string): Tab[] {
    const plan = this.#removalPlan(groupId);
    if (!plan) return [];
    return plan.removed.tabs.filter((t) => t.dirty && plan.target.tabs.some((o) => o.path === t.path));
  }

  /** Drops an editor group, moving its tabs into a surviving neighbour so a
   * split close can never discard unsaved work. Refuses to remove the last
   * group (there must always be somewhere to edit) and returns whether it
   * removed anything. */
  removeGroup(groupId: string): boolean {
    const plan = this.#removalPlan(groupId);
    if (!plan) return false;
    this.#groups.splice(plan.idx, 1);
    for (const tab of plan.removed.tabs) {
      // The same file open in both groups would otherwise become two tabs
      // over one path in one group.
      if (plan.target.tabs.some((t) => t.path === tab.path)) continue;
      plan.target.tabs.push(tab);
      plan.target.activeTabId ??= tab.id;
    }
    this.#notify();
    return true;
  }

  findTab(tabId: string): { group: Group; tab: Tab } | undefined {
    for (const group of this.#groups) {
      const tab = group.tabs.find((t) => t.id === tabId);
      if (tab) return { group, tab };
    }
    return undefined;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }
}
