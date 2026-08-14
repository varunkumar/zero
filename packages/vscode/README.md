# Zero (VS Code)

Offline inline completions (ghost text) powered by the same `@zero/core`
completion engine as the Zero web client, running against a local Zero
daemon's model gateway (Gemini Nano via an attached browser tab, or a local
Ollama-compatible model as fallback).

## Requirements

- The `zero` CLI installed and on `PATH` (see the main repo's
  [README](https://github.com/varunkumar/zero#cli-usage)).
- A Zero daemon reachable at `http://127.0.0.1:<zero.gatewayPort>` (default
  `4821`) - the extension starts one for the current workspace folder if
  none is found.

## Settings

- `zero.gatewayPort` (default `4821`): port the extension health-checks and,
  if needed, spawns `zero serve --gateway-port <port>` on.

## Status bar

The Zero status bar item (bottom right) shows the active model, or why
completions are unavailable (no daemon found, no model available).
