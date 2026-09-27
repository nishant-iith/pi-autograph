import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  Episode,
  EvidenceRecord,
  GoalContract,
  GoalStorePaths,
  Lesson,
} from "./types.ts";

function slug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "goal";
}

export function projectId(cwd: string): string {
  const normalized = path.resolve(cwd).replaceAll("\\", "/").toLowerCase();
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

export function createGoalId(objective: string): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const hash = crypto.createHash("sha1").update(objective + Date.now()).digest("hex").slice(0, 7);
  return `${stamp}-${slug(objective).slice(0, 28)}-${hash}`;
}

export function pathsFor(cwd: string, goalId?: string): GoalStorePaths {
  const root = path.join(cwd, ".pi", "goal-graph");
  const gid = goalId ?? "_none";
  const goalRoot = path.join(root, "goals", gid);
  const projectMemoryDir = path.join(root, "memory");
  const globalMemoryDir = path.join(os.homedir(), ".pi", "agent", "goal-graph");
  return {
    root,
    goalRoot,
    goalFile: path.join(goalRoot, "goal.json"),
    tasksFile: path.join(goalRoot, "tasks.json"),
    evidenceFile: path.join(goalRoot, "evidence.jsonl"),
    eventsFile: path.join(goalRoot, "events.jsonl"),
    summariesFile: path.join(goalRoot, "summaries.jsonl"),
    archiveDir: path.join(goalRoot, "archive"),
    projectMemoryDir,
    episodesFile: path.join(projectMemoryDir, "episodes.jsonl"),
    projectRulesFile: path.join(projectMemoryDir, "project-rules.json"),
    candidateRulesFile: path.join(projectMemoryDir, "candidate-rules.json"),
    globalMemoryDir,
    globalRulesFile: path.join(globalMemoryDir, "global-rules.json"),
    globalCandidateRulesFile: path.join(globalMemoryDir, "candidate-rules.json"),
    configFile: path.join(root, "config.json"),
    toolsFile: path.join(root, "tools.json"),
  };
}

function atomicWriteJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

export function ensureStore(cwd: string): GoalStorePaths {
  const p = pathsFor(cwd);
  fs.mkdirSync(path.join(p.root, "goals"), { recursive: true });
  fs.mkdirSync(p.projectMemoryDir, { recursive: true });
  fs.mkdirSync(p.globalMemoryDir, { recursive: true });
  return p;
}

export function saveGoal(cwd: string, goal: GoalContract): void {
  const p = pathsFor(cwd, goal.id);
  fs.mkdirSync(p.archiveDir, { recursive: true });
  goal.updatedAt = new Date().toISOString();
  atomicWriteJson(p.goalFile, goal);
  atomicWriteJson(p.tasksFile, goal.tasks);
  atomicWriteJson(path.join(p.root, "active-goal.json"), { goalId: goal.id, updatedAt: goal.updatedAt });
}

export function loadGoal(cwd: string, goalId: string): GoalContract | null {
  const file = pathsFor(cwd, goalId).goalFile;
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as GoalContract;
  } catch {
    return null;
  }
}

export function loadActiveGoal(cwd: string): GoalContract | null {
  const root = pathsFor(cwd).root;
  const active = path.join(root, "active-goal.json");
  if (!fs.existsSync(active)) return null;
  try {
    const { goalId } = JSON.parse(fs.readFileSync(active, "utf8"));
    if (typeof goalId !== "string") return null;
    return loadGoal(cwd, goalId);
  } catch {
    return null;
  }
}

export function appendJsonl(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(value) + "\n", "utf8");
}

export function appendEvent(cwd: string, goalId: string, type: string, details: Record<string, unknown> = {}): void {
  appendJsonl(pathsFor(cwd, goalId).eventsFile, {
    at: new Date().toISOString(),
    type,
    ...details,
  });
}

export function addEvidence(cwd: string, goalId: string, evidence: Omit<EvidenceRecord, "id" | "goalId" | "createdAt">): EvidenceRecord {
  const id = `ev_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
  const record: EvidenceRecord = {
    id,
    goalId,
    createdAt: new Date().toISOString(),
    ...evidence,
  };
  appendJsonl(pathsFor(cwd, goalId).evidenceFile, record);
  return record;
}

export function readJsonl<T>(file: string, limit = Number.POSITIVE_INFINITY): T[] {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  const slice = Number.isFinite(limit) ? lines.slice(-limit) : lines;
  const out: T[] = [];
  for (const line of slice) {
    try { out.push(JSON.parse(line) as T); } catch { /* ignore malformed line */ }
  }
  return out;
}

export function readEvidence(cwd: string, goalId: string): EvidenceRecord[] {
  return readJsonl<EvidenceRecord>(pathsFor(cwd, goalId).evidenceFile);
}

export function archiveText(cwd: string, goalId: string, kind: string, text: string): string {
  const p = pathsFor(cwd, goalId);
  fs.mkdirSync(p.archiveDir, { recursive: true });
  const id = `arc_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
  const file = path.join(p.archiveDir, `${id}-${slug(kind)}.txt`);
  fs.writeFileSync(file, text, "utf8");
  return path.relative(p.root, file).replaceAll("\\", "/");
}

export function readArchive(cwd: string, artifactRef: string): string | null {
  const root = pathsFor(cwd).root;
  const target = path.resolve(root, artifactRef);
  if (!target.startsWith(path.resolve(root) + path.sep) && target !== path.resolve(root)) return null;
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return null;
  return fs.readFileSync(target, "utf8");
}

export function saveRules(file: string, rules: Lesson[]): void {
  atomicWriteJson(file, rules);
}

export function loadRules(file: string): Lesson[] {
  if (!fs.existsSync(file)) return [];
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(value) ? value as Lesson[] : [];
  } catch {
    return [];
  }
}

export function appendEpisode(cwd: string, episode: Episode): void {
  appendJsonl(pathsFor(cwd).episodesFile, episode);
}

export function appendGlobalEpisode(cwd: string, episode: Episode): void {
  const p = pathsFor(cwd);
  const idxFile = path.join(p.globalMemoryDir, "global-episodes.jsonl");
  appendJsonl(idxFile, episode);
}

export function loadGlobalEvidence(cwd: string, rule: Lesson): Episode[] {
  const p = pathsFor(cwd);
  const idxFile = path.join(p.globalMemoryDir, "global-episodes.jsonl");
  if (!fs.existsSync(idxFile)) return [];
  const episodes = readJsonl<Episode>(idxFile);
  const ruleText = rule.text.trim().toLowerCase();
  return episodes.filter((e) =>
    e.lessons.some((l) => l.trim().toLowerCase() === ruleText) || e.id === rule.id,
  );
}

export function loadRecentEpisodes(cwd: string, limit = 20): Episode[] {
  return readJsonl<Episode>(pathsFor(cwd).episodesFile, limit).reverse().slice(0, limit);
}

export function listGoalIds(cwd: string): string[] {
  const dir = path.join(pathsFor(cwd).root, "goals");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((x) => fs.existsSync(path.join(dir, x, "goal.json"))).sort().reverse();
}
