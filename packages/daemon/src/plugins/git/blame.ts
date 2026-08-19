import type { GitBlameResult } from "@zero/protocol";

async function git(root: string, args: string[]): Promise<{ exitCode: number; output: string }> {
  const proc = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, output: (stdout + stderr).trim() };
}

const HEADER_RE = /^([0-9a-f]{40}) \d+ (\d+)/;

/**
 * `git blame --porcelain` only prints full commit metadata (author,
 * author-time, ...) the first time a commit is seen; later lines from the
 * same commit repeat just the header + content. commitMeta caches the first
 * sighting so those later lines still resolve to an author/date.
 */
export async function getGitBlame(root: string, path: string): Promise<GitBlameResult | null> {
  const inTree = await git(root, ["rev-parse", "--is-inside-work-tree"]);
  if (inTree.exitCode !== 0 || inTree.output !== "true") return null;

  const result = await git(root, ["blame", "--porcelain", "--", path]);
  if (result.exitCode !== 0) return null;

  const commitMeta = new Map<string, { author: string; date: string }>();
  const lines: GitBlameResult["lines"] = [];
  let current: { commit: string; finalLine: number } | null = null;
  let pendingAuthor: string | undefined;
  let pendingTime: string | undefined;

  for (const raw of result.output.split("\n")) {
    const header = raw.match(HEADER_RE);
    if (header) {
      current = { commit: header[1], finalLine: Number(header[2]) };
      continue;
    }
    if (raw.startsWith("author ")) {
      pendingAuthor = raw.slice("author ".length);
      continue;
    }
    if (raw.startsWith("author-time ")) {
      pendingTime = raw.slice("author-time ".length);
      continue;
    }
    if (raw.startsWith("\t") && current) {
      if (pendingAuthor && pendingTime) {
        commitMeta.set(current.commit, {
          author: pendingAuthor,
          date: new Date(Number(pendingTime) * 1000).toISOString(),
        });
      }
      const meta = commitMeta.get(current.commit) ?? { author: "unknown", date: "" };
      lines.push({ line: current.finalLine, commit: current.commit, author: meta.author, date: meta.date });
      pendingAuthor = undefined;
      pendingTime = undefined;
    }
  }

  return { lines };
}
