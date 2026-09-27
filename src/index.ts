import * as fs from "node:fs";
// Pi extension types (peer dependency - types not available at compile time)
interface ExtensionAPI {
  registerCommand(name: string, def: { description: string; handler: (args: string, ctx: CommandContext) => Promise<void> }): void;
  on(event: string, handler: (event: any, ctx: any) => Promise<any>): void;
}
interface CommandContext {
  cwd: string;
  ui: { notify(msg: string, level?: string): void; confirm(msg: string, detail?: string): Promise<boolean>; select(msg: string, options: Array<{ name: string; value: string }>): Promise<string | undefined>; hasUI: boolean; setStatus?(key: string, msg?: string): void };
  hasUI: boolean;
}
import { GoalOrchestrator } from "./orchestrator.ts";
import { loadConfig, loadTools, saveConfig, saveTools, setConfigPath } from "./config.ts";
import { executableExists } from "./checks.ts";
import { compactGoalSummary } from "./context.ts";
import { loadRules, pathsFor, saveGoal, appendEvent } from "./store.ts";
import { pruneToolContext } from "./context-pruner.ts";
import type { GoalContract } from "./types.ts";

let activeController: AbortController | null = null;
let activeRun: Promise<void> | null = null;

function fmtGraph(goal: ReturnType<GoalOrchestrator["getActiveGoal"]>): string {
  if (!goal) return "No active goal.";
  const lines = [`${goal.id} [${goal.status}]`, goal.immutableObjective, ""];
  for (const t of goal.tasks) {
    const deps = t.dependencies.length ? ` <- ${t.dependencies.join(",")}` : "";
    lines.push(`${t.status === "completed" ? "✓" : t.status === "running" ? "▶" : t.status === "failed" || t.status === "blocked" ? "✗" : "○"} ${t.id} [${t.role}/${t.mode}] ${t.title}${deps}`);
  }
  return lines.join("\n");
}

async function runInForeground(orchestrator: GoalOrchestrator, operation: (signal: AbortSignal) => Promise<any>, ui: any): Promise<void> {
  if (activeRun) {
    ui.notify("A goal run is already active. Use /goal-status or /goal-pause.", "warning");
    return;
  }
  activeController = new AbortController();
  const signal = activeController.signal;
  activeRun = operation(signal)
    .then((goal) => {
      if (goal?.status === "completed") ui.notify("Goal verified complete.", "success");
      else if (goal?.status === "blocked") ui.notify(`Goal blocked: ${goal.blockedReason ?? "see /goal-status"}`, "warning");
      else if (goal?.status === "failed") ui.notify(`Goal failed: ${goal.blockedReason ?? "see /goal-status"}`, "error");
      else if (goal?.status === "paused") ui.notify("Goal paused.", "warning");
      activeRun = null;
      activeController = null;
    })
    .catch((err) => {
      ui.notify(`Goal run error: ${err}`, "error");
      activeRun = null;
      activeController = null;
    });
  await activeRun;
}

async function runInBackground(orchestrator: GoalOrchestrator, operation: (signal: AbortSignal) => Promise<any>, ui: any): Promise<void> {
  if (activeRun) {
    ui.notify("A goal run is already active. Use /goal-status or /goal-pause.", "warning");
    return;
  }
  activeController = new AbortController();
  const signal = activeController.signal;
  activeRun = operation(signal)
    .then((goal) => {
      if (goal?.status === "completed") ui.notify("Goal completed (background).", "success");
      else if (goal?.status === "blocked") ui.notify(`Goal blocked: ${goal.blockedReason ?? "see /goal-status"}`, "warning");
      else if (goal?.status === "failed") ui.notify(`Goal failed: ${goal.blockedReason ?? "see /goal-status"}`, "error");
      else if (goal?.status === "paused") ui.notify("Goal paused.", "warning");
      activeRun = null;
      activeController = null;
    })
    .catch((err) => {
      ui.notify(`Goal run error: ${err}`, "error");
      activeRun = null;
      activeController = null;
    });
}

async function promptRunMode(ui: any, defaultToForeground: boolean = true): Promise<"foreground" | "background"> {
  if (!ui.hasUI) return defaultToForeground ? "foreground" : "background";
  const choice = await ui.select("Run mode?", [
    { name: "Foreground (see live progress)", value: "foreground" },
    { name: "Background (run in background)", value: "background" },
  ]);
  return choice || (defaultToForeground ? "foreground" : "background");
}

