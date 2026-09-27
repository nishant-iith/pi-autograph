import * as crypto from "node:crypto";
import type {
  FailureDecision,
  GoalGraphConfig,
  GoalTask,
  ModelTier,
  RouterDecision,
} from "./types.ts";

export interface DecisionEngine {
  name: string;
  chooseModel(input: {
    task: GoalTask;
    repeatedFailureCount: number;
    disputedReview?: boolean;
    auditAmbiguous?: boolean;
  }): Promise<RouterDecision | null>;
  classifyFailure(input: { output: string; task?: GoalTask }): Promise<FailureDecision | null>;
  /** Health check - returns true if engine is available. */
  healthCheck(): Promise<boolean>;
}

/** Heuristic fallback engine (always available, fast, no network). */
export class HeuristicDecisionEngine implements DecisionEngine {
  name = "heuristic";

  async chooseModel(input: {
    task: GoalTask;
    repeatedFailureCount: number;
    disputedReview?: boolean;
    auditAmbiguous?: boolean;
  }): Promise<RouterDecision | null> {
    const { task, repeatedFailureCount, disputedReview, auditAmbiguous } = input;
    const ultraReasons: string[] = [];
    if (task.role === "architecture") ultraReasons.push("architecture task");
    if (task.risk === "high") ultraReasons.push("high-risk task");
    if (repeatedFailureCount >= 2) ultraReasons.push(`${repeatedFailureCount} repeated failures`);
    if (disputedReview) ultraReasons.push("disputed blocking review");
    if (auditAmbiguous) ultraReasons.push("ambiguous completion audit");
    if (ultraReasons.length > 0) {
      return { tier: "ultra", reason: ultraReasons.join(", "), confidence: 0.86 };
    }
    return { tier: "super", reason: "default fast path", confidence: 0.9 };
  }

  async classifyFailure(input: { output: string; task?: GoalTask }): Promise<FailureDecision | null> {
    const text = input.output.toLowerCase();
    if (/permission denied|authentication|unauthorized|forbidden|missing api key|rate limit/.test(text)) {
      return { route: "blocked", reason: "external/auth/environment blocker signature", confidence: 0.84 };
    }
    if (/architecture|schema mismatch|contract mismatch|migration|breaking change/.test(text)) {
      return { route: "architecture", reason: "structural/contract failure signature", confidence: 0.72 };
    }
    if (/syntax|type error|compile|test failed|assertion|exception|stack trace|runtime/.test(text)) {
      return { route: "debugger", reason: "concrete implementation/test failure", confidence: 0.82 };
    }
    if (/requirement|acceptance|missing task|plan/.test(text)) {
      return { route: "planner", reason: "planning/coverage failure signature", confidence: 0.68 };
    }
    return { route: "debugger", reason: "unknown technical failure; inspect evidence", confidence: 0.55 };
  }

  async healthCheck(): Promise<boolean> { return true; }
}

/** Build the router "request" payload that Laya's /run_router expects. */
function buildRouterRequest(input: {
  task: GoalTask;
  repeatedFailureCount: number;
  disputedReview?: boolean;
  auditAmbiguous?: boolean;
}): { request: string; small: string; large: string } {
  const { task, repeatedFailureCount, disputedReview, auditAmbiguous } = input;
  const reasons: string[] = [];
  if (task.role === "architecture") reasons.push("Architecture task");
  if (task.risk === "high") reasons.push("High risk");
  if (repeatedFailureCount >= 2) reasons.push(`${repeatedFailureCount} repeated failures`);
  if (disputedReview) reasons.push("Disputed blocking review");
  if (auditAmbiguous) reasons.push("Ambiguous completion audit");
  reasons.push(`${task.mode} scope: ${task.filesHint.join(", ") || "unknown"}`);
  return {
    request: `Route subtask "${task.id}" (${task.role}, ${task.mode} mode). ${reasons.join(". ")}`,
    small: "",
    large: "",
  };
}

/**
 * Call the Laya Gradio Space with a typed request. Laya returns Dataframe rows;
 * we treat the first row's "route"/"answer"/"decision" as the Laya answer.
 */
async function callLayaSpace(
  spaceUrl: string,
  api: string,
  inputs: Record<string, unknown>,
  token?: string,
  timeoutMs = 15000,
): Promise<unknown> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${spaceUrl.replace(/\/$/, "")}/gradio_api/call/${api.replace(/^\//, "")}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ data: Object.values(inputs) }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { event_id?: string };
    if (!body.event_id) throw new Error("no event_id");
    // Gradio v4 returns an SSE event stream; we read until we get a data: line.
    const pollUrl = `${url}/${body.event_id}`;
    const poll = await fetch(pollUrl, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: controller.signal,
    });
    if (!poll.ok) throw new Error(`HTTP ${poll.status}`);
    const text = await poll.text();
    let out: unknown = null;
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith("data: ")) {
        try { out = JSON.parse(line.slice(6)); break; } catch { /* keep scanning */ }
      }
    }
    return out;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Laya via Gradio Space — the real typed-decision model.
 * Defaults to the public https://convaiinnovations-laya-demo.hf.space which exposes /run_router.
 */
