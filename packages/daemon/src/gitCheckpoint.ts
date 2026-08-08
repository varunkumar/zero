import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { execCommand } from "./execCommand";

async function git(root: string, args: string[], env: Record<string, string> = {}): Promise<{ exitCode: number; output: string }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } as Record<string, string>,
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exitCode = await proc.exited;
  return { exitCode, output: (stdout + stderr).trim() };
}

export class GitCheckpoint {
  #warned = false;

  constructor(private root: string) {}

  #indexFile(sessionId: string): string {
    return join(this.root, ".git", "zero-checkpoints", sessionId, "index");
  }

  #branchRef(sessionId: string): string {
    return `refs/heads/zero/agent-checkpoints/${sessionId}`;
  }

  #warn(reason: string): void {
    if (this.#warned) return;
    this.#warned = true;
    console.warn(`zero: git checkpointing disabled (${reason})`);
  }

  async checkpoint(sessionId: string, message: string): Promise<void> {
    try {
      const isRepo = await git(this.root, ["rev-parse", "--is-inside-work-tree"]);
      if (isRepo.exitCode !== 0) return this.#warn("not a git repository");

      await mkdir(join(this.root, ".git", "zero-checkpoints", sessionId), { recursive: true });
      const indexFile = this.#indexFile(sessionId);
      const env = { GIT_INDEX_FILE: indexFile };

      // Exclude .zero/ - it holds the gateway's live API key
      // (.zero/gateway-key) and full chat transcripts (.zero/sessions/*.json).
      // This repo's own .gitignore happens to already exclude .zero/, which
      // is why nothing caught this in dogfooding, but an arbitrary user
      // workspace the daemon is pointed at has no such guarantee - the
      // exclusion must be enforced here, not left to the workspace's own
      // .gitignore.
      const added = await git(this.root, ["add", "-A", "--", ".", ":(exclude).zero"], env);
      if (added.exitCode !== 0) return this.#warn(added.output);

      // Same .zero/ exclusion as the add above - otherwise a workspace
      // where only .zero/ changed (e.g. a new session transcript) would be
      // seen as "something changed" here even though nothing was actually
      // staged, producing a spurious checkpoint commit with an unchanged tree.
      const status = await git(this.root, ["status", "--porcelain", "--", ".", ":(exclude).zero"], env);
      if (!status.output) return; // nothing changed, no-op

      const tree = await git(this.root, ["write-tree"], env);
      if (tree.exitCode !== 0) return this.#warn(tree.output);

      const branchRef = this.#branchRef(sessionId);
      const existingParent = await git(this.root, ["rev-parse", "--verify", branchRef]);
      const parent = existingParent.exitCode === 0
        ? existingParent.output
        : (await git(this.root, ["rev-parse", "HEAD"])).output;

      const commit = await git(this.root, ["commit-tree", tree.output, "-p", parent, "-m", message], env);
      if (commit.exitCode !== 0) return this.#warn(commit.output);

      const updateRef = await git(this.root, ["update-ref", branchRef, commit.output]);
      if (updateRef.exitCode !== 0) return this.#warn(updateRef.output);
    } catch (e) {
      this.#warn(e instanceof Error ? e.message : String(e));
    }
  }
}
