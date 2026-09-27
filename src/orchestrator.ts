import * as fs from "node:fs";
import * as crypto from "node:crypto";
import type {
  AgentRole,
  AuditResult,
  CheckResult,
  Episode,
  GoalContract,
  GoalGraphConfig,
  GoalTask,
  Lesson,
  ModelTier,
  ReviewResult,
  ToolRegistry,
} from "./types.ts";
import { DEFAULT_CONFIG, loadConfig, loadTools, saveConfig, saveTools } from "./config.ts";
import {
  addEvidence,
  appendEvent,
  archiveText,
  createGoalId,
  ensureStore,
  loadActiveGoal,
  pathsFor,
  projectId,
  saveGoal,
  appendGlobalEpisode,
} from "./store.ts";
import { loadRules, saveRules } from "./store.ts";
import { extractJson, normalizeStringArray, shortText } from "./structured.ts";
import { runPiAgent } from "./pi-runner.ts";
import {
  auditTask,
  candidateValidatorTask,
  criticTask,
  plannerTask,
  reflectionTask,
  reviewTask,
  systemPrompt,
  workerTask,
} from "./prompts.ts";
import { buildWave, dependencySummaries, mapWithConcurrencyLimit, validateDag } from "./dag.ts";
import { failureSignature, makeDecisionEngine, routeModel, type DecisionEngine } from "./router.ts";
import { checksSummary, executableExists, requiredChecksPass, runApprovedExternalTool, runDeterministicChecks } from "./checks.ts";
import { evidenceSummary, relevantRules } from "./context.ts";
import { gitDiff, gitStatus } from "./git.ts";
import {
  addCandidateContradiction,
  persistReflection,
  promoteCandidate,
  promotionCandidates,
  supportingEpisodeSummaries,
  type ReflectionPayload,
} from "./learning.ts";

export interface OrchestratorHooks {
  notify?: (message: string, level?: "info" | "success" | "warning" | "error") => void;
  status?: (message: string | null) => void;
  log?: (message: string) => void;
  /** Grill Me preflight: ask clarifying questions. Return updated objective or null to cancel. */
  grill?: (objective: string) => Promise<string | null>;
}

type PlanPayload = {
  summary: string;
  acceptanceCriteria: Array<{ id: string; description: string; required?: boolean; verificationHint?: string }>;
  tasks: Array<Partial<GoalTask> & { id: string; title: string; description: string }>;
};

type CriticPayload = { approved: boolean; issues?: string[]; reason?: string };
type ReflectionRaw = { episodeSummary?: string; lessons?: Array<{ text?: string; scope?: string; confidence?: number }> };

type RunDecision = Episode["decisions"][number];

