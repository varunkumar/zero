import {
  DEFAULT_OLLAMA_BASE_URL,
  OpenAICompatProvider,
  listCompatModels,
  listRunningOllamaModels,
  resolveCompatModel,
  type ChatCapableProvider,
} from "@zero/core";

export const OLLAMA_URL_KEY = "zero.ollamaUrl";
export const OLLAMA_MODEL_KEY = "zero.ollamaModel";
/** Legacy chat-only key; still read as a fallback for existing settings.json files. */
export const OLLAMA_CHAT_MODEL_KEY = "zero.ollamaChatModel";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface SettingsLike {
  readSetting(key: string): Promise<unknown>;
  writeSetting(key: string, value: unknown): Promise<void>;
}

export interface OllamaCatalog {
  url: string;
  models: string[];
  running: string[];
  active: string | null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export async function readOllamaUrl(ws: SettingsLike): Promise<string> {
  return asString(await ws.readSetting(OLLAMA_URL_KEY)) ?? DEFAULT_OLLAMA_BASE_URL;
}

export async function readPreferredOllamaModel(ws: SettingsLike): Promise<string | undefined> {
  return asString(await ws.readSetting(OLLAMA_MODEL_KEY))
    ?? asString(await ws.readSetting(OLLAMA_CHAT_MODEL_KEY));
}

export async function writeOllamaModel(ws: SettingsLike, model: string): Promise<void> {
  await ws.writeSetting(OLLAMA_MODEL_KEY, model);
}

export async function loadOllamaCatalog(
  ws: SettingsLike,
  fetchImpl: FetchLike = fetch,
  preferredOverride?: string,
): Promise<OllamaCatalog> {
  const url = await readOllamaUrl(ws);
  const [models, running, saved] = await Promise.all([
    listCompatModels(url, fetchImpl),
    listRunningOllamaModels(url, fetchImpl),
    readPreferredOllamaModel(ws),
  ]);
  const preferred = preferredOverride ?? saved;
  const active = resolveCompatModel({ preferred, available: models, running }) ?? null;
  if (!preferredOverride && active) {
    const primary = asString(await ws.readSetting(OLLAMA_MODEL_KEY));
    const legacy = asString(await ws.readSetting(OLLAMA_CHAT_MODEL_KEY));
    if (primary !== active) await writeOllamaModel(ws, active);
    if (legacy !== undefined && legacy !== active) await ws.writeSetting(OLLAMA_CHAT_MODEL_KEY, active);
  }
  return { url, models, running, active };
}

export function providerForModel(url: string, model: string, fetchImpl?: FetchLike): ChatCapableProvider {
  return new OpenAICompatProvider({ baseUrl: url, model, ...(fetchImpl ? { fetchImpl } : {}) });
}

export function providersFromCatalog(catalog: OllamaCatalog, fetchImpl?: FetchLike): ChatCapableProvider[] {
  if (!catalog.active) return [];
  return [providerForModel(catalog.url, catalog.active, fetchImpl)];
}