async function runWithMode(orchestrator: GoalOrchestrator, operation: (signal: AbortSignal) => Promise<any>, ui: any, mode: "foreground" | "background"): Promise<void> {
  if (mode === "foreground") {
    await runInForeground(orchestrator, operation, ui);
  } else {
    runInBackground(orchestrator, operation, ui);
  }
}

export default function (pi: ExtensionAPI) {
  // Child Pi processes are isolated workers. They only load the reversible context pruner;
  // orchestration commands stay in the parent process.
  if (process.env.PI_AUTOGRAPH_CHILD === "1") {
    pi.on("context", async (event: any, ctx: any) => {
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
    if (goal && goal.status !== "completed") ctx.ui.setStatus("goal-graph", `goal:${goal.status}`);
  });

  pi.on("session_shutdown", async () => {
    activeController?.abort();
  });

  function make(cwd: string, ui: any) {
    return new GoalOrchestrator(cwd, {
      notify: (message: string, level?: "info" | "success" | "warning" | "error") => ui.notify(message, level),
      status: (message: string | null) => ui.setStatus?.("goal-graph", message ?? undefined),
      grill: async (objective: string) => {
        if (!ui.hasUI) return objective;
        const confirmed = await ui.confirm("Grill Me: Resolve ambiguities before planning?", objective);
        if (!confirmed) return null;
        const refined = await ui.input("Refined objective (press Enter to keep as-is):", objective);
        return refined?.trim() || objective;
      },
    });
  }

  pi.registerCommand("goal-direct", {
    description: "Start an autonomous graph goal immediately: /goal-direct <objective>",
    handler: async (args, ctx) => {
      const objective = args.trim();
      if (!objective) { ctx.ui.notify("Usage: /goal-direct <objective>", "warning"); return; }
      const o = make(ctx.cwd, ctx.ui);
      // Default to foreground (no prompt)
      await runInForeground(o, (signal) => o.start(objective, signal), ctx.ui);
      ctx.ui.notify("Goal Graph started in foreground. Use /goal-status to inspect progress.", "info");
    },
  });

  pi.registerCommand("goal", {
    description: "Confirm and start an autonomous graph goal: /goal <objective>",
    handler: async (args, ctx) => {
      const objective = args.trim();
      if (!objective) { ctx.ui.notify("Usage: /goal <objective>", "warning"); return; }
      const ok = ctx.hasUI ? await ctx.ui.confirm("Start Goal Graph?", objective) : true;
      if (!ok) return;
      const o = make(ctx.cwd, ctx.ui);
      // Default to foreground (no prompt)
      await runInForeground(o, (signal) => o.start(objective, signal), ctx.ui);
      ctx.ui.notify("Goal Graph started in foreground. Use /goal-status to inspect progress.", "info");
    },
  });

  pi.registerCommand("goal-status", {
    description: "Show the active goal, task counts, criteria, and blocker",
    handler: async (_args, ctx) => {
      const o = make(ctx.cwd, ctx.ui);
      const goal = o.getActiveGoal();
      if (!goal) { ctx.ui.notify("No active goal.", "info"); return; }
      const detail = [compactGoalSummary(goal), goal.blockedReason ? `Blocked reason: ${goal.blockedReason}` : "", `Run process: ${activeRun ? "active" : "not active"}`].filter(Boolean).join("\n");
      ctx.ui.notify(detail, goal.status === "blocked" || goal.status === "failed" ? "warning" : "info");
    },
  });

  pi.registerCommand("goal-graph", {
    description: "Display the current task DAG and states",
    handler: async (_args, ctx) => {
      const o = make(ctx.cwd, ctx.ui);
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
    description: "Resume the persisted active goal",
    handler: async (_args, ctx) => {
      const o = make(ctx.cwd, ctx.ui);
      const goal = o.getActiveGoal();
      if (!goal) { ctx.ui.notify("No persisted goal to resume.", "warning"); return; }
      if (goal.status === "completed") { ctx.ui.notify("The active goal is already completed.", "info"); return; }
      // Default to foreground (no prompt)
      await runInForeground(o, (signal) => o.resume(signal), ctx.ui);
      ctx.ui.notify(`Resuming ${goal.id}.`, "info");
    },
  });

  pi.registerCommand("goal-stop", {
    description: "Permanently stop the active goal gracefully (marks as failed, non-resumable)",
    handler: async (_args, ctx) => {
      const o = make(ctx.cwd, ctx.ui);
      const goal = o.getActiveGoal();
      if (!goal) { ctx.ui.notify("No active goal to stop.", "warning"); return; }
      if (goal.status === "completed") { ctx.ui.notify("Goal already completed.", "info"); return; }
      
      // Abort any running process first
      if (activeController) {
        activeController.abort();
        // Wait for the run to settle (it will catch abort and mark paused)
        if (activeRun) {
          try { await activeRun; } catch { /* ignore */ }
        }
      }
      
      // Mark goal as permanently stopped (failed, non-resumable)
      goal.status = "failed";
      goal.blockedReason = "Stopped by user";
      saveGoal(ctx.cwd, goal);
      appendEvent(ctx.cwd, goal.id, "stopped_by_user", {});
      ctx.ui.notify(`Goal ${goal.id} stopped permanently.`, "info");
    },
  });

  pi.registerCommand("goal-kill", {
    description: "Immediately terminate all goal workers and abort (force kill)",
    handler: async (_args, ctx) => {
      if (!activeController && !activeRun) { 
        ctx.ui.notify("No active goal run to kill.", "info"); 
        return; 
      }
      
      // Abort and force-kill: pi-runner will kill child processes on abort
      if (activeController) {
        activeController.abort();
      }
      
      // Wait briefly for run to settle, then force reset
      if (activeRun) {
        try {
          await Promise.race([activeRun, new Promise(r => setTimeout(r, 3000))]);
        } catch { /* ignore */ }
      }
      
      // Mark goal as killed if exists
      const o = make(ctx.cwd, ctx.ui);
      const goal = o.getActiveGoal();
      if (goal && goal.status !== "completed") {
        goal.status = "failed";
        goal.blockedReason = "Killed by user";
        saveGoal(ctx.cwd, goal);
        appendEvent(ctx.cwd, goal.id, "killed_by_user", {});
      }
      
      // Force reset state
      activeRun = null;
      activeController = new AbortController();
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
        ctx.ui.notify(`Updated ${tokens[1]}.`, "success");
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
      ctx.ui.notify(`${name}: ${tools[key].status}`, "success");
    },
  });

  pi.registerCommand("goal-init", {
    description: "First-run setup: check models, tools, Laya, and save configuration",
    handler: async (_args, ctx) => {
      const p = pathsFor(ctx.cwd);
      let config = loadConfig(p.configFile);
      let tools = loadTools(p.toolsFile);
      const lines: string[] = ["=== Goal Graph Setup ==="];
      
      // Check models
      lines.push("", "Models:", `  Default: ${config.models.default}`, `  Escalation: ${config.models.escalation}`);
      
      // Check Laya
      lines.push("", "Laya Decision Engine:", `  Provider: ${config.decisionEngine.provider}`);
      if (config.decisionEngine.provider === "laya-local") {
        lines.push(`  Local model: ${config.decisionEngine.layaLocalModel}`);
        const nvidiaExists = await executableExists("nvidia", ctx.cwd).catch(() => false);
        lines.push(`  Local available: ${nvidiaExists ? "yes (NIM)" : "check ollama/llama.cpp"}`);
      } else if (config.decisionEngine.provider === "laya-hf") {
        lines.push(`  HF Endpoint: ${config.decisionEngine.layaHFEndpoint || "not set"}`);
      }
      lines.push(`  Confidence escalation: < ${config.decisionEngine.confidenceEscalationThreshold}`);
      
      // Check tools
      lines.push("", "External Review Tools:");
      for (const [name, tool] of Object.entries(tools)) {
        const installed = await executableExists(tool.executable, ctx.cwd).catch(() => false);
        lines.push(`  ${name}: ${tool.status} | ${installed ? "installed" : "not found"}`);
      }
      
      // Config details
      lines.push("", "Current config:", JSON.stringify(config, null, 2).slice(0, 2000));
      
      ctx.ui.notify(lines.join("\n"), "info");
      if (ctx.hasUI) {
        const save = await ctx.ui.confirm("Apply default configuration?", "Save config for this project?");
        if (save) {
          saveConfig(p.configFile, config);
          saveTools(p.toolsFile, tools);
          ctx.ui.notify("Configuration saved.", "success");
        }
      }
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
      const text = sections.map(([label, rules]) => `${label} (${rules.length})\n${rules.length ? rules.map((r) => `- [${r.status} conf=${r.confidence.toFixed(2)} evidence=${r.evidenceCount} projects=${r.projectsSeen.length}] ${r.text}`).join("\n") : "- none"}`).join("\n\n");
      ctx.ui.notify(text, "info");
    },
  });
}