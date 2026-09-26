import * as crypto from "node:crypto";
import type { Episode, GoalContract, GoalGraphConfig, Lesson } from "./types.ts";
import { appendEpisode, loadRecentEpisodes, loadRules, pathsFor, projectId, saveRules } from "./store.ts";

export interface ReflectedLesson {
  text: string;
  scope: "episodic" | "project" | "candidate-global";
  confidence: number;
}

export interface ReflectionPayload {
  episodeSummary: string;
  lessons: ReflectedLesson[];
}

function now(): string { return new Date().toISOString(); }
function id(prefix: string, text: string): string {
  return `${prefix}_${crypto.createHash("sha1").update(text).digest("hex").slice(0, 10)}`;
}
function norm(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function mergeRule(existing: Lesson | undefined, lesson: ReflectedLesson, episodeId: string, pid: string): Lesson {
  if (!existing) {
    return {
      id: id("rule", lesson.text),
      text: lesson.text.trim(),
      scope: lesson.scope,
      status: lesson.scope === "project" ? "active" : "candidate",
      confidence: Math.max(0, Math.min(1, lesson.confidence || 0.5)),
      evidenceCount: 1,
      successfulUses: 0,
      failedUses: 0,
      projectsSeen: [pid],
      contradictions: [],
      sourceEpisodeIds: [episodeId],
      createdAt: now(),
    };
  }
  existing.evidenceCount += 1;
  existing.confidence = Math.min(0.99, (existing.confidence * (existing.evidenceCount - 1) + lesson.confidence) / existing.evidenceCount);
  if (!existing.projectsSeen.includes(pid)) existing.projectsSeen.push(pid);
  if (!existing.sourceEpisodeIds.includes(episodeId)) existing.sourceEpisodeIds.push(episodeId);
  existing.lastUsed = now();
  return existing;
}

export function persistReflection(
  cwd: string,
  goal: GoalContract,
  outcome: "success" | "blocked" | "failed",
  reflection: ReflectionPayload,
  decisions: Episode["decisions"],
): { episode: Episode; projectRules: Lesson[]; candidateRules: Lesson[] } {
  const pid = projectId(cwd);
  const episodeId = id("ep", `${goal.id}:${reflection.episodeSummary}:${Date.now()}`);
  const episode: Episode = {
    id: episodeId,
    goalId: goal.id,
    projectId: pid,
    createdAt: now(),
    objective: goal.immutableObjective,
    outcome,
    summary: reflection.episodeSummary,
    decisions,
    lessons: reflection.lessons.map((l) => l.text),
  };
  appendEpisode(cwd, episode);

  const p = pathsFor(cwd);
  const projectRules = loadRules(p.projectRulesFile);
  const candidateRules = loadRules(p.globalCandidateRulesFile);

  for (const lesson of reflection.lessons) {
    const clean = lesson.text.trim();
    if (!clean) continue;
    if (lesson.scope === "episodic") continue;
    const target = lesson.scope === "project" ? projectRules : candidateRules;
    const existing = target.find((r) => norm(r.text) === norm(clean));
    const merged = mergeRule(existing, lesson, episodeId, pid);
    if (!existing) target.push(merged);
  }
  saveRules(p.projectRulesFile, projectRules);
  saveRules(p.globalCandidateRulesFile, candidateRules);
  return { episode, projectRules, candidateRules };
}

export function promotionCandidates(cwd: string, config: GoalGraphConfig): Lesson[] {
  const candidates = loadRules(pathsFor(cwd).globalCandidateRulesFile);
  return candidates.filter((r) =>
    r.status === "candidate" &&
    r.evidenceCount >= config.learning.globalPromotionMinEvidence &&
    r.projectsSeen.length >= config.learning.globalPromotionMinProjects &&
    r.contradictions.length === 0
  );
}

export function promoteCandidate(cwd: string, ruleId: string, confidence: number): Lesson | null {
  const p = pathsFor(cwd);
  const candidates = loadRules(p.globalCandidateRulesFile);
  const index = candidates.findIndex((r) => r.id === ruleId);
  if (index < 0) return null;
  const rule = candidates[index];
  rule.scope = "global";
  rule.status = "active";
  rule.confidence = Math.max(rule.confidence, confidence);
  rule.lastUsed = now();
  candidates.splice(index, 1);
  saveRules(p.globalCandidateRulesFile, candidates);

  const globals = loadRules(p.globalRulesFile);
  const same = globals.find((r) => norm(r.text) === norm(rule.text));
  if (same) {
    same.evidenceCount += rule.evidenceCount;
    same.projectsSeen = [...new Set([...same.projectsSeen, ...rule.projectsSeen])];
    same.sourceEpisodeIds = [...new Set([...same.sourceEpisodeIds, ...rule.sourceEpisodeIds])];
    same.confidence = Math.max(same.confidence, rule.confidence);
    same.lastUsed = now();
    saveRules(p.globalRulesFile, globals);
    return same;
  }
  globals.push(rule);
  saveRules(p.globalRulesFile, globals);
  return rule;
}

export function addCandidateContradiction(cwd: string, ruleId: string, contradiction: string): void {
  const p = pathsFor(cwd);
  const candidates = loadRules(p.globalCandidateRulesFile);
  const rule = candidates.find((r) => r.id === ruleId);
  if (!rule) return;
  if (!rule.contradictions.includes(contradiction)) rule.contradictions.push(contradiction);
  rule.confidence = Math.max(0, rule.confidence - 0.15);
  saveRules(p.globalCandidateRulesFile, candidates);
}

export function supportingEpisodeSummaries(cwd: string, rule: Lesson): string[] {
  const episodes = loadRecentEpisodes(cwd, 200);
  const ids = new Set(rule.sourceEpisodeIds);
  return episodes.filter((e) => ids.has(e.id)).map((e) => `${e.projectId} | ${e.outcome} | ${e.objective}\n${e.summary}`);
}
