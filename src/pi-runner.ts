import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentRole, AgentRunResult, ModelTier } from "./types.ts";

function getPiInvocation(args: string[]): { command: string; args: string[] } {
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
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-goal-graph-"));
  const file = path.join(dir, `${role.replace(/[^a-z0-9_-]/gi, "_")}.md`);
  await fs.promises.writeFile(file, text, { encoding: "utf8", mode: 0o600 });
  return { dir, file };
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
  goalId?: string;
  onProgress?: (message: string) => void;
}

/**
 * Run one isolated Pi worker in JSON/print mode.
 *
 * Pi's official subagent example also shells out to a separate `pi` process.  We add two
 * bits of defensive orchestration here: a hard runtime timeout and post-agent_settled
 * reaping.  The latter prevents a third-party child extension with a referenced Node
 * handle from keeping an already-completed one-shot worker alive indefinitely.
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

  try {
    const invocation = getPiInvocation(args);
    let aborted = false;
    let timedOut = false;
    let settled = false;
    let reapedAfterSettle = false;

    result.exitCode = await new Promise<number>((resolve) => {
      const proc = spawn(invocation.command, invocation.args, {
        cwd: options.cwd,
        shell: false,
        // On POSIX put each worker in its own process group so a leaked descendant
        // cannot keep JSON stdout/stderr pipes open after the Pi worker is settled.
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          PI_GOAL_GRAPH_CHILD: "1",
          PI_GOAL_GRAPH_GOAL_ID: options.goalId ?? "",
        },
      });

      let buffer = "";
      const texts: string[] = [];
      let finished = false;
      let settleTimer: ReturnType<typeof setTimeout> | undefined;
      let hardTimer: ReturnType<typeof setTimeout> | undefined;

      const finish = (code: number) => {
        if (finished) return;
        finished = true;
        if (settleTimer) clearTimeout(settleTimer);
        if (hardTimer) clearTimeout(hardTimer);
        if (buffer.trim()) processLine(buffer);
        result.output = texts.join("\n\n").trim();
        resolve(code);
      };

      const killTree = (signal: "SIGTERM" | "SIGKILL") => {
        try {
          if (process.platform !== "win32" && proc.pid) {
            // Negative PID addresses the detached process group.
            process.kill(-proc.pid, signal);
          } else {
            proc.kill(signal);
          }
        } catch { /* process may already be gone */ }
      };

      const terminate = (force = false) => {
        killTree(force ? "SIGKILL" : "SIGTERM");
        if (!force) {
          const forceTimer = setTimeout(() => {
            if (!finished) killTree("SIGKILL");
          }, 2500);
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
            if (message.model) result.model = message.model;
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
        timedOut = true;
        terminate(false);
      }, hardTimeout);
      hardTimer.unref?.();

      if (options.signal) {
        const kill = () => {
          if (finished) return;
          aborted = true;
          terminate(false);
        };
        if (options.signal.aborted) kill();
        else options.signal.addEventListener("abort", kill, { once: true });
      }
    });

    if (aborted) {
      result.stopReason = "aborted";
      result.errorMessage = "Agent run aborted";
    } else if (timedOut) {
      result.stopReason = "error";
      result.errorMessage = `Agent run exceeded timeout (${options.timeoutMs ?? 10 * 60 * 1000} ms)`;
      result.exitCode = 124;
    }
    return result;
  } finally {
    try { fs.unlinkSync(tmp.file); } catch { /* noop */ }
    try { fs.rmdirSync(tmp.dir); } catch { /* noop */ }
  }
}
