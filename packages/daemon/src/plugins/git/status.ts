import type { GitStatusResult } from "@zero/protocol";

async function git(root: string, args: string[]): Promise<{ exitCode: number; output: string }> {
  const proc = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, output: (stdout + stderr).trim() };
}

function describeStatus(code: string): string {
  const [x, y] = code;
  if (x === "?" && y === "?") return "untracked";
  if (x === "A" || y === "A") return "added";
  if (x === "D" || y === "D") return "deleted";
  if (x === "R" || y === "R") return "renamed";
  if (x === "M" || y === "M") return "modified";
  return "changed";
}

function parseFiles(porcelainLines: string[]): Array<{ path: string; status: string }> {
  return porcelainLines
    .filter((line) => !line.startsWith("##"))
    .map((line) => {
      const code = line.slice(0, 2);
      const rest = line.slice(3);
      const path = rest.includes(" -> ") ? rest.split(" -> ")[1] : rest;
      return { path, status: describeStatus(code) };
    });
}

/** Returns null if `root` isn't inside a git work tree, or git isn't installed. */
export async function getGitStatus(root: string): Promise<GitStatusResult | null> {
  const inTree = await git(root, ["rev-parse", "--is-inside-work-tree"]);
  if (inTree.exitCode !== 0 || inTree.output !== "true") return null;

  const branchResult = await git(root, ["branch", "--show-current"]);
  const branch = branchResult.output || "HEAD";

  const porcelain = await git(root, ["status", "--porcelain=v1", "--branch"]);
  const lines = porcelain.output.split("\n").filter(Boolean);
  const branchLine = lines[0] ?? "";
  const fileLines = branchLine.startsWith("##") ? lines.slice(1) : lines;
  const aheadMatch = branchLine.match(/ahead (\d+)/);
  const behindMatch = branchLine.match(/behind (\d+)/);

  const remote = await git(root, ["remote", "get-url", "origin"]);
  const remoteUrl = remote.exitCode === 0 && remote.output ? remote.output : null;

  return {
    branch,
    dirtyCount: fileLines.length,
    ahead: aheadMatch ? Number(aheadMatch[1]) : 0,
    behind: behindMatch ? Number(behindMatch[1]) : 0,
    remoteUrl,
    files: parseFiles(fileLines),
  };
}