export class LayaSpaceDecisionEngine implements DecisionEngine {
  name = "laya-space";
  private readonly cache = new Map<string, RouterDecision | FailureDecision>();

  constructor(private readonly config: GoalGraphConfig, private readonly cwd: string) {}

  private spaceUrl(): string {
    return (this.config.decisionEngine.layaSpaceUrl || "https://convaiinnovations-laya-demo.hf.space").replace(/\/$/, "");
  }

  private routerApi(): string {
    return this.config.decisionEngine.layaRouterApi || "run_router";
  }

  async chooseModel(input: {
    task: GoalTask;
    repeatedFailureCount: number;
    disputedReview?: boolean;
    auditAmbiguous?: boolean;
  }): Promise<RouterDecision | null> {
    const key = `choose:${input.task.role}:${input.task.mode}:${input.task.risk}:${input.repeatedFailureCount}:${!!input.disputedReview}:${!!input.auditAmbiguous}`;
    const cached = this.cache.get(key);
    if (cached && "tier" in cached) return cached as RouterDecision;
    const req = buildRouterRequest(input);
    const small = this.config.decisionEngine.layaSmallModel ?? this.config.models.default;
    const large = this.config.decisionEngine.layaLargeModel ?? this.config.models.escalation;
    try {
      const result = await callLayaSpace(
        this.spaceUrl(),
        this.routerApi(),
        { request: req.request, small, large },
        this.config.decisionEngine.layaHFToken,
        15000,
      );
      if (!result) return null;
      const decision = this.parseRouterResponse(result, small, large, input);
      if (decision) this.cacheSet(key, decision);
      return decision;
    } catch {
      return null;
    }
  }

  async classifyFailure(input: { output: string; task?: GoalTask }): Promise<FailureDecision | null> {
    // Use the router endpoint to classify the failure: we treat the state string
    // as the task that Laya must route; mount the failure output as the request.
    const key = `classify:${failureSignature(input.output)}:${input.task?.role ?? "?"}`;
    const cached = this.cache.get(key);
    if (cached && "route" in cached) return cached as FailureDecision;
    try {
      const result = await callLayaSpace(
        this.spaceUrl(),
        this.routerApi(),
        {
          request: `Classify this failure output: route to planner/architecture/debugger/blocked. Output: ${input.output.slice(0, 1200)}`,
          small: this.config.decisionEngine.layaSmallModel ?? this.config.models.default,
          large: this.config.decisionEngine.layaLargeModel ?? this.config.models.escalation,
        },
        this.config.decisionEngine.layaHFToken,
        15000,
      );
      if (!result) return null;
      const decision = this.parseFailureResponse(result);
      if (decision) this.cacheSet(key, decision);
      return decision;
    } catch {
      return null;
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const result = await callLayaSpace(
        this.spaceUrl(),
        this.routerApi(),
        { request: "health check", small: this.config.decisionEngine.layaSmallModel ?? this.config.models.default, large: this.config.decisionEngine.layaLargeModel ?? this.config.models.escalation },
        this.config.decisionEngine.layaHFToken,
        8000,
      );
      return result !== null;
    } catch {
      return false;
    }
  }

  private cacheSet(key: string, value: RouterDecision | FailureDecision): void {
    if (this.cache.size > 512) {
      const first = this.cache.keys().next().value;
      if (first !== undefined) this.cache.delete(first);
    }
    this.cache.set(key, value);
  }

  private parseRouterResponse(data: unknown, small: string, large: string, input: { task: GoalTask; repeatedFailureCount: number; disputedReview?: boolean; auditAmbiguous?: boolean }): RouterDecision | null {
    // Laya /run_router returns Gradio Dataframe rows: [request, chosen_model, reasoning]
    let rows: unknown[][] | null = null;
    if (Array.isArray(data) && Array.isArray(data[0])) {
      rows = data as unknown[][];
    } else if (data && typeof data === "object" && "data" in data) {
      const d = (data as { data?: { data?: unknown[][] } }).data?.data;
      if (Array.isArray(d) && Array.isArray(d[0])) rows = d as unknown[][];
    }
    if (!rows || rows.length === 0) return null;
    const first = rows.find((r) => Array.isArray(r) && r.length > 0);
    if (!first) return null;
    const text = JSON.stringify(first).toLowerCase();
    const escalation = ["ultra", large.toLowerCase()];
    const cheap = ["super", small.toLowerCase()];
    let tier: ModelTier = "super";
    if (escalation.some((m) => text.includes(m))) tier = "ultra";
    else if (cheap.some((m) => text.includes(m))) tier = "super";
    else return null;
    const confidence = input.task.risk === "high" ? 0.7 : 0.65;
    const reason = `Laya routed → ${tier}`;
    return { tier, reason, confidence };
  }

