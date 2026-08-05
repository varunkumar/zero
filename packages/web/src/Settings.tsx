import { useState } from "react";

const URL_KEY = "zero.ollamaUrl";
const MODEL_KEY = "zero.ollamaModel";

export function Settings() {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState(() => localStorage.getItem(URL_KEY) ?? "http://127.0.0.1:11434/v1");
  const [model, setModel] = useState(() => localStorage.getItem(MODEL_KEY) ?? "qwen2.5-coder:1.5b");

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
            background: "#fff",
            border: "1px solid #ccc",
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
              onChange={(e) => {
                const v = e.target.value;
                setUrl(v);
                localStorage.setItem(URL_KEY, v);
              }}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            Ollama model
            <input
              value={model}
              onChange={(e) => {
                const v = e.target.value;
                setModel(v);
                localStorage.setItem(MODEL_KEY, v);
              }}
            />
          </label>
        </div>
      )}
    </div>
  );
}
