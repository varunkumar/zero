export async function execCommand(command: string, cwd: string): Promise<{ exitCode: number; output: string }> {
  const proc = Bun.spawn(["/bin/sh", "-c", command], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, output: stdout + stderr };
}
