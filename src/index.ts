import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { GoalOrchestrator } from "./orchestrator.ts";
import { loadConfig, loadTools, saveConfig, saveTools, setConfigPath } from "./config.ts";
import { executableExists } from "./checks.ts";
import { compactGoalSummary } from "./context.ts";
import { loadRules, pathsFor, saveGoal, appendEvent } from "./store.ts";
import { pruneToolContext } from "./context-pruner.ts";

let activeController: AbortController | null = null;
let activeRun: Promise<unknown> | null = null;

function fmtGraph(goal: ReturnType<GoalOrchestrator["getActiveGoal"]>): string {
  if (!goal) return "No active goal.";
  const lines = [`${goal.id} [${goal.status}]`, goal.immutableObjective, ""];
  for (const t of goal.tasks) {
    const deps = t.dependencies.length ? ` <- ${t.dependencies.join(",")}` : "";
    lines.push(`${t.status === "completed" ? "✓" : t.status === "running" ? "▶" : t.status === "failed" || t.status === "blocked" ? "✗" : "○"} ${t.id} [${t.role}/${t.mode}] ${t.title}${deps}`);
  }
  return lines.join("\n");
}

function notifyGoalResult(ui: ExtensionCommandContext["ui"], goal: { status?: string; blockedReason?: string } | null | undefined, bg: boolean): void {
  const suffix = bg ? " (background)" : "";
  if (goal?.status === "completed") ui.notify(`Goal verified complete.${suffix}`, "info");
  else if (goal?.status === "blocked") ui.notify(`Goal blocked: ${goal.blockedReason ?? "see /goal-status"}`, "warning");
  else if (goal?.status === "failed") ui.notify(`Goal failed: ${goal.blockedReason ?? "see /goal-status"}`, "error");
  else if (goal?.status === "cancelled") ui.notify("Goal was stopped by user.", "info");
  else if (goal?.status === "aborted") ui.notify("Goal workers were killed.", "warning");
  else if (goal?.status === "paused") ui.notify("Goal paused.", "warning");
}

async function runInForeground(orchestrator: GoalOrchestrator, operation: (signal: AbortSignal) => Promise<any>, ui: ExtensionCommandContext["ui"]): Promise<void> {
  if (activeRun) {
    ui.notify("A goal run is already active. Use /goal-status or /goal-pause.", "warning");
    return;
  }
  const controller = new AbortController();
  activeController = controller;
  const signal = controller.signal;
  const run = operation(signal);
  activeRun = run;
  try {
    const goal = await run;
    notifyGoalResult(ui, goal, false);
  } catch (err) {
    ui.notify(`Goal run error: ${err}`, "error");
  } finally {
    // Only clear globals if they're still ours (prevents a slow-settling old run from wiping a new one).
    if (activeRun === run) activeRun = null;
    if (activeController === controller) activeController = null;
  }
}

function runInBackground(orchestrator: GoalOrchestrator, operation: (signal: AbortSignal) => Promise<any>, ui: ExtensionCommandContext["ui"]): void {
  if (activeRun) {
    ui.notify("A goal run is already active. Use /goal-status or /goal-pause.", "warning");
    return;
  }
  const controller = new AbortController();
  activeController = controller;
  const signal = controller.signal;
  const run = operation(signal);
  activeRun = run;
  run
    .then((goal) => notifyGoalResult(ui, goal, true))
    .catch((err) => ui.notify(`Goal run error: ${err}`, "error"))
    .finally(() => {
      if (activeRun === run) activeRun = null;
      if (activeController === controller) activeController = null;
    });
}

