export type AgentRole =
  | "planner"
  | "plan-critic"
  | "research"
  | "architecture"
  | "coder"
  | "debugger"
  | "reviewer"
  | "auditor"
  | "reflection";

export type GoalStatus = "planning" | "running" | "paused" | "blocked" | "completed" | "failed" | "cancelled" | "aborted";
export type TaskStatus = "pending" | "running" | "completed" | "failed" | "blocked" | "skipped";
export type TaskMode = "read" | "write";
export type ModelTier = "super" | "ultra";

export interface AcceptanceCriterion {
  id: string;
  description: string;
  required: boolean;
  verificationHint?: string;
  status: "unverified" | "verified" | "failed";
  evidenceIds: string[];
}

export interface GoalTask {
  id: string;
  title: string;
  description: string;
  role: "research" | "architecture" | "coder" | "debugger";
  mode: TaskMode;
  dependencies: string[];
  acceptanceCriteria: string[];
  filesHint: string[];
  parallelSafe: boolean;
  risk: "low" | "medium" | "high";
  status: TaskStatus;
  attempts: number;
  modelHistory: ModelTier[];
  lastFailureSignature?: string;
  lastOutputSummary?: string;
  rawOutputRef?: string;
}

export interface GoalContract {
  id: string;
  objective: string;
  immutableObjective: string;
  createdAt: string;
  updatedAt: string;
  status: GoalStatus;
  summary: string;
  acceptanceCriteria: AcceptanceCriterion[];
  tasks: GoalTask[];
  planVersion: number;
  planCriticIssues: string[];
  blockedReason?: string;
  completedAt?: string;
  runId?: string;
}

export interface EvidenceRecord {
  id: string;
  goalId: string;
  createdAt: string;
  type: "agent" | "command" | "review" | "audit" | "context" | "tool";
  summary: string;
  details?: Record<string, unknown>;
  artifactRef?: string;
}

export interface AgentRunResult {
  role: AgentRole;
  task: string;
  model: string;
  modelTier: ModelTier;
  exitCode: number;
  output: string;
  stderr: string;
  stopReason?: string;
  errorMessage?: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    contextTokens: number;
    turns: number;
  };
}

export interface CheckResult {
  name: string;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  required: boolean;
  timedOut?: boolean;
}

export interface ReviewFinding {
  id: string;
  severity: "info" | "low" | "medium" | "high" | "critical";
  title: string;
  description: string;
  file?: string;
  line?: number;
  blocking: boolean;
  suggestedFix?: string;
}

export interface ReviewResult {
  pass: boolean;
  summary: string;
  findings: ReviewFinding[];
}

export interface AuditCriterionResult {
  criterionId: string;
  status: "verified" | "failed" | "unknown";
  reason: string;
  evidenceIds: string[];
}

export interface AuditResult {
  pass: boolean;
  summary: string;
  criteria: AuditCriterionResult[];
  missingWork: string[];
}

export interface Lesson {
  id: string;
  text: string;
  scope: "episodic" | "project" | "candidate-global" | "global";
  status: "candidate" | "active" | "deprecated";
  confidence: number;
  evidenceCount: number;
  successfulUses: number;
  failedUses: number;
  projectsSeen: string[];
  contradictions: string[];
  sourceEpisodeIds: string[];
  createdAt: string;
  lastUsed?: string;
}

export interface Episode {
  id: string;
  goalId: string;
  projectId: string;
  createdAt: string;
  objective: string;
  outcome: "success" | "blocked" | "failed";
  summary: string;
  decisions: Array<{
    kind: string;
    selected: string;
    reason: string;
    outcome?: string;
  }>;
  lessons: string[];
}

export interface ToolApproval {
  status: "disabled" | "approved";
  executable: string;
  args?: string[];
  network?: string;
  scope: "project" | "global";
}

export interface ToolRegistry {
  semgrep: ToolApproval;
  "osv-scanner": ToolApproval;
  "opencode-review": ToolApproval;
}

export interface GoalGraphConfig {
  version: string;
  models: {
    default: string;
    escalation: string;
  };
  parallel: {
    maxConcurrency: number;
  };
  context: {
    softTargetPct: number;
    pruneAtPct: number;
    hardCompactAtPct: number;
    reversibleArchive: boolean;
    maxHotEvidenceChars: number;
  };
  decisionEngine: {
    provider: "heuristic" | "laya-placeholder" | "laya-local" | "laya-hf";
    /** Laya Gradio Space URL (e.g. https://convaiinnovations-laya-demo.hf.space). */
    layaSpaceUrl?: string;
    /** Laya router endpoint name (defaults to "/run_router"). */
    layaRouterApi?: string;
    /** Laya HF token (used as Bearer for private Spaces). */
    layaHFToken?: string;
    /** Cheap model name used in router decision handler. */
    layaSmallModel?: string;
    /** Strong model name used in router decision handler. */
    layaLargeModel?: string;
    confidenceEscalationThreshold: number;
  };
  review: {
    independentAIReviewer: boolean;
    semgrep: "if-approved-and-installed" | "off";
    osvScanner: "if-approved-and-installed" | "off";
    openCodeReview: "optional" | "off";
  };
  learning: {
    enabled: boolean;
    globalPromotionMinEvidence: number;
    globalPromotionMinProjects: number;
    allowAutoDemotion: boolean;
  };
  execution: {
    maxEquivalentFailures: number;
    maxRepairStrategies: number;
    commandTimeoutMs: number;
    childSettleGraceMs: number;
    planCriticRepairsBeforeUltra: number;
    reviewerRepairCycles: number;
    auditRepairCycles: number;
    /** Retries per worker on transient provider errors (429/50x/network). */
    retryWorkerOnTransient: number;
    /** Hard spend ceiling for a single goal; null = no budget guard. */
    maxCostUsd: number | null;
  };
}

export interface GoalStorePaths {
  root: string;
  goalRoot: string;
  goalFile: string;
  tasksFile: string;
  evidenceFile: string;
  eventsFile: string;
  summariesFile: string;
  archiveDir: string;
  projectMemoryDir: string;
  episodesFile: string;
  projectRulesFile: string;
  candidateRulesFile: string;
  globalMemoryDir: string;
  globalRulesFile: string;
  globalCandidateRulesFile: string;
  configFile: string;
  toolsFile: string;
}

export interface RouterDecision {
  tier: ModelTier;
  reason: string;
  confidence: number;
}

export interface FailureDecision {
  route: "coder" | "debugger" | "planner" | "architecture" | "blocked";
  reason: string;
  confidence: number;
}
