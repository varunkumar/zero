export interface GitStatus {
  branch: string;
  dirtyCount: number;
  ahead: number;
  behind: number;
  remoteUrl: string | null;
}

async function git(root: string, args: string[]): Promise<{ exitCode: number; output: string }> {
  const proc = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, output: (stdout + stderr).trim() };
}

/** Returns null if `root` isn't inside a git work tree, or git isn't installed. */
export async function getGitStatus(root: string): Promise<GitStatus | null> {
  const inTree = await git(root, ["rev-parse", "--is-inside-work-tree"]);
  if (inTree.exitCode !== 0 || inTree.output !== "true") return null;

  const branchResult = await git(root, ["branch", "--show-current"]);
  const branch = branchResult.output || "HEAD";

  const porcelain = await git(root, ["status", "--porcelain=v1", "--branch"]);
  const lines = porcelain.output.split("\n").filter(Boolean);
  const branchLine = lines[0] ?? "";
  const dirtyCount = lines.length > 0 && branchLine.startsWith("##") ? lines.length - 1 : lines.length;
  const aheadMatch = branchLine.match(/ahead (\d+)/);
  const behindMatch = branchLine.match(/behind (\d+)/);

  const remote = await git(root, ["remote", "get-url", "origin"]);
  const remoteUrl = remote.exitCode === 0 && remote.output ? remote.output : null;

  return {
    branch,
    dirtyCount,
    ahead: aheadMatch ? Number(aheadMatch[1]) : 0,
    behind: behindMatch ? Number(behindMatch[1]) : 0,
    remoteUrl,
  };
}