export default function (pi: ExtensionAPI) {
  // Child Pi processes are isolated workers. They only load the reversible context pruner;
  // orchestration commands stay in the parent process.
  if (process.env.PI_AUTOGRAPH_CHILD === "1" || process.env.PI_GOAL_GRAPH_CHILD === "1") {
    pi.on("context", async (event, ctx) => {
      try {
        const config = loadConfig(pathsFor(ctx.cwd).configFile);
        if (!config.context.reversibleArchive) return;
        const usage = ctx.getContextUsage?.();
        const pruned = pruneToolContext(ctx.cwd, event.messages ?? [], config, usage?.percent ?? null);
        if (pruned.stats.prunedMessages === 0) return;
        return { messages: pruned.messages };
      } catch {
        return;
      }
    });
    return;
  }

  pi.on("session_start", async (_event, ctx) => {
    const o = new GoalOrchestrator(ctx.cwd);
    const goal = o.getActiveGoal();
    if (goal && goal.status !== "completed" && goal.status !== "cancelled" && goal.status !== "aborted") {
      ctx.ui.setStatus("goal-graph", `goal:${goal.status}`);
    }
  });

  pi.on("session_shutdown", async () => {
    activeController?.abort();
  });

  function make(cwd: string, ctx: ExtensionCommandContext) {
    return new GoalOrchestrator(cwd, {
      notify: (message: string, level?: "info" | "success" | "warning" | "error") => {
        const mapped = level === "success" ? "info" : level;
        ctx.ui.notify(message, mapped);
      },
      status: (message: string | null) => ctx.ui.setStatus("goal-graph", message ?? undefined),
      log: (message: string) => {
        if (ctx.hasUI) ctx.ui.notify(message, "info");
      },
      grill: async (objective: string): Promise<string | null> => {
        if (!ctx.hasUI) return objective;
        const start = await ctx.ui.confirm("Grill Me: an agent will inspect the goal and ambiguity to ask questions. Proceed?", objective);
        if (!start) return null;
        // Spawn Pi subagents to find ambiguities using the same runPiAgent that orchestrator uses
        const { runPiAgent } = await import("./pi-runner.ts");
        const { pathsFor } = await import("./store.ts");
        const cfg = loadConfig(pathsFor(ctx.cwd).configFile);
        
        const dialogue: Array<{ q: string; a: string }> = [];
        let refined = objective;
        for (let round = 0; round < 6; round++) {
          const prompt = dialogue.length
            ? `Goal:\n${refined}\n\nDialogue:\n${dialogue.map((d) => `Q: ${d.q}\nA: ${d.a}`).join("\n\n")}`
            : `Goal:\n${refined}`;
          const result = await runPiAgent({
            cwd: ctx.cwd,
            role: "planner",
            task: prompt + "\n\nFind one material ambiguity. Output exactly one short question, or DONE.",
            systemPrompt: "You are a Grilling agent. Surface every material unresolved decision. If none, output DONE. Otherwise, one short question.",
            model: cfg.models.default,
            modelTier: "super",
            tools: [],
            timeoutMs: 30000,
            piInvocation: (process.env.PI_AUTOGRAPH_FAKE_PI || process.env.PI_GOAL_GRAPH_FAKE_PI) ? { command: process.execPath, args: [(process.env.PI_AUTOGRAPH_FAKE_PI || process.env.PI_GOAL_GRAPH_FAKE_PI)!] } : undefined,
          });
          const out = result.output.trim();
          if (out === "DONE" || out.startsWith("DONE")) break;
          const answer = await ctx.ui.input(out, "Type your answer (or leave empty to stop)");
          if (answer === undefined) return null;
          const a = answer.trim();
          if (!a) break;
          dialogue.push({ q: out, a });
          refined += `\nResolved: ${out} → ${a}`;
        }
        const ok = await ctx.ui.confirm("Freeze Goal Contract and start planning?", refined);
        if (!ok) return null;
        return refined;
      },
    });
  }

  async function startGoal(ctx: ExtensionCommandContext, objective: string, background: boolean): Promise<void> {
    // Auto-launch /goal-init once per project when config has never been saved.
    const p = pathsFor(ctx.cwd);
    const cfg = loadConfig(p.configFile);
    if (!fs.existsSync(p.configFile) && ctx.hasUI) {
      const runSetup = await ctx.ui.confirm("First run — run Setup wizard now?", "Configure Laya, models, and tools before starting the goal.");
      if (runSetup) {
        await setupWizard(ctx);
        // Reload after setup
        const fresh = loadConfig(p.configFile);
        if (fresh.decisionEngine.provider === "heuristic" || fresh.decisionEngine.provider === "laya-placeholder") {
          ctx.ui.notify("Using heuristics for task routing. Run /goal-init to configure Laya later.", "info");
        }
      }
    }
    const o = make(ctx.cwd, ctx);
    if (background) {
      runInBackground(o, (signal) => o.start(objective, signal), ctx.ui);
      ctx.ui.notify("Goal Graph started in background. Use /goal-status to inspect it.", "info");
    } else {
      await runInForeground(o, (signal) => o.start(objective, signal), ctx.ui);
    }
  }

  async function setupWizard(ctx: ExtensionCommandContext): Promise<void> {
    const p = pathsFor(ctx.cwd);
    const config = loadConfig(p.configFile);
    const tools = loadTools(p.toolsFile);

    if (!ctx.hasUI) return;
    const provider = await ctx.ui.select("Laya decision engine?", [
      "heuristic (instant, recommended default)",
      "laya-local (public Space: convaiinnovations-laya-demo)",
      "laya-hf (self-hosted/duplicate Gradio Space)",
      "laya-placeholder (legacy alias for heuristic)",
    ]);
    if (provider) {
      if (provider.startsWith("laya-local")) {
        config.decisionEngine.provider = "laya-local";
      } else if (provider.startsWith("laya-hf")) {
        config.decisionEngine.provider = "laya-hf";
        const space = await ctx.ui.input("Laya Space URL", "https://convaiinnovations-laya-demo.hf.space");
        if (space !== undefined) config.decisionEngine.layaSpaceUrl = space;
        const token = await ctx.ui.input("HF token (optional, for private Spaces)", "");
        if (token !== undefined) config.decisionEngine.layaHFToken = token;
      } else if (provider.startsWith("laya-placeholder")) {
        config.decisionEngine.provider = "laya-placeholder";
      } else {
        config.decisionEngine.provider = "heuristic";
      }
    }

    const threshold = await ctx.ui.input("Low-confidence escalation threshold (0.5-0.95)", String(config.decisionEngine.confidenceEscalationThreshold));
    if (threshold !== undefined) {
      const n = Number(threshold);
      if (Number.isFinite(n) && n > 0 && n < 1) config.decisionEngine.confidenceEscalationThreshold = n;
    }

    const lines: string[] = ["=== Goal Graph Setup ===", "", "Models:", `  default: ${config.models.default}`, `  escalation: ${config.models.escalation}`, "", `Decision engine: ${config.decisionEngine.provider} (escalate below confidence ${config.decisionEngine.confidenceEscalationThreshold})`, ""];
    lines.push("External review tools:");
    for (const [name, tool] of Object.entries(tools)) {
      const found = await executableExists(tool.executable, ctx.cwd).catch(() => false);
      lines.push(`  ${name}: ${tool.status} | ${found ? "installed" : "not found (will skip)"}`);
    }
    ctx.ui.notify(lines.join("\n"), "info");

    saveConfig(p.configFile, config);
    saveTools(p.toolsFile, tools);
    ctx.ui.notify("Configuration saved.", "info");
  }

  pi.registerCommand("goal", {
    description: "Confirm and start an autonomous graph goal in foreground: /goal <objective>",
    handler: async (args, ctx) => {
      const objective = args.trim();
      if (!objective) { ctx.ui.notify("Usage: /goal <objective>", "warning"); return; }
      const ok = ctx.hasUI ? await ctx.ui.confirm("Start Goal Graph?", objective) : true;
      if (!ok) return;
      await startGoal(ctx, objective, false);
    },
  });

  pi.registerCommand("goal-direct", {
    description: "Skip confirmation; start an autonomous graph goal in foreground: /goal-direct <objective>",
    handler: async (args, ctx) => {
      const objective = args.trim();
      if (!objective) { ctx.ui.notify("Usage: /goal-direct <objective>", "warning"); return; }
      await startGoal(ctx, objective, false);
    },
  });

  pi.registerCommand("goal-bg", {
    description: "Start an autonomous graph goal in background: /goal-bg <objective>",
    handler: async (args, ctx) => {
      const objective = args.trim();
      if (!objective) { ctx.ui.notify("Usage: /goal-bg <objective>", "warning"); return; }
      const ok = ctx.hasUI ? await ctx.ui.confirm("Start Goal Graph in background?", objective) : true;
      if (!ok) return;
      await startGoal(ctx, objective, true);
    },
  });

  pi.registerCommand("goal-status", {
    description: "Show the active goal, task counts, criteria, and blocker",
    handler: async (_args, ctx) => {
      const o = make(ctx.cwd, ctx);
      const goal = o.getActiveGoal();
      if (!goal) { ctx.ui.notify("No active goal.", "info"); return; }
      const detail = [compactGoalSummary(ctx.cwd, goal), goal.blockedReason ? `Blocked reason: ${goal.blockedReason}` : "", `Run process: ${activeRun ? "active" : "not active"}`].filter(Boolean).join("\n");
      const isProblem = goal.status === "blocked" || goal.status === "failed";
      ctx.ui.notify(detail, isProblem ? "warning" : "info");
    },
  });

  pi.registerCommand("goal-graph", {
    description: "Display the current task DAG and states",
    handler: async (_args, ctx) => {
      const o = make(ctx.cwd, ctx);
      ctx.ui.notify(fmtGraph(o.getActiveGoal()), "info");
    },
  });

  pi.registerCommand("goal-pause", {
    description: "Pause the currently running goal after aborting active subagents",
    handler: async (_args, ctx) => {
      if (!activeController) { ctx.ui.notify("No in-process goal run is active.", "info"); return; }
      activeController.abort();
      ctx.ui.notify("Pause requested. Active subagents are being stopped and state will remain on disk.", "warning");
    },
  });

  pi.registerCommand("goal-resume", {
    description: "Resume the persisted active goal (foreground)",
    handler: async (_args, ctx) => {
      const o = make(ctx.cwd, ctx);
      const goal = o.getActiveGoal();
      if (!goal) { ctx.ui.notify("No persisted goal to resume.", "warning"); return; }
      if (goal.status === "completed") { ctx.ui.notify("The active goal is already completed.", "info"); return; }
      if (goal.status === "cancelled" || goal.status === "aborted") {
        ctx.ui.notify(`Goal ${goal.id} was ${goal.status} and cannot be resumed. Start a new goal with /goal.`, "warning");
        return;
      }
      await runInForeground(o, (signal) => o.resume(signal), ctx.ui);
    },
  });

  pi.registerCommand("goal-stop", {
    description: "Gracefully stop the active goal permanently (terminal: cancelled)",
    handler: async (_args, ctx) => {
      const o = make(ctx.cwd, ctx);
      const goal = o.getActiveGoal();
      if (!goal) { ctx.ui.notify("No active goal to stop.", "warning"); return; }
      if (["completed", "cancelled", "aborted"].includes(goal.status)) {
        ctx.ui.notify(`Goal already ${goal.status}.`, "info");
        return;
      }
      // Abort in-flight workers so the orchestrator catches the signal and pauses cleanly,
      // then mark the goal as terminal-cancelled.
      if (activeController) {
        activeController.abort();
        try { await activeRun; } catch { /* ignore */ }
      }
      goal.status = "cancelled";
      goal.blockedReason = "Stopped by user";
      saveGoal(ctx.cwd, goal);
      appendEvent(ctx.cwd, goal.id, "stopped_by_user", {});
      ctx.ui.notify(`Goal ${goal.id} cancelled (permanent).`, "info");
    },
  });

  pi.registerCommand("goal-kill", {
    description: "Immediately kill all goal workers and mark the goal aborted",
    handler: async (_args, ctx) => {
      if (!activeController && !activeRun) {
        ctx.ui.notify("No active goal run to kill.", "info");
        return;
      }
      const controller = activeController;
      const run = activeRun;
      if (controller) controller.abort();
      // Wait for the run promise to settle; if it hangs, we still mark the goal aborted.
      if (run) {
        try { await Promise.race([run, new Promise(r => setTimeout(r, 5000))]); } catch { /* ignore */ }
      }
      const o = make(ctx.cwd, ctx);
      const goal = o.getActiveGoal();
      if (goal && goal.status !== "completed") {
        goal.status = "aborted";
        goal.blockedReason = "Killed by user";
        saveGoal(ctx.cwd, goal);
        appendEvent(ctx.cwd, goal.id, "killed_by_user", {});
      }
      // Only clear globals that still reference this kill's run/controller.
      if (activeRun === run) activeRun = null;
      if (activeController === controller) activeController = null;
      ctx.ui.notify("All goal workers killed.", "warning");
    },
  });

  pi.registerCommand("goal-config", {
    description: "Show or change config: /goal-config [set dotted.key value]",
    handler: async (args, ctx) => {
      const p = pathsFor(ctx.cwd);
      let config = loadConfig(p.configFile);
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      if (!tokens.length) { ctx.ui.notify(JSON.stringify(config, null, 2), "info"); return; }
      if (tokens[0] !== "set" || tokens.length < 3) {
        ctx.ui.notify("Usage: /goal-config set <dotted.key> <value>", "warning");
        return;
      }
      try {
        config = setConfigPath(config, tokens[1], tokens.slice(2).join(" "));
        saveConfig(p.configFile, config);
        ctx.ui.notify(`Updated ${tokens[1]}.`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("goal-tools", {
    description: "Inspect/approve optional external reviewers: /goal-tools [approve|disable] <semgrep|osv-scanner|opencode-review>",
    handler: async (args, ctx) => {
      const p = pathsFor(ctx.cwd);
      const tools = loadTools(p.toolsFile);
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      if (!tokens.length) {
        const rows: string[] = [];
        for (const [name, tool] of Object.entries(tools)) {
          const found = await executableExists(tool.executable, ctx.cwd);
          rows.push(`${name}: ${tool.status}; executable=${tool.executable}; installed=${found}; network=${tool.network ?? "unknown"}`);
        }
        ctx.ui.notify(rows.join("\n"), "info");
        return;
      }
      const [action, name] = tokens;
      if (!(name in tools) || !["approve", "disable"].includes(action)) {
        ctx.ui.notify("Usage: /goal-tools [approve|disable] <semgrep|osv-scanner|opencode-review>", "warning");
        return;
      }
      const key = name as keyof typeof tools;
      if (action === "approve") {
        const t = tools[key];
        const found = await executableExists(t.executable, ctx.cwd);
        const ok = ctx.hasUI ? await ctx.ui.confirm(`Approve ${name}?`, `Executable: ${t.executable}\nInstalled: ${found}\nNetwork: ${t.network ?? "unknown"}\n\nThis only enables use; Goal Graph will never install it.`) : true;
        if (!ok) return;
        t.status = "approved";
      } else tools[key].status = "disabled";
      saveTools(p.toolsFile, tools);
      ctx.ui.notify(`${name}: ${tools[key].status}`, "info");
    },
  });

  pi.registerCommand("goal-init", {
    description: "First-run setup: choose Laya provider, verify tools, save configuration",
    handler: async (_args, ctx) => {
      await setupWizard(ctx);
    },
  });

pi.registerCommand("goal-memory", {
    description: "Inspect learned project/candidate/global rules",
    handler: async (_args, ctx) => {
      const p = pathsFor(ctx.cwd);
      const sections = [
        ["PROJECT", loadRules(p.projectRulesFile)],
        ["CANDIDATE GLOBAL", loadRules(p.globalCandidateRulesFile)],
        ["ACTIVE GLOBAL", loadRules(p.globalRulesFile)],
      ] as const;
      const text = sections.map(([label, rules]) => `${label} (${rules.length})\n${rules.length ? rules.map((r) => `- [${r.status} conf=${r.confidence.toFixed(2)} ok=${r.successfulUses} fail=${r.failedUses} evidence=${r.evidenceCount} projects=${r.projectsSeen.length}] ${r.text}`).join("\n") : "- none"}`).join("\n\n");
      ctx.ui.notify(text, "info");
    },
  });
}
