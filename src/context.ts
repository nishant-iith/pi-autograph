import type { EvidenceRecord, GoalContract, GoalGraphConfig, Lesson } from "./types.ts";
import { loadRules, pathsFor, readEvidence } from "./store.ts";
import { shortText } from "./structured.ts";

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9_./-]+/).filter((x) => x.length >= 3));
}

function scoreRule(rule: Lesson, query: Set<string>): number {
  const rw = words(rule.text);
  let overlap = 0;
  for (const w of rw) if (query.has(w)) overlap++;
  const confidence = Math.max(0, Math.min(1, rule.confidence || 0));
  const activeBonus = rule.status === "active" ? 2 : 0;
  return overlap * 2 + confidence + activeBonus;
}

export function relevantRules(cwd: string, text: string, limit = 12): Lesson[] {
  const p = pathsFor(cwd);
  const projectRules = loadRules(p.projectRulesFile).filter((r) => r.status !== "deprecated");
  const globalRules = loadRules(p.globalRulesFile).filter((r) => r.status === "active");
  const query = words(text);
  return [...projectRules, ...globalRules]
    .map((rule) => ({ rule, score: scoreRule(rule, query) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.rule);
}

export function evidenceSummary(cwd: string, goalId: string, config: GoalGraphConfig): string {
  const records = readEvidence(cwd, goalId);
  const lines: string[] = [];
  let used = 0;
  for (const record of records.slice().reverse()) {
    const line = `${record.id} [${record.type}] ${record.summary}`;
    if (used + line.length > config.context.maxHotEvidenceChars) break;
    lines.push(line);
    used += line.length;
  }
  return lines.reverse().join("\n") || "No evidence recorded yet.";
}

export function compactGoalSummary(goal: GoalContract): string {
  const done = goal.tasks.filter((t) => t.status === "completed").length;
  const pending = goal.tasks.filter((t) => t.status === "pending").length;
  const failed = goal.tasks.filter((t) => t.status === "failed" || t.status === "blocked").length;
  return shortText(`Goal ${goal.id} [${goal.status}]\n${goal.immutableObjective}\nTasks: ${done} completed, ${pending} pending, ${failed} failed/blocked.\nCriteria: ${goal.acceptanceCriteria.map((a) => `${a.id}:${a.status}`).join(", ")}`, 3000);
}

export function hotEvidence(records: EvidenceRecord[], maxChars: number): EvidenceRecord[] {
  const out: EvidenceRecord[] = [];
  let chars = 0;
  for (const r of records.slice().reverse()) {
    const n = r.summary.length + 80;
    if (chars + n > maxChars) break;
    chars += n;
    out.push(r);
  }
  return out.reverse();
}
