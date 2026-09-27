import * as fs from "node:fs";
import * as path from "node:path";
import type { GoalGraphConfig, ToolRegistry } from "./types.ts";

export const DEFAULT_CONFIG: GoalGraphConfig = {
  version: "0.4.0",
  models: {
    default: "nvidia/nvidia/nemotron-3-super-120b-a12b",
    escalation: "nvidia/nvidia/nemotron-3-ultra-550b-a55b",
  },
  parallel: { maxConcurrency: 4 },
  context: {
    softTargetPct: 40,
    pruneAtPct: 55,
    hardCompactAtPct: 70,
    reversibleArchive: true,
    maxHotEvidenceChars: 12000,
  },
  decisionEngine: {
    provider: "heuristic",
    confidenceEscalationThreshold: 0.75,
  },
  review: {
    independentAIReviewer: true,
    semgrep: "if-approved-and-installed",
    osvScanner: "if-approved-and-installed",
    openCodeReview: "optional",
  },
  learning: {
    enabled: true,
    globalPromotionMinEvidence: 3,
    globalPromotionMinProjects: 2,
    allowAutoDemotion: true,
  },
  execution: {
    maxEquivalentFailures: 3,
    maxRepairStrategies: 5,
    commandTimeoutMs: 10 * 60 * 1000,
    childSettleGraceMs: 8000,
    planCriticRepairsBeforeUltra: 2,
    reviewerRepairCycles: 3,
    auditRepairCycles: 3,
    retryWorkerOnTransient: 3,
    maxCostUsd: null,
    runInBackground: false,
  },
};

export const DEFAULT_TOOLS: ToolRegistry = {
  semgrep: {
    status: "disabled",
    executable: "semgrep",
    args: ["scan", "--config", "auto", "--json"],
    network: "May fetch rules from the Semgrep registry when using --config auto.",
    scope: "project",
  },
  "osv-scanner": {
    status: "disabled",
    executable: "osv-scanner",
    args: ["scan", "source", "-r", ".", "--format", "json"],
    network: "May query vulnerability metadata unless configured for offline use.",
    scope: "project",
  },
  "opencode-review": {
    status: "disabled",
    executable: "opencode",
    args: ["run", "--agent", "review-coordinator", "review the current changes"],
    network: "Uses your OpenCode provider and the installed OpenCode Review agent configuration.",
    scope: "project",
  },
};

function merge<T extends Record<string, any>>(base: T, override: Partial<T>): T {
  const out: Record<string, any> = { ...base };
  for (const [key, value] of Object.entries(override ?? {})) {
    if (value && typeof value === "object" && !Array.isArray(value) && typeof out[key] === "object") {
      out[key] = merge(out[key], value as Record<string, any>);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out as T;
}

export function loadConfig(file: string): GoalGraphConfig {
  if (!fs.existsSync(file)) return structuredClone(DEFAULT_CONFIG);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return merge(structuredClone(DEFAULT_CONFIG), parsed);
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

export function saveConfig(file: string, config: GoalGraphConfig): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
}

export function loadTools(file: string): ToolRegistry {
  if (!fs.existsSync(file)) return structuredClone(DEFAULT_TOOLS);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return merge(structuredClone(DEFAULT_TOOLS), parsed);
  } catch {
    return structuredClone(DEFAULT_TOOLS);
  }
}

export function saveTools(file: string, tools: ToolRegistry): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(tools, null, 2) + "\n");
}

export function setConfigPath(config: GoalGraphConfig, dottedKey: string, rawValue: string): GoalGraphConfig {
  const keys = dottedKey.split(".").filter(Boolean);
  if (keys.length === 0) throw new Error("Config key is empty");
  const clone = structuredClone(config) as Record<string, any>;
  let current = clone;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (!(key in current) || typeof current[key] !== "object" || current[key] === null) {
      throw new Error(`Unknown config path: ${dottedKey}`);
    }
    current = current[key];
  }
  const leaf = keys[keys.length - 1];
  if (!(leaf in current)) throw new Error(`Unknown config path: ${dottedKey}`);
  const oldValue = current[leaf];
  let value: unknown = rawValue;
  if (typeof oldValue === "number") {
    const n = Number(rawValue);
    if (!Number.isFinite(n)) throw new Error(`Expected number for ${dottedKey}`);
    value = n;
  } else if (typeof oldValue === "boolean") {
    if (!/^(true|false)$/i.test(rawValue)) throw new Error(`Expected true/false for ${dottedKey}`);
    value = rawValue.toLowerCase() === "true";
  }
  current[leaf] = value;
  return clone as GoalGraphConfig;
}
