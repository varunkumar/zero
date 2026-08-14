import type { ChatToolSpec, ChatDelta } from "../chatTypes";

/** A JSON Schema for the Prompt API's `responseConstraint`: forces Nano's
 * output into either a plain answer or a call to one of `tools`, since
 * Nano has no native tool-calling head. */
export function buildToolResponseConstraint(tools: ChatToolSpec[]): object {
  return {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["answer", "tool_call"] },
      text: { type: "string" },
      tool: { type: "string", enum: tools.map((t) => t.name) },
      input: { type: "object" },
    },
    required: ["kind"],
  };
}

/** Parses Nano's constrained JSON output. A tool name outside the offered
 * set, or output that isn't valid JSON at all (the model ignored the
 * constraint), degrades to a plain-text answer rather than throwing — a
 * small-model capability limit, not a plumbing failure. */
export function parseNanoToolResponse(raw: string, tools: ChatToolSpec[]): ChatDelta {
  try {
    const parsed = JSON.parse(raw) as { kind?: string; text?: string; tool?: string; input?: unknown };
    if (parsed.kind === "tool_call" && typeof parsed.tool === "string" && tools.some((t) => t.name === parsed.tool)) {
      return { toolCalls: [{ id: crypto.randomUUID(), name: parsed.tool, args: parsed.input ?? {} }] };
    }
    return { text: typeof parsed.text === "string" ? parsed.text : raw };
  } catch {
    return { text: raw };
  }
}
