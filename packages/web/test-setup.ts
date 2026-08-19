// `bun test` runs source directly, skipping vite.config.ts's `define` step -
// StatusBar.tsx references __ZERO_VERSION__ expecting that substitution, so
// tests need the same global provided another way.
(globalThis as unknown as { __ZERO_VERSION__: string }).__ZERO_VERSION__ = "test";
