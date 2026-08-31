import "./testUtils/domTestSetup";
if (!(globalThis as { localStorage?: Storage }).localStorage) {
  (globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
}
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test } from "bun:test";
import { Settings } from "./Settings";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) {
    act(() => root!.unmount());
    root = null;
  }
  if (container) {
    container.remove();
    container = null;
  }
  localStorage.clear();
});

function mount(el: React.ReactElement): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(el));
  return container;
}

test("Settings lists Ollama models from models/list and persists a pick via models/set", async () => {
  const calls: Array<[string, unknown]> = [];
  const client = {
    async request<R>(method: string, params?: unknown): Promise<R> {
      calls.push([method, params]);
      if (method === "models/list") {
        return { url: "http://127.0.0.1:11434/v1", models: ["llama3.2:latest", "mistral:latest"], running: [], active: "llama3.2:latest" } as R;
      }
      if (method === "models/set") {
        return { models: ["llama3.2:latest", "mistral:latest"], running: [], active: (params as { model: string }).model, url: "http://127.0.0.1:11434/v1" } as R;
      }
      return {} as R;
    },
  };
  const el = mount(<Settings client={client} />);
  act(() => {
    el.querySelector("button")!.click();
  });
  await act(async () => { await Promise.resolve(); });
  const select = el.querySelector("select[aria-label='Ollama model']") as HTMLSelectElement;
  expect(select).toBeTruthy();
  expect(select.value).toBe("llama3.2:latest");
  expect([...select.options].map((o) => o.value)).toEqual(["llama3.2:latest", "mistral:latest"]);

  await act(async () => {
    select.value = "mistral:latest";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(calls.some(([method, params]) => method === "models/set" && (params as { model: string }).model === "mistral:latest")).toBe(true);
  expect(localStorage.getItem("zero.ollamaModel")).toBe("mistral:latest");
});
