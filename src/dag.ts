import type { GoalTask } from "./types.ts";

export function validateDag(tasks: GoalTask[]): string[] {
  const issues: string[] = [];
  const ids = new Set<string>();
  for (const task of tasks) {
    if (ids.has(task.id)) issues.push(`Duplicate task id: ${task.id}`);
    ids.add(task.id);
  }
  for (const task of tasks) {
    for (const dep of task.dependencies) {
      if (!ids.has(dep)) issues.push(`${task.id} depends on unknown task ${dep}`);
      if (dep === task.id) issues.push(`${task.id} depends on itself`);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(tasks.map((t) => [t.id, t]));
  function visit(id: string): void {
    if (visiting.has(id)) {
      issues.push(`Cycle detected at ${id}`);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of byId.get(id)?.dependencies ?? []) visit(dep);
    visiting.delete(id);
    visited.add(id);
  }
  for (const task of tasks) visit(task.id);
  return [...new Set(issues)];
}

export function readyTasks(tasks: GoalTask[]): GoalTask[] {
  const completed = new Set(tasks.filter((t) => t.status === "completed" || t.status === "skipped").map((t) => t.id));
  return tasks.filter((t) => t.status === "pending" && t.dependencies.every((d) => completed.has(d)));
}

function normalizeHint(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\*.*$/, "").replace(/\/$/, "");
}

function hintsOverlap(a: GoalTask, b: GoalTask): boolean {
  if (!a.filesHint.length || !b.filesHint.length) return true;
  for (const ah of a.filesHint.map(normalizeHint)) {
    for (const bh of b.filesHint.map(normalizeHint)) {
      if (!ah || !bh) return true;
      if (ah === bh || ah.startsWith(`${bh}/`) || bh.startsWith(`${ah}/`)) return true;
    }
  }
  return false;
}

export function canRunTogether(a: GoalTask, b: GoalTask): boolean {
  if (a.mode === "read" && b.mode === "read") return true;
  if (!a.parallelSafe || !b.parallelSafe) return false;
  if (a.mode === "write" && b.mode === "write" && hintsOverlap(a, b)) return false;
  return true;
}

/**
 * Build one safe dependency wave. Read-only work is freely parallelized. Writes are
 * parallel only when the planner marked both tasks safe and file hints do not overlap.
 */
export function buildWave(tasks: GoalTask[], maxConcurrency: number): GoalTask[] {
  const ready = readyTasks(tasks);
  const wave: GoalTask[] = [];
  for (const candidate of ready) {
    if (wave.length >= Math.max(1, maxConcurrency)) break;
    if (wave.every((existing) => canRunTogether(existing, candidate))) wave.push(candidate);
  }
  if (wave.length === 0 && ready.length > 0) return [ready[0]];
  return wave;
}

export async function mapWithConcurrencyLimit<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!items.length) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export function dependencySummaries(task: GoalTask, tasks: GoalTask[]): string[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return task.dependencies.map((id) => {
    const dep = byId.get(id);
    return dep ? `${dep.id} ${dep.title}: ${dep.lastOutputSummary ?? dep.status}` : `${id}: missing`;
  });
}
