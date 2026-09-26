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
}

/**
 * Placeholder only. This deliberately does NOT call Laya.
 * Replace methods with a compact typed request to a Hugging Face Space or local Laya runtime.
 * Keep prompts/state tiny: labels, risk, retry count, failure signature, role, and confidence.
 */
export class LayaPlaceholderDecisionEngine implements DecisionEngine {
  name = "laya-placeholder";
  constructor(private readonly fallback = new HeuristicDecisionEngine()) {}
  chooseModel(input: Parameters<DecisionEngine["chooseModel"]>[0]) { return this.fallback.chooseModel(input); }
  classifyFailure(input: Parameters<DecisionEngine["classifyFailure"]>[0]) { return this.fallback.classifyFailure(input); }
}

export function makeDecisionEngine(config: GoalGraphConfig): DecisionEngine {
  return config.decisionEngine.provider === "laya-placeholder"
    ? new LayaPlaceholderDecisionEngine()
    : new HeuristicDecisionEngine();
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
