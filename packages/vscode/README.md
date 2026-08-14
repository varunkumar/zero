# Zero (VS Code)

Offline inline completions (ghost text) powered by the same `@zero/core`
completion engine as the Zero web client, running against a local Zero
daemon's model gateway (Gemini Nano via an attached browser tab, or a local
Ollama-compatible model as fallback).

## Requirements

- The `zero` CLI installed and on `PATH` (see the main repo's
  [README](https://github.com/varunkumar/zero#cli-usage)).

## How it finds (or starts) a daemon

Each workspace folder gets its own daemon on its own dynamically assigned
ports - nothing is shared or hardcoded. On activation, the extension reads
`<workspace>/.zero/zero.json`, written by `zero serve` on startup, to find
the daemon already running for *this* folder. If the file is missing or its
daemon isn't answering, the extension spawns `zero serve <workspace> --port
0 --gateway-port 0` (`0` means "pick a free port"), then waits for the
discovery file to appear. This means opening two different folders never
attaches one folder's editor to another folder's daemon.

## Status bar

The Zero status bar item (bottom right) reflects the daemon's model gateway
right after activation - no need to trigger a completion first - and shows
the active model, or why completions are unavailable (no daemon found, no
model available).
