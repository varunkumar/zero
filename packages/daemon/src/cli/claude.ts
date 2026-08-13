import { startZero } from "../main";

export interface ClaudeCliDeps {
  log?: (line: string) => void;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  /** Daemon port. Defaults to 4820 (matching `zero serve`); tests pass 0 so
   * they never collide with a real running instance. */
  port?: number;
}

export function claudeLaunchBanner(opts: { webUrl: string; gatewayUrl: string; apiKey: string }): string {
  return [
    `zero ready: ${opts.webUrl}`,
    `Open that URL in Chrome or Edge to attach Gemini Nano.`,
    ``,
    `ANTHROPIC_BASE_URL=${opts.gatewayUrl} ANTHROPIC_API_KEY=${opts.apiKey} claude`,
  ].join("\n");
}

/** Returns a status line only on a true->false or false->true transition,
 * so the poll loop doesn't spam identical lines every tick. */
export function nanoHostStatusLine(prevAvailable: boolean, available: boolean): string | null {
  if (available === prevAvailable) return null;
  return available ? "Nano host attached ✓" : "waiting for a Zero tab with Gemini Nano...";
}

/** Starts the daemon with its model gateway always on (unlike `zero serve`,
 * where the gateway is opt-in via --gateway-port), prints the URL to open
 * plus the ANTHROPIC_BASE_URL/ANTHROPIC_API_KEY line, then polls Nano-host
 * attachment status until `deps.signal` aborts (real usage: Ctrl+C; tests:
 * an injected controller). */
export async function runClaudeCli(root: string, gatewayPort: number | undefined, deps: ClaudeCliDeps = {}): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const webDist = new URL("../../../web/dist", import.meta.url).pathname;
  const d = await startZero({ root, port: deps.port ?? 4820, webDist, gatewayPort: gatewayPort ?? 0 });

  // gatewayPort is always defined above (never `undefined` passed to
  // startZero), so startZero's gateway branch always runs and gatewayInfo
  // is always set - unlike `zero serve`, where the gateway is optional.
  log(claudeLaunchBanner({
    webUrl: `http://127.0.0.1:${d.port}/?token=${d.token}`,
    gatewayUrl: `http://127.0.0.1:${d.gatewayInfo!.port}`,
    apiKey: d.gatewayInfo!.apiKey,
  }));
  log("waiting for a Zero tab with Gemini Nano...");

  let lastAvailable = false;
  while (!deps.signal?.aborted) {
    const available = d.nanoHost.available();
    const line = nanoHostStatusLine(lastAvailable, available);
    if (line) log(line);
    lastAvailable = available;
    await sleep(deps.pollIntervalMs ?? 1000);
  }
  d.stop();
  return 0;
}
