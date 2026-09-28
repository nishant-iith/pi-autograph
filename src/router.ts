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

/**
 * Call a Gradio v4-era Space endpoint. Returns the three-output array that Laya returns:
 * [dataframe, action_string, raw_response_json]
 */
async function callLayaSpace(
  spaceUrl: string,
  api: string,
  inputs: Record<string, unknown>,
  token?: string,
  timeoutMs = 15000,
): Promise<[unknown, string, unknown] | null> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const base = spaceUrl.replace(/\/$/, "");
    const path = api.startsWith("/") ? api : `/${api}`;
    const url = `${base}/gradio_api/call${path}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ data: Object.values(inputs) }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const submit = (await res.json()) as { event_id?: string };
    if (!submit.event_id) return null;
    const pollUrl = `${url}/${submit.event_id}`;
    const poll = await fetch(pollUrl, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: controller.signal,
    });
    if (!poll.ok) return null;
    const text = await poll.text();
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data: ")) continue;
      try {
        const data = JSON.parse(line.slice(6));
        if (Array.isArray(data) && data.length >= 3) {
          return [data[0], String(data[1]), data[2]];
        }
      } catch { /* keep scanning */ }
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** The typed answers that Laya returns inside output[0]. */
interface LayaAnswersTable {
  headers: string[];
  data: Array<[string, string, string | number]>;
}

/** The typed Laya response object inside output[2]. */
interface LayaRaw {
  model?: string;
  answers?: Record<string, {
    type?: string;
    score?: number;
    choice?: string;
    noul?: number;
    confidence?: number;
    probabilities?: Record<string, number>;
  }>;
  usage?: { input_tokens?: number; output_tokens?: number };
  latency_ms?: number;
}

/** Parse Laya's real response shape. */
function parseLayaRouter(
  tuple: [unknown, string, unknown],
  small: string,
  large: string,
): RouterDecision | null {
  const [, action] = tuple;
  // Action string is like "**route to nemotron-super (difficulty 1.57/3)**"
  const match = action.match(/route to\s+(\S+)/i);
  if (!match) return null;
  const chosen = match[1].toLowerCase();
  let tier: ModelTier;
  if (chosen === large.toLowerCase()) tier = "ultra";
  else if (chosen === small.toLowerCase()) tier = "super";
  else if (chosen.includes("ultra")) tier = "ultra";
  else if (chosen.includes("super")) tier = "super";
  else return null;

  // Compute confidence from raw Laya typed answers: take the average of decision confidences.
  const raw = tuple[2] as LayaRaw;
  const answers = raw?.answers ?? {};
  const confidences = Object.values(answers).map((a) => a.confidence).filter((v): v is number => typeof v === "number");
  const confidence = confidences.length > 0 ? confidences.reduce((a, b) => a + b, 0) / confidences.length : 0.5;
  const reason = action.replace(/^\*\*|\*\*$/g, "").trim().replace(/^route to /i, `route to ${tier} — `);
  return { tier, reason, confidence };
}

/**
 * Laya via Gradio Space — the real typed-decision engine.
 * Routing (chooseModel) uses /run_router which returns [dataframe, action_string, raw].
 * Failure classification uses /run_playground with a typed choice question.
 */
export class LayaSpaceDecisionEngine implements DecisionEngine {
  name = "laya-space";
  private readonly cache = new Map<string, RouterDecision | FailureDecision>();

  constructor(private readonly config: GoalGraphConfig, private readonly cwd: string) {}

  async chooseModel(input: {
    task: GoalTask;
    repeatedFailureCount: number;
    disputedReview?: boolean;
    auditAmbiguous?: boolean;
  }): Promise<RouterDecision | null> {
    const small = this.config.decisionEngine.layaSmallModel ?? this.config.models.default;
    const large = this.config.decisionEngine.layaLargeModel ?? this.config.models.escalation;
    const key = `choose:${input.task.role}:${input.task.mode}:${input.task.risk}:${input.repeatedFailureCount}:${!!input.disputedReview}:${!!input.auditAmbiguous}`;
    const cached = this.cache.get(key);
    if (cached && "tier" in cached) return cached as RouterDecision;
    const request = buildRouterRequest(input);
    const tuple = await callLayaSpace(
      this.config.decisionEngine.layaSpaceUrl ?? "https://convaiinnovations-laya-demo.hf.space",
      "run_router",
      { request, small, large },
      this.config.decisionEngine.layaHFToken,
    );
    if (!tuple) return null;
    const decision = parseLayaRouter(tuple, small, large);
    if (decision) this.cacheSet(key, decision);
    return decision;
  }

  async classifyFailure(input: { output: string; task?: GoalTask }): Promise<FailureDecision | null> {
    const key = `classify:${failureSignature(input.output)}:${input.task?.role ?? "?"}`;
    const cached = this.cache.get(key);
    if (cached && "route" in cached) return cached as FailureDecision;
    // Use typed choice via the playground endpoint.
    const state = JSON.stringify({
      task_role: input.task?.role ?? "unknown",
      task_mode: input.task?.mode ?? "unknown",
      task_risk: input.task?.risk ?? "unknown",
      attempts: (input.task?.attempts ?? 0) + 1,
      prior_signatures: input.task?.lastFailureSignature ?? null,
      files_hint: input.task?.filesHint ?? [],
    });
    const questions = JSON.stringify({
      failure_route: {
        type: "choice",
        instructions: "Classify this agent failure into the right next step.",
        criteria: {
          debugger: "Concrete implementation/test error — syntax, type, runtime, assertion.",
          architecture: "Structural or contract problem — schema mismatch, API shape, breaking change.",
          planner: "Missing scope/requirements/plan coverage — not a coding error.",
          blocked: "External dependency, missing credential, permission denied, or other user/environment action required.",
        },
      },
    });
    const tuple = await callLayaSpace(
      this.config.decisionEngine.layaSpaceUrl ?? "https://convaiinnovations-laya-demo.hf.space",
      "run_playground",
      { state_text: state, questions_text: questions },
      this.config.decisionEngine.layaHFToken,
    );
    if (!tuple) return null;
    // Parse from raw typed answers: output[2].answers.failure_route.choice
    const raw = tuple[2] as LayaRaw;
    const choice = raw?.answers?.failure_route?.choice;
    const confidence = raw?.answers?.failure_route?.confidence ?? 0.5;
    if (choice && ["debugger", "architecture", "planner", "blocked"].includes(choice)) {
      const decision: FailureDecision = { route: choice as FailureDecision["route"], reason: "Laya typed choice classification", confidence };
      this.cacheSet(key, decision);
      return decision;
    }
    // Fallback: parse from action string or dataframe text
    const comboText = `${tuple[0]} ${tuple[1]}`.toLowerCase();
    for (const route of ["blocked", "architecture", "planner", "debugger"] as const) {
      if (comboText.includes(route)) {
        const decision: FailureDecision = { route, reason: `Laya (fallback parse) → ${route}`, confidence: 0.55 };
        this.cacheSet(key, decision);
        return decision;
      }
    }
    return null;
  }

  async healthCheck(): Promise<boolean> {
    const tuple = await callLayaSpace(
      this.config.decisionEngine.layaSpaceUrl ?? "https://convaiinnovations-laya-demo.hf.space",
      "run_router",
      { request: "ping", small: this.config.decisionEngine.layaSmallModel ?? this.config.models.default, large: this.config.decisionEngine.layaLargeModel ?? this.config.models.escalation },
      this.config.decisionEngine.layaHFToken,
      8000,
    );
    return tuple !== null;
  }

  private cacheSet(key: string, value: RouterDecision | FailureDecision): void {
    if (this.cache.size > 512) {
      const first = this.cache.keys().next().value;
      if (first !== undefined) this.cache.delete(first);
    }
    this.cache.set(key, value);
  }
}

/** Aliases kept for backward compat. The old "laya-local"/"laya-hf" now both hit the real Space. */
export class LayaHFDecisionEngine extends LayaSpaceDecisionEngine {
  constructor(config: GoalGraphConfig) { super(config, ""); }
}
export class LayaLocalDecisionEngine extends LayaSpaceDecisionEngine {
  constructor(config: GoalGraphConfig, cwd: string) { super(config, cwd); }
}

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
      engine = new LayaSpaceDecisionEngine(config, cwd);
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

/** Wrap a maybe-unhealthy Laya engine and drop back to heuristics when it fails. */
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

function buildRouterRequest(input: {
  task: GoalTask;
  repeatedFailureCount: number;
  disputedReview?: boolean;
  auditAmbiguous?: boolean;
}): string {
  const { task, repeatedFailureCount, disputedReview, auditAmbiguous } = input;
  const reasons: string[] = [];
  if (task.role === "architecture") reasons.push("Architecture task");
  if (task.risk === "high") reasons.push("High risk");
  if (repeatedFailureCount >= 2) reasons.push(`${repeatedFailureCount} repeated failures`);
  if (disputedReview) reasons.push("Disputed blocking review");
  if (auditAmbiguous) reasons.push("Ambiguous completion audit");
  reasons.push(`${task.mode} scope: ${task.filesHint.join(", ") || "unknown"}`);
  return `Route subtask "${task.id}" (${task.role}, ${task.mode} mode). ${reasons.join(". ")}`;
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
