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

/** Adopt an untrusted settings value (localStorage cache, or `.zero/
 * settings.json` which is a hand-editable file on disk).
 *
 * Anything missing falls back to the default, and `theme` is clamped to the
 * two values the CSS actually defines — an unknown theme would reach
 * `ThemeProvider` as `data-theme="whatever"`, no variable would resolve, and
 * the whole UI would render unstyled. */
export function normalizeSettings(value: unknown): WorkbenchSettings {
  if (typeof value !== "object" || value === null) return { ...DEFAULT_SETTINGS };
  const raw = value as Partial<Record<keyof WorkbenchSettings, unknown>>;
  const merged: WorkbenchSettings = { ...DEFAULT_SETTINGS };
  if (raw.theme === "dark" || raw.theme === "light") merged.theme = raw.theme;
  if (typeof raw.sidebarWidth === "number" && Number.isFinite(raw.sidebarWidth) && raw.sidebarWidth >= 0) {
    merged.sidebarWidth = raw.sidebarWidth;
  }
  if (typeof raw.sidebarCollapsed === "boolean") merged.sidebarCollapsed = raw.sidebarCollapsed;
  return merged;
}

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
    this.#snapshot = this.#readStorage() ?? { ...DEFAULT_SETTINGS };
  }

  #readStorage(): WorkbenchSettings | null {
    const raw = this.#storage.getItem(STORAGE_KEY);
    if (!raw) return null;
    try { return normalizeSettings(JSON.parse(raw)); } catch { return null; }
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
    if (value !== undefined) {
      this.#snapshot = normalizeSettings(value);
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
      // Preferences failing to persist must never surface as an unhandled
      // rejection or take the editor down; the local snapshot still applies.
      void this.#client.request("settings/set", { key: "workbench", value: this.#snapshot }).catch(() => undefined);
    }, DEBOUNCE_MS);
  }

  subscribe(listener: (settings: WorkbenchSettings) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }
}
