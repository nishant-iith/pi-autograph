import type { AgentRole, GoalContract, GoalTask, Lesson } from "./types.ts";

const BASE = `You are a sub-agent inside Pi Goal Graph, an autonomous graph orchestrator for Pi Coding Agent.
Follow the assigned role exactly. Do not claim success without evidence. Keep outputs concise and decision-useful.
When JSON is requested, output ONLY valid JSON with no markdown fences.`;

export function systemPrompt(role: AgentRole): string {
  const roleText: Record<AgentRole, string> = {
    planner: `${BASE}\nROLE: Planner. Create a dependency-aware plan, explicit acceptance criteria, and tasks. Prefer the smallest sufficient plan. Identify read-only discovery separately from write tasks. Only mark write tasks parallelSafe when they are genuinely independent and their likely file sets do not overlap.`,
    "plan-critic": `${BASE}\nROLE: Plan Critic. You are read-only and adversarial. Look for missing requirements, invalid assumptions, unsafe parallelism, weak verification, architecture/security/migration/docs gaps. Approve only if the plan is executable and testable.`,
    research: `${BASE}\nROLE: Research/Scout. Read the repository and return compressed evidence: exact files, symbols, commands, conventions, and risks relevant to the assigned task. Do not edit files.`,
    architecture: `${BASE}\nROLE: Architecture Agent. Analyze contracts, boundaries, data flow, compatibility, migrations, and cross-system impact. If implementation is requested, make only architecture-scoped edits necessary for the task and preserve existing conventions.`,
    coder: `${BASE}\nROLE: Coding Worker. Implement only the assigned scoped task. Inspect relevant code first, follow repository conventions, make minimal coherent edits, and run focused verification when useful. Do not broaden scope. At the end summarize changed files, behavior, and verification.`,
    debugger: `${BASE}\nROLE: Debugger. Start from the concrete failure evidence. Find the root cause, make a materially different repair when prior attempts repeated the same failure, and verify the fix. Avoid speculative rewrites.`,
    reviewer: `${BASE}\nROLE: Independent Reviewer. You are read-only and did not write the code. Review the repository/diff for correctness, regressions, security, missing tests, maintainability, and alignment with the goal. Only blocking findings should fail review.`,
    auditor: `${BASE}\nROLE: Completion Auditor. You are read-only and the only agent allowed to recommend completion. Check every acceptance criterion against concrete evidence, repository state, deterministic checks, and reviewer status. An agent saying DONE/LGTM is not evidence.`,
    reflection: `${BASE}\nROLE: Reflection/Learning Agent. Extract lessons from the completed/fixed run. Separate one-off facts, project-specific rules, and genuinely reusable candidate-global rules. Do not turn a single anecdote into a global policy.`,
  };
  return roleText[role];
}

export function plannerTask(objective: string, cwd: string, feedback: string[] = []): string {
  return `Project: ${cwd}\nGoal: ${objective}\n${feedback.length ? `Critic feedback to repair:\n- ${feedback.join("\n- ")}\n` : ""}
Inspect the repository enough to make a concrete plan.
Return this JSON shape exactly:
{
  "summary": "short plan summary",
  "acceptanceCriteria": [
    {"id":"AC1","description":"observable criterion","required":true,"verificationHint":"how to prove it"}
  ],
  "tasks": [
    {
      "id":"T1",
      "title":"short title",
      "description":"specific work",
      "role":"research|architecture|coder|debugger",
      "mode":"read|write",
      "dependencies":[],
      "acceptanceCriteria":["AC1"],
      "filesHint":["path/or/glob"],
      "parallelSafe":false,
      "risk":"low|medium|high"
    }
  ]
}
Rules: task ids unique; dependencies reference earlier/existing task ids; at least one acceptance criterion; no redundant tasks; verification must be concrete.`;
}

