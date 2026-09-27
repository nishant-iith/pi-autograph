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
  const running = goal.tasks.filter((t) => t.status === "running");
  
  // Elapsed time
  const start = new Date(goal.createdAt).getTime();
  const end = goal.completedAt ? new Date(goal.completedAt).getTime() : Date.now();
  const elapsedSec = Math.round((end - start) / 1000);
  const elapsed = elapsedSec >= 3600 ? `${Math.floor(elapsedSec/3600)}h ${Math.floor((elapsedSec%3600)/60)}m` : elapsedSec >= 60 ? `${Math.floor(elapsedSec/60)}m ${elapsedSec%60}s` : `${elapsedSec}s`;
  
  // Current stage/wave
  const runningIds = running.map(t => t.id).join(", ") || "none";
  const waveIdx = calculateWaveIndex(goal.tasks);
  
  // Context usage estimate
  const totalEvidence = goal.tasks.reduce((acc, t) => acc + (t.rawOutputRef ? 1 : 0), 0);
  
  const lines = [
    `Goal ${goal.id} [${goal.status}]`,
    goal.immutableObjective,
    `Tasks: ${done} done, ${pending} pending, ${failed} failed, ${running.length} running`,
    `Stage: wave ${waveIdx + 1} | Running: ${runningIds}`,
    `Elapsed: ${elapsed} | Total tokens: ${goal.tasks.reduce((a,t) => a + (t.modelHistory?.length || 0), 0)}`,
    `Criteria: ${goal.acceptanceCriteria.map((a) => `${a.id}:${a.status}`).join(", ")}`,
  ];
  return shortText(lines.join("\n"), 3000);
}

function calculateWaveIndex(tasks: GoalContract["tasks"]): number {
  const deps = new Set(tasks.flatMap(t => t.dependencies));
  let wave = 0;
  // Simple walk: count how many upstream dependencies each pending/running task has resolved
  const done = new Set(tasks.filter(t => t.status === "completed").map(t => t.id));
  let changed = true;
  while (changed) {
    changed = false;
    const newWave = tasks.filter(t => t.status === "pending" || t.status === "running")
      .filter(t => t.dependencies.every(d => done.has(d)));
    newWave.forEach(t => { done.add(t.id); changed = true; });
    if (changed) wave++;
  }
  return wave;
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
