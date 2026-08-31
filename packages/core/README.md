# `@zero/core`

The isomorphic engine behind every Zero product: completions and the chat
agent, expressed purely in terms of injected interfaces so the same code
runs inside the daemon (Bun/Node), inside a browser tab with no daemon at
all (Zero Lite), and inside VS Code's extension host.

## Rules

- Never import DOM or Node/Bun APIs directly. Every capability a host can
  provide - the model, gathering context, touching the filesystem, running
  a tool - comes in through an interface (`ModelProvider`, `ContextProvider`,
  `WorkspaceProvider`, `ToolProvider`) that the host implements and injects.
- TypeScript `strict: true`, ESM only, dense unit coverage with fakes for
  the injected interfaces (see `*.test.ts` next to each module) rather than
  real DOM/Node dependencies.

## What's here

- `engine.ts` - `CompletionEngine`: keystroke-debounced (150ms), budgeted
  (50ms) context gathering, one completion request in flight at a time.
- `agentRuntime.ts` - `AgentRuntime`: the chat/agent loop - prompt
  assembly, tool-call dispatch, streaming responses back to the host.
- `context.ts`, `bufferContext.ts`, `graphContext.ts`, `lspContext.ts` -
  `ContextProvider` implementations (open buffers, Graphify graph
  neighborhoods, LSP hover/definitions) that feed the completion and chat
  prompts under the shared token budget.
- `providers/` - `ModelProvider` implementations: Chrome's built-in Gemini
  Nano, an OpenAI-compatible HTTP backend (Ollama and friends), plus
  Nano-specific tool-calling glue (`nanoTools.ts`).
- `providerGateway.ts`, `scheduler.ts` - picks and arbitrates between
  available model providers.
- `prompt.ts`, `systemPrompt.ts`, `chatTypes.ts`, `types.ts` - prompt
  construction and the shared type surface.
- `tokens.ts`, `tokenLedger.ts` - token estimation (`Math.ceil(chars / 4)`)
  and budget accounting used by every context provider.
- `diffPreview.ts` - turns a proposed edit into a diff for review before
  it's applied.
- `anthropicTranslate.ts` - translates Anthropic Messages API shapes to and
  from the internal chat types, for the Zero Claude Plugin bridge.

## Degradation

The editor must stay fully usable with no model available: a missing or
failing `ModelProvider` degrades completions/chat only, and never breaks
editing itself. Treat this as a hard constraint when touching
`engine.ts` or `agentRuntime.ts`.