export function criticTask(plan: unknown, objective: string): string {
  return `Goal: ${objective}\nCandidate plan:\n${JSON.stringify(plan, null, 2)}\n
Return ONLY:
{"approved":true|false,"issues":["..."],"reason":"short explanation"}
Reject for missing acceptance criteria, impossible dependencies, unsafe parallel writes, vague verification, or material omitted risk.`;
}

export function workerTask(goal: GoalContract, task: GoalTask, dependencySummaries: string[], rules: Lesson[]): string {
  const ruleText = rules.slice(0, 12).map((r) => `- [${r.scope}] ${r.text}`).join("\n") || "- none";
  return `Immutable goal: ${goal.immutableObjective}\nCurrent task ${task.id}: ${task.title}\n${task.description}\n
Acceptance criteria touched: ${task.acceptanceCriteria.join(", ") || "none"}\nLikely files: ${task.filesHint.join(", ") || "unknown"}\nRisk: ${task.risk}\n
Relevant validated/project rules:\n${ruleText}\n
Completed dependency evidence:\n${dependencySummaries.join("\n\n") || "none"}\n
Perform this task only. End with a compact summary containing: CHANGED, VERIFIED, RISKS/OPEN ITEMS.`;
}

export function reviewTask(goal: GoalContract, diff: string, checksSummary: string): string {
  return `Goal: ${goal.immutableObjective}\nAcceptance criteria:\n${goal.acceptanceCriteria.map((a) => `${a.id}: ${a.description}`).join("\n")}\n
Deterministic checks:\n${checksSummary}\n
Current diff (may be truncated; inspect files directly if needed):\n${diff}\n
Return ONLY JSON:
{
  "pass": true|false,
  "summary":"...",
  "findings":[
    {"id":"R1","severity":"info|low|medium|high|critical","title":"...","description":"...","file":"optional","line":1,"blocking":true|false,"suggestedFix":"optional"}
  ]
}
Fail only if at least one unresolved blocking finding exists.`;
}

export function auditTask(goal: GoalContract, evidenceSummary: string, checksSummary: string, reviewSummary: string): string {
  return `Immutable goal: ${goal.immutableObjective}\nAcceptance criteria:\n${goal.acceptanceCriteria.map((a) => `${a.id}: ${a.description}`).join("\n")}\n
Task states:\n${goal.tasks.map((t) => `${t.id} ${t.status}: ${t.title}`).join("\n")}\n
Evidence ledger:\n${evidenceSummary}\n
Deterministic checks:\n${checksSummary}\n
Independent review:\n${reviewSummary}\n
Inspect repository files as needed. Return ONLY JSON:
{
  "pass": true|false,
  "summary":"...",
  "criteria":[{"criterionId":"AC1","status":"verified|failed|unknown","reason":"...","evidenceIds":["ev_x"]}],
  "missingWork":["specific missing work"]
}
PASS only if every required criterion is verified with concrete evidence, required checks pass, and review has no blocking findings.`;
}

export function reflectionTask(goal: GoalContract, outcomeSummary: string, projectId: string): string {
  return `Project id: ${projectId}\nGoal: ${goal.immutableObjective}\nOutcome: ${outcomeSummary}\n
Return ONLY JSON:
{
  "episodeSummary":"short factual summary",
  "lessons":[
    {"text":"lesson","scope":"episodic|project|candidate-global","confidence":0.0}
  ]
}
Scope guidance:
- episodic: this situation/run only
- project: stable fact or practice for this repository
- candidate-global: reusable behavioral principle across projects, but still only a candidate
Do not create a global active rule directly.`;
}

export function candidateValidatorTask(rule: Lesson, supportingEpisodes: string[]): string {
  return `Candidate reusable rule: ${rule.text}\nSupporting episodes:\n${supportingEpisodes.join("\n---\n")}\n
Return ONLY JSON:
{"approve":true|false,"confidence":0.0,"contradictions":["..."],"reason":"..."}
Approve only if the rule is genuinely general, well-scoped, non-contradictory, and supported by multiple distinct contexts.`;
}
