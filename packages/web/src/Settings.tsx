import { useEffect, useState } from "react";
import { DEFAULT_OLLAMA_BASE_URL } from "@zero/core";
import type { ModelsListResult } from "@zero/protocol";

const URL_KEY = "zero.ollamaUrl";
const MODEL_KEY = "zero.ollamaModel";

interface RpcLike { request<R>(method: string, params?: unknown): Promise<R> }

export function Settings(props: { client?: RpcLike }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState(() => localStorage.getItem(URL_KEY) ?? DEFAULT_OLLAMA_BASE_URL);
  const [model, setModel] = useState(() => localStorage.getItem(MODEL_KEY) ?? "");
  const [models, setModels] = useState<string[]>([]);

  useEffect(() => {
    if (!props.client) return;
    let cancelled = false;
    props.client.request<ModelsListResult>("models/list").then((r) => {
      if (cancelled) return;
      setModels(r.models);
      if (r.active) {
        setModel(r.active);
        localStorage.setItem(MODEL_KEY, r.active);
      }
      if (r.url) {
        setUrl(r.url);
        localStorage.setItem(URL_KEY, r.url);
      }
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [props.client]);

  function persistUrl(v: string) {
    setUrl(v);
    localStorage.setItem(URL_KEY, v);
    void props.client?.request("settings/set", { key: URL_KEY, value: v }).catch(() => undefined);
  }

  function persistModel(v: string) {
    setModel(v);
    localStorage.setItem(MODEL_KEY, v);
    void props.client?.request("models/set", { model: v }).catch(() => undefined);
  }

  return (
    <div style={{ position: "relative", fontSize: 14 }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{ fontSize: 14, padding: "2px 8px", cursor: "pointer" }}
      >
        Settings
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            right: 0,
            top: "100%",
            marginTop: 4,
            padding: 8,
            background: "var(--zero-editor-bg)",
            color: "var(--zero-editor-fg)",
            border: "1px solid var(--zero-border)",
            borderRadius: 4,
            display: "flex",
            flexDirection: "column",
            gap: 6,
            zIndex: 10,
            minWidth: 220,
          }}
        >
          <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            Ollama URL
            <input
              value={url}
              onChange={(e) => persistUrl(e.target.value)}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            Ollama model
            {models.length > 0 ? (
              <select
                aria-label="Ollama model"
                value={model}
                onChange={(e) => persistModel(e.target.value)}
              >
                {models.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
            ) : (
              <input
                aria-label="Ollama model"
                value={model}
                placeholder="no models found"
                onChange={(e) => persistModel(e.target.value)}
              />
            )}
          </label>
        </div>
      )}
    </div>
  );
}
