import { spawn } from "node:child_process";

async function run(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolve) => {
    const proc = spawn("git", args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("error", (e) => resolve({ code: 127, stdout, stderr: e.message }));
    proc.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

export async function gitDiff(cwd: string, maxChars = 50000): Promise<string> {
  const inside = await run(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0) return "(not a git repository)";
  const diff = await run(cwd, ["diff", "--no-ext-diff", "--unified=3"]);
  const staged = await run(cwd, ["diff", "--cached", "--no-ext-diff", "--unified=3"]);
  const combined = [`# Unstaged\n${diff.stdout}`, `# Staged\n${staged.stdout}`].join("\n\n");
  if (combined.length <= maxChars) return combined;
  return `${combined.slice(0, Math.floor(maxChars * 0.7))}\n\n[... diff truncated ...]\n\n${combined.slice(-Math.floor(maxChars * 0.3))}`;
}

export async function gitStatus(cwd: string): Promise<string> {
  const result = await run(cwd, ["status", "--short"]);
  return result.code === 0 ? result.stdout.trim() : "(git status unavailable)";
}
