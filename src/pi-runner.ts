import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentRole, AgentRunResult, ModelTier } from "./types.ts";

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  // 1) CI/test override: run a fake worker with plain `node` on any OS
  //    (removes the POSIX `#!/bin/sh` dependencies the suite used to have).
  const fake = process.env.PI_AUTOGRAPH_FAKE_PI || process.env.PI_GOAL_GRAPH_FAKE_PI;
  if (fake) return { command: process.execPath, args: [fake, ...args] };
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) return { command: process.execPath, args };
  return { command: process.platform === "win32" ? "pi.cmd" : "pi", args };
}

function textFromMessage(message: any): string {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content
    .filter((p: any) => p?.type === "text" && typeof p.text === "string")
    .map((p: any) => p.text)
    .join("\n");
}

async function tempSystemPrompt(role: string, text: string): Promise<{ dir: string; file: string }> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-autograph-"));
  const file = path.join(dir, `${role.replace(/[^a-z0-9_-]/gi, "_")}.md`);
  await fs.promises.writeFile(file, text, { encoding: "utf8", mode: 0o600 });
  return { dir, file };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Provider-side transient failure signatures (seen live on the NVIDIA free tier). */
const TRANSIENT = /(\b429\b|\b50[0234]\b|rate[- ]?limit|service unavailable|gateway timeout|upstream|cloudflare|fetch failed|socket hang up|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|timed out)/i;

interface AttemptResult {
  exitCode: number;
  output: string;
  stderr: string;
  stopReason?: string;
  errorMessage?: string;
  aborted: boolean;
  timedOut: boolean;
  usage: AgentRunResult["usage"];
}

function isTransient(result: AttemptResult): boolean {
  if (result.exitCode === 0) return false;
  if (result.aborted) return false;
  const text = `${result.stderr}\n${result.output}`;
  return TRANSIENT.test(text);
}

export interface RunAgentOptions {
  cwd: string;
  role: AgentRole;
  task: string;
  systemPrompt: string;
  model: string;
  modelTier: ModelTier;
  tools: string[];
  thinking?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  settleGraceMs?: number;
  /** Retries on transient provider errors (429/50x/network), not on real task failures. */
  maxRetries?: number;
  /** Base backoff in ms between transient retries (exponential). */
  retryDelayMs?: number;
  /** Test hook: bypass pi resolution and run this command instead. */
  piInvocation?: { command: string; args: string[] };
  goalId?: string;
  onProgress?: (message: string) => void;
}

function spawnOnce(invocation: { command: string; args: string[] }, options: RunAgentOptions): Promise<AttemptResult> {
  const result: AttemptResult = {
    exitCode: 1,
    output: "",
    stderr: "",
    aborted: false,
    timedOut: false,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
  };

  return new Promise<AttemptResult>((resolve) => {
    const proc = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      shell: false,
      // On POSIX put each worker in its own process group so a leaked descendant
      // cannot keep JSON stdout/stderr pipes open after the Pi worker is settled.
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PI_AUTOGRAPH_CHILD: "1",
        PI_AUTOGRAPH_GOAL_ID: options.goalId ?? "",
      },
    });

    let buffer = "";
    const texts: string[] = [];
    let finished = false;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let reapedAfterSettle = false;

    const finish = (code: number) => {
      if (finished) return;
      finished = true;
      if (settleTimer) clearTimeout(settleTimer);
      if (hardTimer) clearTimeout(hardTimer);
      if (buffer.trim()) processLine(buffer);
      result.output = texts.join("\n\n").trim();
      result.exitCode = code;
      resolve(result);
    };

    const killTree = (signal: "SIGTERM" | "SIGKILL") => {
      try {
        if (process.platform !== "win32" && proc.pid) process.kill(-proc.pid, signal);
        else proc.kill(signal);
      } catch { /* process may already be gone */ }
    };

    const terminate = (force = false) => {
      killTree(force ? "SIGKILL" : "SIGTERM");
      if (!force) {
        const forceTimer = setTimeout(() => { if (!finished) killTree("SIGKILL"); }, 2500);
        forceTimer.unref?.();
      }
    };

    const schedulePostSettleReap = () => {
      if (settleTimer || finished) return;
      const grace = Math.max(500, options.settleGraceMs ?? 8000);
      settleTimer = setTimeout(() => {
        if (finished) return;
        reapedAfterSettle = true;
        terminate(false);
      }, grace);
      settleTimer.unref?.();
    };

    const processLine = (line: string) => {
      if (!line.trim()) return;
      let event: any;
      try { event = JSON.parse(line); } catch { return; }

      if (event.type === "message_end" && event.message) {
        const message = event.message;
        const text = textFromMessage(message);
        if (text) {
          texts.push(text);
          options.onProgress?.(text.slice(-800));
        }
        if (message.role === "assistant") {
          result.usage.turns += 1;
          const usage = message.usage ?? {};
          result.usage.input += usage.input ?? 0;
          result.usage.output += usage.output ?? 0;
          result.usage.cacheRead += usage.cacheRead ?? 0;
          result.usage.cacheWrite += usage.cacheWrite ?? 0;
          result.usage.cost += usage.cost?.total ?? 0;
          result.usage.contextTokens = Math.max(result.usage.contextTokens, usage.totalTokens ?? 0);
          result.stopReason = message.stopReason ?? result.stopReason;
          result.errorMessage = message.errorMessage ?? result.errorMessage;
        }
      }

      if (event.type === "agent_settled") {
        settled = true;
        schedulePostSettleReap();
      }
    };

    proc.stdout.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) processLine(line);
    });
    proc.stderr.on("data", (data) => { result.stderr += data.toString(); });
    proc.on("error", (error) => {
      result.stderr += `${error.message}\n`;
      finish(1);
    });
    proc.on("close", (code) => {
      // A worker deliberately reaped after agent_settled is complete, not failed.
      const normalized = reapedAfterSettle && settled && result.stopReason !== "error" ? 0 : (code ?? 0);
      finish(normalized);
    });

    const hardTimeout = Math.max(10_000, options.timeoutMs ?? 10 * 60 * 1000);
    hardTimer = setTimeout(() => {
      if (finished) return;
      result.timedOut = true;
      terminate(false);
    }, hardTimeout);
    hardTimer.unref?.();

    if (options.signal) {
      const kill = () => {
        if (finished) return;
        result.aborted = true;
        terminate(false);
      };
      if (options.signal.aborted) kill();
      else options.signal.addEventListener("abort", kill, { once: true });
    }
  });
}

