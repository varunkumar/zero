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

## Chat model (Copilot Chat / VS Code chat)

Zero also registers as a selectable model in VS Code's chat (including
GitHub Copilot Chat), backed by the same daemon and model gateway as
completions. The Ollama model itself is not hardcoded here: the gateway
picks whatever is currently installed (and saved in `~/.zero/settings.json`
as `zero.ollamaModel`). VS Code requires a one-time manual step to enable any
third-party model provider:

1. Open the chat view, click the model picker, choose **Manage Models...**
2. Select **Zero** and enable the models you want.

Tool calling is offered only when the daemon's currently-active model
actually supports it (shown via the same status the completions status bar
reports) - a browser-only Gemini Nano session, for example, doesn't support
tool calling, while the daemon-side Nano bridge and Ollama-compatible
fallback do.
