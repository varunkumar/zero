import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Parser, Language } from "web-tree-sitter";

const require = createRequire(import.meta.url);

export type GraphifyGrammarSettings = Record<
  string,
  { extensions: string[]; module?: string; wasmPath?: string }
>;

/** Alias used by extract; same shape as GraphifyGrammarSettings. */
export type GrammarSettings = GraphifyGrammarSettings;

export type GrammarOverride = {
  extensions: string[];
  wasmPath?: string;
  module?: string;
};

const DEFAULT_EXT: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
};

/**
 * Built-in language → extension list + wasm basename.
 * `wasm` is a package-relative name resolved via resolveWasmPath.
 */
export const DEFAULT_GRAMMARS: Record<
  string,
  { extensions: string[]; wasm: string }
> = {
  typescript: {
    extensions: [".ts"],
    wasm: "tree-sitter-typescript.wasm",
  },
  tsx: {
    extensions: [".tsx"],
    wasm: "tree-sitter-tsx.wasm",
  },
  javascript: {
    extensions: [".js", ".jsx", ".mjs", ".cjs"],
    wasm: "tree-sitter-javascript.wasm",
  },
};

let initPromise: Promise<void> | null = null;
const languageCache = new Map<string, Language>();

function packageRoot(pkg: string): string {
  return dirname(require.resolve(`${pkg}/package.json`));
}

function coreWasmPath(): string {
  return join(packageRoot("web-tree-sitter"), "web-tree-sitter.wasm");
}

export function resolveLanguage(
  path: string,
  overrides?: GraphifyGrammarSettings,
): string | undefined {
  const ext = path.includes(".")
    ? path.slice(path.lastIndexOf(".")).toLowerCase()
    : "";
  if (overrides) {
    for (const [lang, cfg] of Object.entries(overrides)) {
      if (cfg.extensions.map((e) => e.toLowerCase()).includes(ext)) return lang;
    }
  }
  return DEFAULT_EXT[ext];
}

export async function ensureParserInit(): Promise<void> {
  if (!initPromise) {
    const wasm = coreWasmPath();
    initPromise = Parser.init({
      locateFile(scriptName: string, scriptDirectory?: string) {
        if (scriptName.endsWith(".wasm")) return wasm;
        return join(scriptDirectory ?? "", scriptName);
      },
    });
  }
  await initPromise;
}

export function resolveWasmPath(
  languageId: string,
  overrides?: GraphifyGrammarSettings,
): string | null {
  const o = overrides?.[languageId];
  if (o?.wasmPath) return o.wasmPath;

  try {
    if (languageId === "typescript" || languageId === "tsx") {
      const pkg = packageRoot("tree-sitter-typescript");
      // Packages ship wasm at package root (not under typescript/ or tsx/).
      return join(
        pkg,
        languageId === "tsx"
          ? "tree-sitter-tsx.wasm"
          : "tree-sitter-typescript.wasm",
      );
    }
    if (languageId === "javascript") {
      const pkg = packageRoot("tree-sitter-javascript");
      return join(pkg, "tree-sitter-javascript.wasm");
    }
    // Custom language via override.module + default wasm name from DEFAULT_GRAMMARS
    if (o?.module) {
      const name = DEFAULT_GRAMMARS[languageId]?.wasm ?? `tree-sitter-${languageId}.wasm`;
      return join(packageRoot(o.module), name);
    }
  } catch {
    return null;
  }
  return null;
}

export async function loadLanguage(
  languageId: string,
  overrides?: GraphifyGrammarSettings,
): Promise<Language | null> {
  await ensureParserInit();
  const cacheKey = `${languageId}::${overrides?.[languageId]?.wasmPath ?? ""}`;
  const cached = languageCache.get(cacheKey);
  if (cached) return cached;

  const wasm = resolveWasmPath(languageId, overrides);
  if (!wasm) return null;
  try {
    const lang = await Language.load(wasm);
    languageCache.set(cacheKey, lang);
    return lang;
  } catch {
    return null;
  }
}

/** Create a Parser with the given language loaded, or null on failure. */
export async function loadParser(
  languageId: string,
  overrides?: GraphifyGrammarSettings,
): Promise<Parser | null> {
  const lang = await loadLanguage(languageId, overrides);
  if (!lang) return null;
  const parser = new Parser();
  parser.setLanguage(lang);
  return parser;
}

export function activeLanguages(overrides?: GraphifyGrammarSettings): string[] {
  const base = Object.keys(DEFAULT_GRAMMARS);
  if (!overrides) return base;
  return [...new Set([...base, ...Object.keys(overrides)])];
}
