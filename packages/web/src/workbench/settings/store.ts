export interface WorkbenchSettings {
  theme: "light" | "dark";
  sidebarWidth: number;
  sidebarCollapsed: boolean;
}

export const DEFAULT_SETTINGS: WorkbenchSettings = {
  theme: "dark",
  sidebarWidth: 240,
  sidebarCollapsed: false,
};

const STORAGE_KEY = "zero.workbench";
const DEBOUNCE_MS = 500;

interface RpcLike { request(method: string, params?: unknown): Promise<unknown> }
interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void }

export class SettingsStore {
  #client: RpcLike;
  #storage: StorageLike;
  #snapshot: WorkbenchSettings;
  #listeners = new Set<(settings: WorkbenchSettings) => void>();
  #debounceHandle: ReturnType<typeof setTimeout> | undefined;

  constructor(client: RpcLike, storage: StorageLike) {
    this.#client = client;
    this.#storage = storage;
    this.#snapshot = this.#readStorage() ?? DEFAULT_SETTINGS;
  }

  #readStorage(): WorkbenchSettings | null {
    const raw = this.#storage.getItem(STORAGE_KEY);
    if (!raw) return null;
    try { return JSON.parse(raw) as WorkbenchSettings; } catch { return null; }
  }

  #writeStorage(settings: WorkbenchSettings): void {
    this.#storage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }

  #notify(): void {
    for (const listener of this.#listeners) listener(this.#snapshot);
  }

  getSnapshot(): WorkbenchSettings {
    return this.#snapshot;
  }

  async reconcile(): Promise<WorkbenchSettings> {
    const { value } = await this.#client.request("settings/get", { key: "workbench" }) as { value: unknown };
    if (value) {
      this.#snapshot = value as WorkbenchSettings;
      this.#writeStorage(this.#snapshot);
      this.#notify();
    }
    return this.#snapshot;
  }

  update(patch: Partial<WorkbenchSettings>): void {
    this.#snapshot = { ...this.#snapshot, ...patch };
    this.#writeStorage(this.#snapshot);
    this.#notify();
    clearTimeout(this.#debounceHandle);
    this.#debounceHandle = setTimeout(() => {
      void this.#client.request("settings/set", { key: "workbench", value: this.#snapshot });
    }, DEBOUNCE_MS);
  }

  subscribe(listener: (settings: WorkbenchSettings) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }
}