/**
 * Run one isolated Pi worker in JSON/print mode.
 *
 * The official subagent example shells out to a separate `pi` process. We add three
 * layers of defensive orchestration: per-attempt hard timeouts, post-agent_settled
 * reaping (a third-party child extension with a referenced Node handle cannot keep a
 * settled one-shot worker alive), and bounded retry on transient *provider* errors -
 * a 429/504 from the free NVIDIA tier is an infrastructure hiccup, not a task bug,
 * so it must NOT feed the failure-repair pipeline.
 */
export async function runPiAgent(options: RunAgentOptions): Promise<AgentRunResult> {
  const tmp = await tempSystemPrompt(options.role, options.systemPrompt);
  const args = ["--mode", "json", "-p", "--no-session", "--model", options.model];
  if (options.thinking) args.push("--thinking", options.thinking);
  if (options.tools.length) args.push("--tools", options.tools.join(","));
  args.push("--append-system-prompt", tmp.file);
  args.push(`Task: ${options.task}`);

  const result: AgentRunResult = {
    role: options.role,
    task: options.task,
    model: options.model,
    modelTier: options.modelTier,
    exitCode: 1,
    output: "",
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
  };

  const maxAttempts = 1 + Math.max(0, Math.min(options.maxRetries ?? 3, 8));
  // Exponential backoff: base × 2^(attempt-1). Default base=10s → 10,20,40,80,160s
  const baseDelay = Math.max(1000, options.retryDelayMs ?? 10000);
  const customDelays = Array.from({ length: maxAttempts - 1 }, (_, i) => baseDelay * Math.pow(2, i));

  try {
    const invocation = options.piInvocation
      ? { command: options.piInvocation.command, args: [...options.piInvocation.args, ...args] }
      : getPiInvocation(args);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (options.signal?.aborted) { result.stopReason = "aborted"; break; }
      const ar = await spawnOnce(invocation, options);

      result.exitCode = ar.exitCode;
      result.output = ar.output;
      result.stderr = ar.stderr;
      result.stopReason = ar.stopReason;
      result.errorMessage = ar.errorMessage;
      result.usage.input += ar.usage.input;
      result.usage.output += ar.usage.output;
      result.usage.cacheRead += ar.usage.cacheRead;
      result.usage.cacheWrite += ar.usage.cacheWrite;
      result.usage.cost += ar.usage.cost;
      result.usage.contextTokens = Math.max(result.usage.contextTokens, ar.usage.contextTokens);
      result.usage.turns += ar.usage.turns;

      if (ar.aborted) {
        result.stopReason = "aborted";
        result.errorMessage = "Agent run aborted";
        break;
      }
      if (ar.timedOut) {
        result.stopReason = "error";
        result.errorMessage = `Agent run exceeded timeout (${options.timeoutMs ?? 10 * 60 * 1000} ms)`;
        result.exitCode = 124;
        break;                                   // a timeout is not transient here
      }
      if (ar.exitCode === 0) break;
      if (!isTransient(ar)) break;
      if (attempt >= maxAttempts) break;

      const delay = customDelays[attempt - 1] ?? customDelays[customDelays.length - 1];
      const msg = `transient provider error (exit ${ar.exitCode}); retry ${attempt}/${maxAttempts - 1} in ${Math.round(delay / 1000)}s (delays: ${customDelays.map(d => Math.round(d/1000)).join('s, ')}s)`;
      options.onProgress?.(msg);
      console.error(`[RETRY ${attempt}/${maxAttempts - 1}] ${msg}`);
      await sleep(delay);
    }
    return result;
  } finally {
    try { fs.unlinkSync(tmp.file); } catch { /* noop */ }
    try { fs.rmdirSync(tmp.dir); } catch { /* noop */ }
  }
}