function now(): string { return new Date().toISOString(); }
function randomId(prefix: string): string { return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(2).toString("hex")}`; }
function readOnlyTools(): string[] { return ["read", "grep", "find", "ls"]; }
function writeTools(): string[] { return ["read", "write", "edit", "bash", "grep", "find", "ls"]; }

function normalizePlan(payload: PlanPayload, objective: string): { summary: string; criteria: GoalContract["acceptanceCriteria"]; tasks: GoalTask[] } {
  const criteria = (Array.isArray(payload.acceptanceCriteria) ? payload.acceptanceCriteria : [])
    .filter((a) => a && typeof a.description === "string" && a.description.trim())
    .map((a, i) => ({
      id: typeof a.id === "string" && a.id.trim() ? a.id.trim() : `AC${i + 1}`,
      description: a.description.trim(),
      required: a.required !== false,
      verificationHint: typeof a.verificationHint === "string" ? a.verificationHint.trim() : undefined,
      status: "unverified" as const,
      evidenceIds: [] as string[],
    }));
  if (!criteria.length) {
    criteria.push({ id: "AC1", description: `The requested goal is implemented correctly: ${objective}`, required: true, verificationHint: undefined, status: "unverified", evidenceIds: [] });
  }
  const criterionIds = new Set(criteria.map((x) => x.id));
  const rawTasks = Array.isArray(payload.tasks) ? payload.tasks : [];
  const ids = new Set<string>();
  const tasks: GoalTask[] = rawTasks.map((t, i) => {
    let id = typeof t.id === "string" && t.id.trim() ? t.id.trim() : `T${i + 1}`;
    if (ids.has(id)) id = `${id}_${i + 1}`;
    ids.add(id);
    const role = ["research", "architecture", "coder", "debugger"].includes(String(t.role))
      ? t.role as GoalTask["role"] : "coder";
    const mode = t.mode === "read" ? "read" : "write";
    return {
      id,
      title: String(t.title || `Task ${i + 1}`).trim(),
      description: String(t.description || t.title || objective).trim(),
      role,
      mode,
      dependencies: normalizeStringArray(t.dependencies),
      acceptanceCriteria: normalizeStringArray(t.acceptanceCriteria).filter((x) => criterionIds.has(x)),
      filesHint: normalizeStringArray(t.filesHint),
      parallelSafe: Boolean(t.parallelSafe) && (mode === "read" || normalizeStringArray(t.filesHint).length > 0),
      risk: t.risk === "high" || t.risk === "medium" ? t.risk : "low",
      status: "pending",
      attempts: 0,
      modelHistory: [],
    };
  });
  if (!tasks.length) {
    tasks.push({
      id: "T1", title: "Implement goal", description: objective, role: "coder", mode: "write",
      dependencies: [], acceptanceCriteria: criteria.map((x) => x.id), filesHint: [], parallelSafe: false,
      risk: "medium", status: "pending", attempts: 0, modelHistory: [],
    });
  }
  return { summary: String(payload.summary || objective).trim(), criteria, tasks };
}

export class GoalOrchestrator {
  private config: GoalGraphConfig;
  private tools: ToolRegistry;
  private engine: DecisionEngine;
  private decisions: RunDecision[] = [];
  private totalSpendUsd = 0;

  constructor(private readonly cwd: string, private readonly hooks: OrchestratorHooks = {}) {
    const base = ensureStore(cwd);
    this.config = loadConfig(base.configFile);
    this.tools = loadTools(base.toolsFile);
    if (!fs.existsSync(base.configFile)) saveConfig(base.configFile, this.config);
    if (!fs.existsSync(base.toolsFile)) saveTools(base.toolsFile, this.tools);
    this.engine = makeDecisionEngine(this.config, this.cwd);
  }

  reloadConfig(): void {
    const p = pathsFor(this.cwd);
    this.config = loadConfig(p.configFile);
    this.tools = loadTools(p.toolsFile);
    this.engine = makeDecisionEngine(this.config, this.cwd);
  }

  getConfig(): GoalGraphConfig { return this.config; }
  getTools(): ToolRegistry { return this.tools; }
  getActiveGoal(): GoalContract | null { return loadActiveGoal(this.cwd); }

  private notify(message: string, level: "info" | "success" | "warning" | "error" = "info"): void {
    this.hooks.notify?.(message, level);
    this.hooks.log?.(message);
  }
  private status(message: string | null): void { this.hooks.status?.(message); }

  private async runAgent(
    goal: GoalContract | null,
    role: AgentRole,
    task: string,
    modelTier: "super" | "ultra",
    tools: string[],
    signal?: AbortSignal,
  ) {
    const model = modelTier === "ultra" ? this.config.models.escalation : this.config.models.default;
    this.status(`${role} · ${modelTier}`);
    const result = await runPiAgent({
      cwd: this.cwd,
      role,
      task,
      systemPrompt: systemPrompt(role),
      model,
      modelTier,
      tools,
      signal,
      timeoutMs: this.config.execution.commandTimeoutMs,
      settleGraceMs: this.config.execution.childSettleGraceMs,
      maxRetries: this.config.execution.retryWorkerOnTransient,
      goalId: goal?.id,
      onProgress: (m) => this.hooks.log?.(`[${role}] ${shortText(m, 500)}`),
    });
    this.totalSpendUsd += result.usage.cost ?? 0;
    if (goal) {
      const ref = archiveText(this.cwd, goal.id, `${role}-raw`, `${result.output}\n\nSTDERR:\n${result.stderr}`);
      addEvidence(this.cwd, goal.id, {
        type: "agent",
        summary: `${role} via ${modelTier}: ${shortText(result.output || result.stderr || "no output", 1400)}`,
        artifactRef: ref,
        details: { model, modelTier, exitCode: result.exitCode, usage: result.usage },
      });
    }
    return result;
  }

  private async grillMePreflight(objective: string, signal?: AbortSignal): Promise<string | null> {
    if (this.hooks.grill) {
      this.notify("Grill Me preflight: resolving ambiguities...");
      const result = await this.hooks.grill(objective);
      if (result === null) {
        this.notify("Grill Me cancelled by user.", "warning");
        return null;
      }
      if (result !== objective) {
        this.notify("Objective refined via Grill Me.", "info");
      }
      return result;
    }
    return objective;
  }

  private async createPlan(objective: string, goalId: string, signal?: AbortSignal): Promise<GoalContract> {
    // Grill Me preflight: freeze immutable contract before planning
    const refined = await this.grillMePreflight(objective, signal);
    if (refined === null) throw new Error("Grill Me cancelled");
    const finalObjective = refined;
    let feedback: string[] = [];
    let planTier: "super" | "ultra" = "super";
    let lastPlan: PlanPayload | null = null;
    let criticIssues: string[] = [];

    for (let repair = 0; repair <= this.config.execution.planCriticRepairsBeforeUltra + 2; repair++) {
      if (repair >= this.config.execution.planCriticRepairsBeforeUltra) planTier = "ultra";
      this.notify(`Planning goal${planTier === "ultra" ? " (escalated to Ultra)" : ""}...`);
      const planner = await this.runAgent(null, "planner", plannerTask(finalObjective, this.cwd, feedback), planTier, readOnlyTools(), signal);
      if (planner.exitCode !== 0) {
        feedback = [`Planner process failed: ${shortText(planner.stderr || planner.errorMessage || "unknown", 1200)}`];
        continue;
      }
      try { lastPlan = extractJson<PlanPayload>(planner.output); }
      catch (e) { feedback = [`Planner returned invalid JSON: ${(e as Error).message}`]; continue; }

      const normalized = normalizePlan(lastPlan, finalObjective);
      const dagIssues = validateDag(normalized.tasks);
      if (dagIssues.length) {
        feedback = dagIssues;
        continue;
      }

      const critic = await this.runAgent(null, "plan-critic", criticTask(lastPlan, finalObjective), planTier, readOnlyTools(), signal);
      if (critic.exitCode !== 0) { feedback = [`Plan critic failed: ${shortText(critic.stderr, 1000)}`]; continue; }
      let verdict: CriticPayload;
      try { verdict = extractJson<CriticPayload>(critic.output); }
      catch { verdict = { approved: false, issues: ["Plan critic returned invalid structured verdict"] }; }
      criticIssues = normalizeStringArray(verdict.issues);
      if (!verdict.approved) {
        feedback = criticIssues.length ? criticIssues : [verdict.reason || "Plan was not approved"];
        continue;
      }

      const created = now();
      const goal: GoalContract = {
        id: goalId,
        objective: finalObjective,
        immutableObjective: finalObjective,
        createdAt: created,
        updatedAt: created,
        status: "planning",
        summary: normalized.summary,
        acceptanceCriteria: normalized.criteria,
        tasks: normalized.tasks,
        planVersion: repair + 1,
        planCriticIssues: criticIssues,
        runId: randomId("run"),
      };
      saveGoal(this.cwd, goal);
      appendEvent(this.cwd, goal.id, "plan_approved", { tier: planTier, planVersion: goal.planVersion });
      return goal;
    }
    throw new Error(`Could not obtain an approved plan. Last issues: ${feedback.join("; ")}`);
  }

  async start(objective: string, signal?: AbortSignal): Promise<GoalContract> {
    this.reloadConfig();
    this.decisions = [];
    const clean = objective.trim();
    if (!clean) throw new Error("Goal objective is empty");
    const goalId = createGoalId(clean);
    try {
      const goal = await this.createPlan(clean, goalId, signal);
      goal.status = "running";
      saveGoal(this.cwd, goal);
      return await this.run(goal, signal);
    } catch (error) {
      const existing = loadActiveGoal(this.cwd);
      if (existing?.id === goalId) {
        existing.status = signal?.aborted ? "paused" : "failed";
        existing.blockedReason = (error as Error).message;
        saveGoal(this.cwd, existing);
      }
      throw error;
    }
  }

  async resume(signal?: AbortSignal): Promise<GoalContract> {
    this.reloadConfig();
    this.decisions = [];
    const goal = loadActiveGoal(this.cwd);
    if (!goal) throw new Error("No active goal found");
    if (goal.status === "completed") return goal;
    goal.status = "running";
    goal.blockedReason = undefined;
    for (const t of goal.tasks) if (t.status === "running") t.status = "pending";
    saveGoal(this.cwd, goal);
    appendEvent(this.cwd, goal.id, "resumed");
    return await this.run(goal, signal);
  }

  private async executeTask(goal: GoalContract, task: GoalTask, signal?: AbortSignal): Promise<void> {
    const sameFailureCount = goal.tasks.filter((t) => t.lastFailureSignature && t.lastFailureSignature === task.lastFailureSignature).length;
    const route = await routeModel(this.config, this.engine, task, Math.max(task.attempts - 1, sameFailureCount));
    this.decisions.push({ kind: "model-route", selected: route.tier, reason: `${task.id}: ${route.reason}` });
    task.status = "running";
    task.attempts += 1;
    task.modelHistory.push(route.tier);
    saveGoal(this.cwd, goal);
    appendEvent(this.cwd, goal.id, "task_started", { taskId: task.id, role: task.role, modelTier: route.tier, reason: route.reason });

    const rules = relevantRules(this.cwd, `${goal.immutableObjective}\n${task.title}\n${task.description}`);
    const ruleIds = rules.map(r => r.id);
    const deps = dependencySummaries(task, goal.tasks);
    const role: AgentRole = task.role;
    const agentTools = task.mode === "read" ? readOnlyTools() : writeTools();
    const result = await this.runAgent(goal, role, workerTask(goal, task, deps, rules), route.tier, agentTools, signal);
    const raw = `${result.output}\n${result.stderr}`.trim();
    task.rawOutputRef = archiveText(this.cwd, goal.id, `task-${task.id}`, raw || "(no output)");
    task.lastOutputSummary = shortText(result.output || result.stderr || "No output", 2200);

    if (result.exitCode === 0 && result.stopReason !== "error") {
      task.status = "completed";
      // Track successful rule usage
      if (ruleIds.length) this.trackRuleUsage(this.cwd, ruleIds, true);
      addEvidence(this.cwd, goal.id, {
        type: "agent",
        summary: `${task.id} completed by ${task.role} (${route.tier}): ${task.lastOutputSummary}`,
        artifactRef: task.rawOutputRef,
        details: { taskId: task.id, modelTier: route.tier },
      });
      appendEvent(this.cwd, goal.id, "task_completed", { taskId: task.id, modelTier: route.tier });
      saveGoal(this.cwd, goal);
      return;
    }

    const signature = failureSignature(raw || result.errorMessage || "unknown failure");
    const equivalent = task.lastFailureSignature === signature ? task.attempts : 1;
    task.lastFailureSignature = signature;
    task.status = "failed";
    // Track failed rule usage
    if (ruleIds.length) this.trackRuleUsage(this.cwd, ruleIds, false);
    addEvidence(this.cwd, goal.id, {
      type: "agent",
      summary: `${task.id} failed (${signature}): ${shortText(raw || "unknown failure", 1800)}`,
      artifactRef: task.rawOutputRef,
      details: { taskId: task.id, signature, exitCode: result.exitCode },
    });
    saveGoal(this.cwd, goal);

    const decision = await this.engine.classifyFailure({ output: raw, task });
    const failRoute = decision?.route ?? "debugger";
    this.decisions.push({ kind: "failure-route", selected: failRoute, reason: `${task.id}: ${decision?.reason ?? "fallback"}` });
    appendEvent(this.cwd, goal.id, "task_failed", { taskId: task.id, signature, route: failRoute });

    if (signal?.aborted) throw new Error("Goal paused");
    if (failRoute === "blocked") {
      task.status = "blocked";
      goal.status = "blocked";
      goal.blockedReason = shortText(raw, 1600);
      saveGoal(this.cwd, goal);
      return;
    }
    // Autonomous-until-complete: on equivalent failure limit, force planner replan instead of blocking
    if (equivalent >= this.config.execution.maxEquivalentFailures) {
      // Force a planner repair with a materially different strategy
      task.status = "pending";
      task.risk = "high";
      task.parallelSafe = false;
      this.decisions.push({ kind: "planner-repair", selected: "planner", reason: `Equivalent failure limit reached (${signature}); forcing replan` });
      await this.plannerRepair(goal, task, raw, signal);
      return;
    }

    if (failRoute === "planner") {
      await this.plannerRepair(goal, task, raw, signal);
      return;
    }
    if (failRoute === "architecture") task.role = "architecture";
    else task.role = "debugger";
    task.status = "pending";
    task.risk = "high";
    task.parallelSafe = false;
    saveGoal(this.cwd, goal);
  }

  private async plannerRepair(goal: GoalContract, task: GoalTask, failure: string, signal?: AbortSignal): Promise<void> {
    const prompt = `Immutable goal: ${goal.immutableObjective}\nFailed task: ${task.id} ${task.title}\n${task.description}\nFailure evidence:\n${shortText(failure, 5000)}\n\nInspect the repository and choose a materially different repair strategy. Return ONLY JSON:\n{\"route\":\"coder|debugger|architecture\",\"description\":\"specific revised task\",\"reason\":\"why this differs\"}`;
    const tier: "super" | "ultra" = task.attempts >= 2 ? "ultra" : "super";
    const run = await this.runAgent(goal, "planner", prompt, tier, readOnlyTools(), signal);
    try {
      const x = extractJson<{ route?: string; description?: string; reason?: string }>(run.output);
      task.role = x.route === "architecture" ? "architecture" : x.route === "coder" ? "coder" : "debugger";
      if (x.description?.trim()) task.description = x.description.trim();
      task.lastOutputSummary = `Planner repair: ${x.reason ?? "strategy revised"}`;
      this.decisions.push({ kind: "planner-repair", selected: task.role, reason: x.reason ?? "strategy revised" });
    } catch {
      task.role = "debugger";
      task.description += `\n\nRepair from failure evidence: ${shortText(failure, 1800)}`;
    }
    task.status = "pending";
    task.parallelSafe = false;
    task.risk = "high";
    saveGoal(this.cwd, goal);
  }

  private budgetHit(): boolean {
    const cap = this.config.execution.maxCostUsd;
    return cap != null && this.totalSpendUsd >= cap;
  }

  private async executeDag(goal: GoalContract, signal?: AbortSignal): Promise<void> {
    let noProgress = 0;
    while (goal.tasks.some((t) => t.status === "pending" || t.status === "running")) {
      if (signal?.aborted) throw new Error("Goal paused");
      if (goal.status === "blocked") return;
      if (this.budgetHit()) {
        goal.status = "blocked";
        goal.blockedReason = `Cost budget reached: $${this.totalSpendUsd.toFixed(4)} >= $${this.config.execution.maxCostUsd}. Raise execution.maxCostUsd via /goal-config to continue.`;
        saveGoal(this.cwd, goal);
        appendEvent(this.cwd, goal.id, "budget_blocked", { spend: this.totalSpendUsd, cap: this.config.execution.maxCostUsd });
        return;
      }
      const before = goal.tasks.filter((t) => t.status === "completed").length;
      const wave = buildWave(goal.tasks, this.config.parallel.maxConcurrency);
      if (!wave.length) {
        const unresolved = goal.tasks.filter((t) => t.status === "pending").map((t) => `${t.id} deps=${t.dependencies.join(",")}`);
        goal.status = "blocked";
        goal.blockedReason = `No runnable DAG tasks. ${unresolved.join("; ")}`;
        saveGoal(this.cwd, goal);
        return;
      }
      this.notify(`Running wave: ${wave.map((t) => t.id).join(", ")}`);
      await mapWithConcurrencyLimit(wave, this.config.parallel.maxConcurrency, async (task) => this.executeTask(goal, task, signal));
      const after = goal.tasks.filter((t) => t.status === "completed").length;
      if (after === before) noProgress++; else noProgress = 0;
      if (noProgress >= this.config.execution.maxRepairStrategies) {
        // Instead of blocking, fall into completion recovery which replans with failure evidence.
        this.notify("No material progress — triggering completion recovery replan.", "warning");
        const recheck = await this.runChecks(goal, signal);
        const startReview = await this.independentReview(goal, recheck, signal);
        const partialAudit: AuditResult = { pass: false, summary: "strategy exhausted", criteria: [], missingWork: [] };
        const recovered = await this.completionRecovery(goal, recheck, startReview, partialAudit, signal);
        if (recovered.pass && !recovered.findings.some((f) => f.blocking)) {
          // recovery continued progress; reset and continue executing
          noProgress = 0;
          continue;
        }
        goal.status = "blocked";
        goal.blockedReason = `No material progress and recovery failed: ${recovered.summary}`;
        saveGoal(this.cwd, goal);
        return;
      }
    }
  }

  private async runChecks(goal: GoalContract, signal?: AbortSignal): Promise<CheckResult[]> {
    this.notify("Running deterministic verification...");
    const results = await runDeterministicChecks(this.cwd, this.config, this.tools, signal);
    for (const r of results) {
      const raw = `${r.stdout}\n${r.stderr}`.trim();
      const ref = archiveText(this.cwd, goal.id, `check-${r.name}`, raw || "(no output)");
      addEvidence(this.cwd, goal.id, {
        type: "command",
        summary: `${r.exitCode === 0 && !r.timedOut ? "PASS" : "FAIL"} ${r.name}: ${r.command}`,
        artifactRef: ref,
        details: { exitCode: r.exitCode, durationMs: r.durationMs, timedOut: Boolean(r.timedOut), required: r.required },
      });
    }
    appendEvent(this.cwd, goal.id, "checks_finished", { pass: requiredChecksPass(results), count: results.length });
    return results;
  }

  private addRepairTask(goal: GoalContract, title: string, description: string, role: GoalTask["role"] = "debugger"): GoalTask {
    const id = `FIX${goal.tasks.filter((t) => t.id.startsWith("FIX")).length + 1}`;
    const deps = goal.tasks.filter((t) => t.status === "completed").map((t) => t.id);
    const task: GoalTask = {
      id, title, description, role, mode: "write", dependencies: deps,
      acceptanceCriteria: goal.acceptanceCriteria.filter((a) => a.required && a.status !== "verified").map((a) => a.id),
      filesHint: [], parallelSafe: false, risk: "high", status: "pending", attempts: 0, modelHistory: [],
    };
    goal.tasks.push(task);
    saveGoal(this.cwd, goal);
    appendEvent(this.cwd, goal.id, "repair_task_added", { taskId: id, title });
    return task;
  }

  private async repairFailedChecks(goal: GoalContract, results: CheckResult[], signal?: AbortSignal): Promise<CheckResult[]> {
    let current = results;
    let cycle = 0;
    while (!requiredChecksPass(current) && cycle < this.config.execution.maxRepairStrategies) {
      cycle++;
      const failing = current.filter((r) => r.required && (r.exitCode !== 0 || r.timedOut));
      const description = `Repair deterministic verification failures.\n${checksSummary(failing, 5000)}`;
      const task = this.addRepairTask(goal, `Repair failing checks #${cycle}`, description, "debugger");
      await this.executeTask(goal, task, signal);
      if (goal.status === "blocked" || task.status !== "completed") return current;
      current = await this.runChecks(goal, signal);
      const signatures = failing.map((r) => failureSignature(`${r.stdout}\n${r.stderr}`)).join(",");
      this.decisions.push({ kind: "verification-repair", selected: task.modelHistory.at(-1) ?? "super", reason: `cycle ${cycle}; signatures ${signatures}` });
    }
    if (!requiredChecksPass(current)) {
      goal.status = "blocked";
      goal.blockedReason = "Required deterministic checks still fail after materially bounded repair strategies.";
      saveGoal(this.cwd, goal);
    }
    return current;
  }

  private async independentReview(goal: GoalContract, checks: CheckResult[], signal?: AbortSignal): Promise<ReviewResult> {
    if (!this.config.review.independentAIReviewer) return { pass: true, summary: "AI reviewer disabled by configuration", findings: [] };

    const ocr = this.tools["opencode-review"];
    if (this.config.review.openCodeReview !== "off" && ocr.status === "approved" && await executableExists(ocr.executable, this.cwd)) {
      const external = await runApprovedExternalTool(this.cwd, "opencode-review", ocr.executable, ocr.args ?? [], this.config.execution.commandTimeoutMs, signal);
      const ref = archiveText(this.cwd, goal.id, "opencode-review", `${external.stdout}\n${external.stderr}`);
      addEvidence(this.cwd, goal.id, {
        type: "review",
        summary: `Optional OpenCode Review exited ${external.exitCode}: ${shortText(external.stdout || external.stderr, 1600)}`,
        artifactRef: ref,
        details: { exitCode: external.exitCode, optional: true },
      });
      checks = [...checks, external];
    }

    let tier: "super" | "ultra" = "super";
    for (let cycle = 0; cycle <= this.config.execution.reviewerRepairCycles; cycle++) {
      const diff = await gitDiff(this.cwd);
      const run = await this.runAgent(goal, "reviewer", reviewTask(goal, diff, checksSummary(checks)), tier, readOnlyTools(), signal);
      let review: ReviewResult;
      try { review = extractJson<ReviewResult>(run.output); }
      catch {
        if (tier === "super") { tier = "ultra"; continue; }
        review = { pass: false, summary: "Reviewer failed to return valid structured output", findings: [{ id: "R_PARSE", severity: "high", title: "Invalid review output", description: shortText(run.output || run.stderr, 1200), blocking: true }] };
      }
      addEvidence(this.cwd, goal.id, { type: "review", summary: `Independent review ${review.pass ? "PASS" : "FAIL"}: ${review.summary}`, details: { findings: review.findings } });
      appendEvent(this.cwd, goal.id, "review_finished", { pass: review.pass, findings: review.findings.length, tier });
      if (review.pass && !review.findings.some((f) => f.blocking)) return review;
      if (cycle >= this.config.execution.reviewerRepairCycles) return review;
      const blocking = review.findings.filter((f) => f.blocking);
      const task = this.addRepairTask(goal, `Resolve reviewer findings #${cycle + 1}`, blocking.map((f) => `${f.severity.toUpperCase()} ${f.title}: ${f.description}${f.suggestedFix ? `\nSuggested: ${f.suggestedFix}` : ""}`).join("\n\n"), "coder");
      await this.executeTask(goal, task, signal);
      if (goal.status === "blocked" || task.status !== "completed") return review;
      checks = await this.repairFailedChecks(goal, await this.runChecks(goal, signal), signal);
      if (!requiredChecksPass(checks)) return review;
      tier = blocking.some((f) => f.severity === "critical" || f.severity === "high") ? "ultra" : "super";
    }
    return { pass: false, summary: "Review loop exhausted", findings: [] };
  }

  /**
   * Completion recovery: after exhausting repair cycles, re-enter Planner with accumulated failure evidence.
   * Recovery tasks get unique IDs, run sequentially, and re-run the full check+review pipeline afterwards.
   */
  private async completionRecovery(goal: GoalContract, checks: CheckResult[], review: ReviewResult, audit: AuditResult, signal?: AbortSignal): Promise<ReviewResult> {
    const evidence = [
      `Review: ${review.summary}`,
      `Audit: ${audit.summary}`,
      `Missing work: ${normalizeStringArray(audit.missingWork).join("; ")}`,
      `Failed checks: ${checks.filter(c => c.exitCode !== 0 || c.timedOut).map(c => c.name).join(", ")}`,
    ].join("\n");
    const existingIds = new Set(goal.tasks.map((t) => t.id));
    const recoveryPrefix = `recovery-${goal.tasks.filter((t) => t.id.startsWith("recovery-")).length}-${Date.now().toString(36)}`;
    const plannerTier: "super" | "ultra" = goal.tasks.some((t) => t.attempts > 0) ? "ultra" : "super";
    const prompt = `IMMUTABLE GOAL: ${goal.immutableObjective}\nCurrent tasks:\n${goal.tasks.map((t) => `- ${t.id} [${t.status}] ${t.title} (${t.role}/${t.mode})`).join("\n")}\n\nFAILURE EVIDENCE:\n${evidence}\n\nGenerate a REPAIR PLAN: 1-3 new tasks to address ONLY the blocking failures. Prefer different approach.\nIDs must be prefixed '${recoveryPrefix}-'. Return ONLY JSON:\n{"summary":"...","acceptanceCriteria":[...],"tasks":[...]}`;
    const run = await this.runAgent(goal, "planner", prompt, plannerTier, readOnlyTools(), signal);
    let recoveryPlan: PlanPayload;
    try { recoveryPlan = extractJson<PlanPayload>(run.output); } catch {
      return { pass: false, summary: "Recovery planner returned invalid output", findings: [] };
    }
    const recoveryTasks = normalizePlan(recoveryPlan, goal.immutableObjective).tasks
      .slice(0, 3)
      .map((t, i) => {
        const id = `${recoveryPrefix}-${i + 1}`;
        if (existingIds.has(id)) throw new Error(`Recovery task id collision: ${id}`);
        return {
          ...t,
          id,
          dependencies: [] as string[],
          status: "pending" as const,
          attempts: 0,
          modelHistory: [] as ModelTier[],
          risk: "high" as const,
          parallelSafe: false,
        };
      });
    if (recoveryTasks.length === 0) return { pass: false, summary: "Recovery plan produced no tasks", findings: [] };
    goal.tasks.push(...recoveryTasks);
    saveGoal(this.cwd, goal);
    appendEvent(this.cwd, goal.id, "recovery_planning", { newTasks: recoveryTasks.map((t) => t.id) });

    // Execute sequentially — recovery writes are deliberately serialized.
    for (const task of recoveryTasks) {
      if (signal?.aborted) throw new Error("Goal paused");
      if (task.status !== "pending") continue;
      await this.executeTask(goal, task, signal);
      if ((task.status as string) !== "completed") {
        return { pass: false, summary: `Recovery task ${task.id} did not complete`, findings: [] };
      }
    }

    // Rerun deterministic checks, repair them, then re-review.
    let fresh = await this.runChecks(goal, signal);
    fresh = await this.repairFailedChecks(goal, fresh, signal);
    if (!requiredChecksPass(fresh)) {
      return { pass: false, summary: "Recovery: checks still failing", findings: [] };
    }
    return this.independentReview(goal, fresh, signal);
  }

  private async audit(goal: GoalContract, checks: CheckResult[], review: ReviewResult, signal?: AbortSignal): Promise<AuditResult> {
    let tier: "super" | "ultra" = "super";
    for (let cycle = 0; cycle <= this.config.execution.auditRepairCycles; cycle++) {
      const run = await this.runAgent(goal, "auditor", auditTask(goal, evidenceSummary(this.cwd, goal.id, this.config), checksSummary(checks), JSON.stringify(review)), tier, readOnlyTools(), signal);
      let audit: AuditResult;
      try { audit = extractJson<AuditResult>(run.output); }
      catch {
        if (tier === "super") { tier = "ultra"; continue; }
        audit = { pass: false, summary: "Auditor returned invalid structured output", criteria: [], missingWork: [shortText(run.output || run.stderr, 1200)] };
      }
      const knownIds = new Set(goal.acceptanceCriteria.map((a) => a.id));
      for (const item of audit.criteria ?? []) {
        if (!knownIds.has(item.criterionId)) continue;
        const ac = goal.acceptanceCriteria.find((a) => a.id === item.criterionId)!;
        ac.status = item.status === "verified" ? "verified" : item.status === "failed" ? "failed" : "unverified";
        ac.evidenceIds = normalizeStringArray(item.evidenceIds);
      }
      saveGoal(this.cwd, goal);
      addEvidence(this.cwd, goal.id, { type: "audit", summary: `Completion audit ${audit.pass ? "PASS" : "FAIL"}: ${audit.summary}`, details: { criteria: audit.criteria, missingWork: audit.missingWork } });
      appendEvent(this.cwd, goal.id, "audit_finished", { pass: audit.pass, tier, missing: audit.missingWork?.length ?? 0 });
      const allRequiredVerified = goal.acceptanceCriteria.filter((a) => a.required).every((a) => a.status === "verified");
      if (audit.pass && allRequiredVerified && requiredChecksPass(checks) && review.pass) return audit;
      if (cycle >= this.config.execution.auditRepairCycles) return { ...audit, pass: false };
      const missing = normalizeStringArray(audit.missingWork);
      const task = this.addRepairTask(goal, `Close completion gaps #${cycle + 1}`, missing.length ? missing.join("\n") : "Completion audit did not verify all required criteria. Inspect evidence and implement missing behavior/tests.", "coder");
      await this.executeTask(goal, task, signal);
      if (goal.status === "blocked" || task.status !== "completed") return { ...audit, pass: false };
      checks = await this.repairFailedChecks(goal, await this.runChecks(goal, signal), signal);
      if (!requiredChecksPass(checks)) return { ...audit, pass: false };
      review = await this.independentReview(goal, checks, signal);
      if (!review.pass) return { ...audit, pass: false };
      tier = "ultra";
    }
    return { pass: false, summary: "Audit loop exhausted", criteria: [], missingWork: [] };
  }

  private trackRuleUsage(cwd: string, ruleIds: string[], success: boolean): void {
    const p = pathsFor(cwd);
    const projectRules = loadRules(p.projectRulesFile);
    const globalRules = loadRules(p.globalRulesFile);
    const ruleIdsSet = new Set(ruleIds);
    for (const rule of [...projectRules, ...globalRules]) {
      if (ruleIdsSet.has(rule.id)) {
        if (success) {
          rule.successfulUses += 1;
          rule.confidence = Math.min(0.99, rule.confidence + 0.02);
        } else {
          rule.failedUses += 1;
          rule.confidence = Math.max(0, rule.confidence - 0.05);
          // Demote if failures materially outnumber successes
          if (this.config.learning.allowAutoDemotion && rule.failedUses >= 2 && rule.failedUses > rule.successfulUses + 1) {
            rule.status = "deprecated";
          }
        }
        rule.lastUsed = now();
      }
    }
    saveRules(p.projectRulesFile, projectRules);
    saveRules(p.globalRulesFile, globalRules);
  }

  private async learn(goal: GoalContract, outcome: "success" | "blocked" | "failed", summary: string, signal?: AbortSignal): Promise<void> {
    if (!this.config.learning.enabled) return;
    const run = await this.runAgent(goal, "reflection", reflectionTask(goal, summary, projectId(this.cwd)), "super", readOnlyTools(), signal);
    if (run.exitCode !== 0) return;
    let raw: ReflectionRaw;
    try { raw = extractJson<ReflectionRaw>(run.output); } catch { return; }
    const reflection: ReflectionPayload = {
      episodeSummary: String(raw.episodeSummary || summary),
      lessons: (raw.lessons ?? []).flatMap((l) => {
        if (!l?.text || !["episodic", "project", "candidate-global"].includes(String(l.scope))) return [];
        return [{ text: l.text.trim(), scope: l.scope as ReflectionPayload["lessons"][number]["scope"], confidence: Math.max(0, Math.min(1, Number(l.confidence ?? 0.5))) }];
      }),
    };
    persistReflection(this.cwd, goal, outcome, reflection, this.decisions);
    appendEvent(this.cwd, goal.id, "learning_recorded", { lessonCount: reflection.lessons.length });

    for (const candidate of promotionCandidates(this.cwd, this.config)) {
      const support = supportingEpisodeSummaries(this.cwd, candidate);
      const validator = await this.runAgent(goal, "reflection", candidateValidatorTask(candidate, support), "ultra", readOnlyTools(), signal);
      try {
        const verdict = extractJson<{ approve: boolean; confidence?: number; contradictions?: string[]; reason?: string }>(validator.output);
        if (verdict.approve) {
          promoteCandidate(this.cwd, candidate.id, Math.max(candidate.confidence, Number(verdict.confidence ?? 0.8)));
          appendEvent(this.cwd, goal.id, "global_rule_promoted", { ruleId: candidate.id });
        } else {
          for (const contradiction of normalizeStringArray(verdict.contradictions)) addCandidateContradiction(this.cwd, candidate.id, contradiction);
        }
      } catch { /* candidate remains candidate */ }
    }
  }

  private async run(goal: GoalContract, signal?: AbortSignal): Promise<GoalContract> {
    try {
      this.notify(`Goal ${goal.id} started.`);
      appendEvent(this.cwd, goal.id, "run_started", { runId: goal.runId });
      await this.executeDag(goal, signal);
      if (signal?.aborted) throw new Error("Goal paused");
      if (goal.status === "blocked") {
        await this.learn(goal, "blocked", goal.blockedReason || "Blocked", signal);
        this.status(null);
        return goal;
      }

      let checks = await this.runChecks(goal, signal);
      checks = await this.repairFailedChecks(goal, checks, signal);
      if ((goal.status as string) === "blocked" || !requiredChecksPass(checks)) {
        await this.learn(goal, "blocked", goal.blockedReason || "Verification blocked", signal);
        this.status(null);
        return goal;
      }

      const review = await this.independentReview(goal, checks, signal);
      let finalAudit = await this.audit(goal, checks, review, signal);
      
      // If repair cycles exhausted, try completion recovery with fresh plan
      if (!finalAudit.pass && (goal.status as string) !== "blocked") {
        this.notify("Repair cycles exhausted. Attempting completion recovery...", "warning");
        const recoveryReview = await this.completionRecovery(goal, checks, review, finalAudit, signal);
        if (recoveryReview.pass && !recoveryReview.findings.some((f) => f.blocking)) {
          const audit2 = await this.audit(goal, checks, recoveryReview, signal);
          if (audit2.pass) {
            finalAudit = audit2;
            this.notify("Recovery succeeded after planner re-entry.", "success");
          }
        }
      }
      
      if (!finalAudit.pass) {
        goal.status = "blocked";
        goal.blockedReason = `Completion audit failed: ${finalAudit.summary}`;
        saveGoal(this.cwd, goal);
        await this.learn(goal, "blocked", goal.blockedReason, signal);
        this.status(null);
        return goal;
      }

      goal.status = "completed";
      goal.completedAt = now();
      goal.blockedReason = undefined;
      saveGoal(this.cwd, goal);
      appendEvent(this.cwd, goal.id, "completed", { gitStatus: await gitStatus(this.cwd) });
      await this.learn(goal, "success", `Goal verified complete. ${finalAudit.summary}`, signal);
      this.notify(`Goal ${goal.id} verified complete.`, "success");
      this.status(null);
      return goal;
    } catch (error) {
      if (signal?.aborted || (error as Error).message === "Goal paused") {
        goal.status = "paused";
        goal.blockedReason = undefined;
        saveGoal(this.cwd, goal);
        appendEvent(this.cwd, goal.id, "paused");
        this.notify("Goal paused.", "warning");
      } else {
        goal.status = "failed";
        goal.blockedReason = (error as Error).message;
        saveGoal(this.cwd, goal);
        appendEvent(this.cwd, goal.id, "run_error", { error: (error as Error).message });
        this.notify(`Goal run failed: ${(error as Error).message}`, "error");
      }
      this.status(null);
      return goal;
    }
  }
}
