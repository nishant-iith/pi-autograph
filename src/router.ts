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

function buildChooseModelPrompt(input: {
  task: GoalTask;
  repeatedFailureCount: number;
  disputedReview?: boolean;
  auditAmbiguous?: boolean;
}): string {
  const { task, repeatedFailureCount, disputedReview, auditAmbiguous } = input;
  return `Task routing decision.
Role: ${task.role}
Mode: ${task.mode}
Risk: ${task.risk}
ParallelSafe: ${task.parallelSafe}
Repeated failures: ${repeatedFailureCount}
Disputed review: ${disputedReview ? "yes" : "no"}
Ambiguous audit: ${auditAmbiguous ? "yes" : "no"}

Choose tier: "super" (fast, cheap) or "ultra" (slow, thorough).
Output ONLY JSON: {"tier":"super|ultra","reason":"...","confidence":0.0-1.0}`;
}

function buildClassifyFailurePrompt(input: { output: string; task?: GoalTask }): string {
  const { output, task } = input;
  return `Failure classification.
Task role: ${task?.role ?? "unknown"}
Failure output (truncated):
${output.slice(0, 2000)}

Classify route: "blocked" | "architecture" | "debugger" | "planner"
Output ONLY JSON: {"route":"...","reason":"...","confidence":0.0-1.0}`;
}

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
 * Laya Local - runs Laya as an isolated Pi task with a local model.
 * Uses the existing runIsolatedPiTask infrastructure.
 */
export class LayaLocalDecisionEngine implements DecisionEngine {
  name = "laya-local";
  constructor(private readonly config: GoalGraphConfig, private readonly cwd: string) {}

  private async runLaya(prompt: string): Promise<RouterDecision | FailureDecision | null> {
    // Dynamic import to avoid circular dependency
    const { runPiAgent } = await import("./pi-runner.ts");
    const model = this.config.decisionEngine.layaLocalModel ?? "nvidia/nemotron-mini-4b-instruct";
    
    const result = await runPiAgent({
      cwd: this.cwd,
      role: "planner",
      task: prompt,
      systemPrompt: "You are Laya, a fast task router. Output ONLY the requested JSON.",
      model,
      modelTier: "super",
      tools: [],
      signal: new AbortSignal(),
      timeoutMs: 15000,
    });

    if (result.exitCode !== 0 || !result.output.trim()) {
      return null;
    }
    try {
      return JSON.parse(result.output.trim());
    } catch {
      return null;
    }
  }

  async chooseModel(input: {
    task: GoalTask;
    repeatedFailureCount: number;
    disputedReview?: boolean;
    auditAmbiguous?: boolean;
  }): Promise<RouterDecision | null> {
    const prompt = buildChooseModelPrompt(input);
    return this.runLaya(prompt) as Promise<RouterDecision | null>;
  }

  async classifyFailure(input: { output: string; task?: GoalTask }): Promise<FailureDecision | null> {
    const prompt = buildClassifyFailurePrompt(input);
    return this.runLaya(prompt) as Promise<FailureDecision | null>;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const result = await this.runLaya('Test: output {"tier":"super","reason":"health","confidence":1}');
      return result !== null && "tier" in result && result.tier === "super";
    } catch {
      return false;
    }
  }
}

/**
 * Laya Hugging Face - calls HF Inference Endpoint.
 */
export class LayaHFDecisionEngine implements DecisionEngine {
  name = "laya-hf";
  constructor(private readonly config: GoalGraphConfig) {}

  private async callHF(prompt: string): Promise<RouterDecision | FailureDecision | null> {
    const endpoint = this.config.decisionEngine.layaHFEndpoint;
    const token = this.config.decisionEngine.layaHFToken;
    if (!endpoint) return null;

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          inputs: prompt,
          parameters: { max_new_tokens: 100, temperature: 0.1, return_full_text: false },
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return null;
      const data: unknown = await res.json();
      let text = "";
      if (Array.isArray(data)) {
        text = (data[0] as { generated_text?: string })?.generated_text ?? "";
      } else if (data && typeof data === "object") {
        text = (data as { generated_text?: string }).generated_text ?? "";
      }
      return JSON.parse(text.trim());
    } catch {
      return null;
    }
  }

  async chooseModel(input: {
    task: GoalTask;
    repeatedFailureCount: number;
    disputedReview?: boolean;
    auditAmbiguous?: boolean;
  }): Promise<RouterDecision | null> {
    const prompt = buildChooseModelPrompt(input);
    return this.callHF(prompt) as Promise<RouterDecision | null>;
  }

  async classifyFailure(input: { output: string; task?: GoalTask }): Promise<FailureDecision | null> {
    const prompt = buildClassifyFailurePrompt(input);
    return this.callHF(prompt) as Promise<FailureDecision | null>;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const endpoint = this.config.decisionEngine.layaHFEndpoint;
      if (!endpoint) return false;
      const token = this.config.decisionEngine.layaHFToken;
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ inputs: "health check", parameters: { max_new_tokens: 10 } }),
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
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
  switch (de.provider) {
    case "laya-local":
      return new LayaLocalDecisionEngine(config, cwd);
    case "laya-hf":
      return new LayaHFDecisionEngine(config);
    case "laya-placeholder":
      return new LayaPlaceholderDecisionEngine();
    case "heuristic":
    default:
      return new HeuristicDecisionEngine();
  }
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
  
  // Use confidenceEscalationThreshold: if confidence is LOW, escalate to Ultra for safety
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