type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1";

function namesFromPayload(body: unknown): string[] {
  if (typeof body !== "object" || body === null) return [];
  const rec = body as { data?: unknown; models?: unknown };
  const rows = Array.isArray(rec.data) ? rec.data : Array.isArray(rec.models) ? rec.models : [];
  const names: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const item = row as { id?: unknown; name?: unknown; model?: unknown };
    const name = [item.id, item.name, item.model].find((v) => typeof v === "string" && v.length > 0);
    if (typeof name !== "string" || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/** OpenAI-compat `GET {baseUrl}/models`. Returns [] if the host is down. */
export async function listCompatModels(baseUrl: string, fetchImpl: FetchLike = fetch): Promise<string[]> {
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/models`, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return [];
    return namesFromPayload(await res.json());
  } catch {
    return [];
  }
}

/** Ollama native `GET {origin}/api/ps` — currently loaded models.
 * `baseUrl` is the OpenAI-compat root (`.../v1`); the `/v1` suffix is stripped.
 * Returns [] for non-Ollama hosts. */
export async function listRunningOllamaModels(baseUrl: string, fetchImpl: FetchLike = fetch): Promise<string[]> {
  try {
    const origin = baseUrl.replace(/\/v1\/?$/, "");
    const res = await fetchImpl(`${origin}/api/ps`, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return [];
    return namesFromPayload(await res.json());
  } catch {
    return [];
  }
}

/** Ollama native `POST {origin}/api/show` — reads the model's real context
 * window from `model_info["<arch>.context_length"]` (the field name is
 * arch-prefixed, e.g. `llama.context_length`, `qwen2.context_length`).
 * Returns undefined for non-Ollama hosts or if the field isn't present, so
 * callers can fall back to a default rather than reporting 0. */
export async function getOllamaContextWindow(
  baseUrl: string, model: string, fetchImpl: FetchLike = fetch,
): Promise<number | undefined> {
  try {
    const origin = baseUrl.replace(/\/v1\/?$/, "");
    const res = await fetchImpl(`${origin}/api/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: model }),
      signal: AbortSignal.timeout(1000),
    });
    if (!res.ok) return undefined;
    const body = await res.json() as { model_info?: Record<string, unknown> };
    const info = body.model_info;
    if (!info) return undefined;
    for (const [key, value] of Object.entries(info)) {
      if (key.endsWith(".context_length") && typeof value === "number") return value;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function matchesPreferred(preferred: string, available: string[]): string | undefined {
  if (available.includes(preferred)) return preferred;
  const latest = `${preferred}:latest`;
  if (available.includes(latest)) return latest;
  return available.find((name) => name.startsWith(`${preferred}:`));
}

/** Pick which installed model to send. Never invents a name that isn't on the host. */
export function resolveCompatModel(opts: {
  preferred?: string | null;
  available: string[];
  running?: string[];
}): string | undefined {
  const available = opts.available;
  if (opts.preferred) {
    const match = matchesPreferred(opts.preferred, available);
    if (match) return match;
  }
  for (const name of opts.running ?? []) {
    const match = matchesPreferred(name, available) ?? (available.includes(name) ? name : undefined);
    if (match) return match;
    // A loaded model that hasn't shown up in /models yet still wins over an
    // arbitrary first-in-list fallback — that's the model the user just switched to.
    if (name) return name;
  }
  return available[0];
}
