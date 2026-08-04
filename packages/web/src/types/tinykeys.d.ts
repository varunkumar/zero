// `tinykeys`'s package.json `exports` map has no `types` condition, so under
// `moduleResolution: "bundler"` TypeScript refuses to resolve the shipped
// `dist/tinykeys.d.ts` even though it exists (see packages/web/node_modules/
// tinykeys/package.json). This ambient declaration supplies just the members
// this package uses; it only affects type-checking, not Bun's runtime module
// resolution (unlike a tsconfig `paths` remap, which was tried and broke
// `bun test` by redirecting the runtime import to the `.d.ts` file itself).
declare module "tinykeys" {
  export interface KeyBindingMap {
    [keybinding: string]: (event: KeyboardEvent) => void;
  }

  export interface KeyBindingOptions {
    timeout?: number;
    event?: "keydown" | "keyup";
  }

  export function tinykeys(
    target: Window | HTMLElement,
    keyBindingMap: KeyBindingMap,
    options?: KeyBindingOptions,
  ): () => void;
}
