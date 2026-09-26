import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CheckResult, GoalGraphConfig, ToolRegistry } from "./types.ts";

interface CommandSpec { name: string; command: string; args: string[]; required: boolean; }

function packageManager(cwd: string): string {
  if (fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(cwd, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(cwd, "bun.lockb")) || fs.existsSync(path.join(cwd, "bun.lock"))) return "bun";
  return "npm";
}

function scriptSpec(pm: string, name: string): CommandSpec {
  if (pm === "yarn") return { name, command: "yarn", args: ["run", name], required: true };
  if (pm === "bun") return { name, command: "bun", args: ["run", name], required: true };
  if (pm === "pnpm") return { name, command: "pnpm", args: ["run", name], required: true };
  return { name, command: "npm", args: ["run", name], required: true };
}

export function detectProjectChecks(cwd: string): CommandSpec[] {
  const specs: CommandSpec[] = [];
  const packageJson = path.join(cwd, "package.json");
  if (fs.existsSync(packageJson)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packageJson, "utf8"));
      const scripts = pkg.scripts ?? {};
      const pm = packageManager(cwd);
      for (const name of ["typecheck", "check:types", "lint", "test", "build"]) {
        if (typeof scripts[name] === "string") specs.push(scriptSpec(pm, name));
      }
    } catch { /* ignore malformed package.json here; build will expose it */ }
  }
  if (fs.existsSync(path.join(cwd, "pyproject.toml")) || fs.existsSync(path.join(cwd, "pytest.ini")) || fs.existsSync(path.join(cwd, "tests"))) {
    specs.push({ name: "pytest", command: process.platform === "win32" ? "python" : "python3", args: ["-m", "pytest", "-q"], required: true });
  }
  if (fs.existsSync(path.join(cwd, "go.mod"))) specs.push({ name: "go-test", command: "go", args: ["test", "./..."], required: true });
  if (fs.existsSync(path.join(cwd, "Cargo.toml"))) {
    specs.push({ name: "cargo-check", command: "cargo", args: ["check", "--all"], required: true });
    specs.push({ name: "cargo-test", command: "cargo", args: ["test", "--all", "--quiet"], required: true });
  }
  if (fs.existsSync(path.join(cwd, "pom.xml"))) specs.push({ name: "maven-test", command: process.platform === "win32" ? "mvn.cmd" : "mvn", args: ["test", "-q"], required: true });
  const gradlew = process.platform === "win32" ? "gradlew.bat" : "./gradlew";
  if (fs.existsSync(path.join(cwd, process.platform === "win32" ? "gradlew.bat" : "gradlew"))) {
    specs.push({ name: "gradle-test", command: gradlew, args: ["test"], required: true });
  }
  return dedupe(specs);
}

function dedupe(specs: CommandSpec[]): CommandSpec[] {
  const seen = new Set<string>();
  return specs.filter((s) => {
    const key = `${s.command}\u0000${s.args.join("\u0000")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function executableExists(name: string, cwd: string): Promise<boolean> {
  const command = process.platform === "win32" ? "where" : "which";
  return await new Promise((resolve) => {
    const proc = spawn(command, [name], { cwd, stdio: "ignore", shell: false });
    proc.on("error", () => resolve(false));
    proc.on("close", (code) => resolve(code === 0));
  });
}

function cap(text: string, max = 200_000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max / 2)}\n\n[... output truncated ...]\n\n${text.slice(-max / 2)}`;
}

export async function runCommand(
  cwd: string,
  spec: CommandSpec,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CheckResult> {
  const start = Date.now();
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  const exitCode = await new Promise<number>((resolve) => {
    const proc = spawn(spec.command, spec.args, {
      cwd,
      shell: false,
      env: { ...process.env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.stdout.on("data", (d) => { stdout += d.toString(); if (stdout.length > 300_000) stdout = cap(stdout); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); if (stderr.length > 300_000) stderr = cap(stderr); });
    proc.on("error", (error) => { stderr += `${error.message}\n`; resolve(127); });
    proc.on("close", (code) => resolve(code ?? 1));
    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill("SIGTERM"); } catch { /* noop */ }
      setTimeout(() => { try { if (!proc.killed) proc.kill("SIGKILL"); } catch { /* noop */ } }, 3000).unref?.();
    }, timeoutMs);
    proc.once("close", () => clearTimeout(timer));
    if (signal) {
      const kill = () => { try { proc.kill("SIGTERM"); } catch { /* noop */ } };
      if (signal.aborted) kill(); else signal.addEventListener("abort", kill, { once: true });
    }
  });
  return {
    name: spec.name,
    command: [spec.command, ...spec.args].join(" "),
    exitCode,
    stdout: cap(stdout),
    stderr: cap(stderr),
    durationMs: Date.now() - start,
    required: spec.required,
    timedOut,
  };
}

export async function runDeterministicChecks(
  cwd: string,
  config: GoalGraphConfig,
  tools: ToolRegistry,
  signal?: AbortSignal,
): Promise<CheckResult[]> {
  const specs = detectProjectChecks(cwd);
  if (config.review.semgrep !== "off" && tools.semgrep.status === "approved" && await executableExists(tools.semgrep.executable, cwd)) {
    specs.push({ name: "semgrep", command: tools.semgrep.executable, args: tools.semgrep.args ?? [], required: false });
  }
  const osv = tools["osv-scanner"];
  if (config.review.osvScanner !== "off" && osv.status === "approved" && await executableExists(osv.executable, cwd)) {
    specs.push({ name: "osv-scanner", command: osv.executable, args: osv.args ?? [], required: false });
  }

  const results: CheckResult[] = [];
  for (const spec of specs) {
    if (signal?.aborted) break;
    results.push(await runCommand(cwd, spec, config.execution.commandTimeoutMs, signal));
  }
  return results;
}

export function requiredChecksPass(results: CheckResult[]): boolean {
  return results.filter((r) => r.required).every((r) => r.exitCode === 0 && !r.timedOut);
}

export function checksSummary(results: CheckResult[], maxPerCheck = 3500): string {
  if (!results.length) return "No deterministic project checks were auto-detected. Auditor must rely on focused agent verification and repository evidence.";
  return results.map((r) => {
    const tail = `${r.stdout}\n${r.stderr}`.trim();
    const clipped = tail.length > maxPerCheck ? tail.slice(-maxPerCheck) : tail;
    return `[${r.exitCode === 0 && !r.timedOut ? "PASS" : "FAIL"}] ${r.name}: ${r.command} (${r.durationMs}ms)${r.timedOut ? " TIMEOUT" : ""}\n${clipped}`;
  }).join("\n\n");
}

export async function runApprovedExternalTool(
  cwd: string,
  name: string,
  executable: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CheckResult> {
  return runCommand(cwd, { name, command: executable, args, required: false }, timeoutMs, signal);
}