  private parseFailureResponse(data: unknown): FailureDecision | null {
    let rows: unknown[][] | null = null;
    if (Array.isArray(data) && Array.isArray(data[0])) {
      rows = data as unknown[][];
    } else if (data && typeof data === "object" && "data" in data) {
      const d = (data as { data?: { data?: unknown[][] } }).data?.data;
      if (Array.isArray(d) && Array.isArray(d[0])) rows = d as unknown[][];
    }
    if (!rows || rows.length === 0) return null;
    const first = rows.find((r) => Array.isArray(r) && r.length > 0);
    if (!first) return null;
    const text = JSON.stringify(first).toLowerCase();
    if (text.includes("blocked")) return { route: "blocked", reason: "Laya classified as blocked", confidence: 0.7 };
    if (text.includes("architecture")) return { route: "architecture", reason: "Laya classified as architecture", confidence: 0.65 };
    if (text.includes("planner")) return { route: "planner", reason: "Laya classified as planner", confidence: 0.65 };
    if (text.includes("debugger") || text.includes("debug")) return { route: "debugger", reason: "Laya classified as debugger", confidence: 0.75 };
    return null;
  }
}

/**
 * Laya HF placeholder (kept for backward compat). If you previously set `laya-hf`,
 * we now route to the real Laya Gradio Space under `layaSpaceUrl` instead.
 */
export class LayaHFDecisionEngine extends LayaSpaceDecisionEngine {
  constructor(config: GoalGraphConfig) { super(config, ""); }
}

/** Alias so the old `laya-local` provider works — it now points at the same Gradio Space flow. */
export class LayaLocalDecisionEngine extends LayaSpaceDecisionEngine {
  constructor(config: GoalGraphConfig, cwd: string) { super(config, cwd); }
}

/**
 * Laya Placeholder - kept for backward compatibility, delegates to heuristic.
 */
export class LayaPlaceholderDecisionEngine implements DecisionEngine {
  name = "laya-placeholder";
  constructor(private readonly fallback = new HeuristicDecisionEngine()) {}
  chooseModel(input: Parameters<DecisionEngine["chooseModel"]>[0]) { return this.fallback.chooseModel(input); }
  classifyFailure(input: Parameters<DecisionEngine["classifyFailure"]>[0]) { return this.fallback.classifyFailure(input); }
  async healthCheck(): Promise<boolean> { return true; }
}

export function makeDecisionEngine(config: GoalGraphConfig, cwd: string): DecisionEngine {
  const de = config.decisionEngine;
  let engine: DecisionEngine;
  switch (de.provider) {
    case "laya-local":
    case "laya-hf":
      engine = new LayaLocalDecisionEngine(config, cwd);
      break;
    case "laya-placeholder":
      engine = new LayaPlaceholderDecisionEngine();
      break;
    case "heuristic":
    default:
      engine = new HeuristicDecisionEngine();
      break;
  }
  if (de.provider === "laya-local" || de.provider === "laya-hf") {
    return new LayaWithFallback(engine);
  }
  return engine;
}

/** Wrap a maybe-unhealthy Laya engine and drop back to heuristics when the first health check fails. */
export class LayaWithFallback implements DecisionEngine {
  readonly name: string;
  private healthy: boolean | null = null;
  constructor(private readonly inner: DecisionEngine, private readonly heuristic = new HeuristicDecisionEngine()) {
    this.name = `${inner.name}:checked`;
  }
  private async pick(): Promise<DecisionEngine> {
    if (this.healthy === null) this.healthy = await this.inner.healthCheck();
    return this.healthy ? this.inner : this.heuristic;
  }
  async chooseModel(input: Parameters<DecisionEngine["chooseModel"]>[0]) { return (await this.pick()).chooseModel(input); }
  async classifyFailure(input: Parameters<DecisionEngine["classifyFailure"]>[0]) { return (await this.pick()).classifyFailure(input); }
  async healthCheck(): Promise<boolean> { return (await this.pick()).healthCheck(); }
}

export async function routeModel(
  config: GoalGraphConfig,
  engine: DecisionEngine,
  task: GoalTask,
  repeatedFailureCount: number,
  extra: { disputedReview?: boolean; auditAmbiguous?: boolean } = {},
): Promise<{ tier: ModelTier; model: string; reason: string; confidence: number }> {
  const decision = await engine.chooseModel({ task, repeatedFailureCount, ...extra });
  const tier = decision?.tier ?? "super";
  // Low-confidence escalation: if Laya returns a non-confident Super, escalate to Ultra.
  const threshold = config.decisionEngine.confidenceEscalationThreshold;
  if (tier === "super" && decision && decision.confidence < threshold) {
    return {
      tier: "ultra",
      model: config.models.escalation,
      reason: `Low confidence (${decision.confidence.toFixed(2)} < ${threshold}); escalated to Ultra`,
      confidence: decision.confidence,
    };
  }
  return {
    tier,
    model: tier === "ultra" ? config.models.escalation : config.models.default,
    reason: decision?.reason ?? "fallback to Super",
    confidence: decision?.confidence ?? 0.5,
  };
}

export function failureSignature(text: string): string {
  const canonical = text
    .toLowerCase()
    .replace(/\b0x[0-9a-f]+\b/g, "<hex>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/\/[^\s:]+/g, "<path>")
    .replace(/\\[^\s:]+/g, "<path>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1800);
  return crypto.createHash("sha1").update(canonical).digest("hex").slice(0, 12);
}
