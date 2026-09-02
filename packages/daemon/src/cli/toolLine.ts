function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function summarizeArgs(args: unknown): string {
  try {
    return truncate(JSON.stringify(args), 60);
  } catch {
    return "";
  }
}

/** One collapsed line for a finished tool call - shared by the TUI transcript
 * and headless `-p` mode so both report tool activity the same way, instead
 * of headless mode dumping the raw call + raw result as separate lines. */
export function formatToolResultLine(call: { name: string; args: unknown }, result: string): string {
  return `✓ ${call.name} ${summarizeArgs(call.args)} → ${truncate(result, 60)}`;
}
