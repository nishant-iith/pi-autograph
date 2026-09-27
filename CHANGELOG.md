# Changelog

## 0.6.1 — 2026-09-28 — reliability & real integrations

### Fixes
- **True stop/kill semantics**: `goal-stop` now marks terminal `cancelled`, `goal-kill` marks terminal `aborted`. `goal-resume` rejects both. `goal-kill` no longer leaks the old promise when creating a new AbortController — clears both fields atomically.
- **Laya integration done properly**: Replaced the illegal `new AbortSignal()` + spawn of a Pi subprocess with direct OpenAI-compatible HTTP calls against a local endpoint (Ollama/llama.cpp/NIM) or HF Inference Endpoint. Sub-second decisions, with an in-memory LRU cache (512 entries) to avoid re-querying the same signature.
- **Health fallback now wired**: `LayaLocalDecisionEngine` and `LayaHFDecisionEngine` are wrapped by `LayaWithFallback` which calls `healthCheck()` once and transparently falls back to the heuristic engine if unavailable.
- **Completion recovery fixed**: Recovery task IDs include a per-recovery prefix (`recovery-N-<ts>-K`) so collisions cannot happen across rounds. After recovery tasks run, deterministic checks are re-executed and the reviewer re-runs against fresh evidence.
- **`executeDag` no longer hard-blocks on no-progress**: it now triggers completion recovery instead, which escalates by re-planning with failure evidence.
- **Global evidence index actually used**: `loadGlobalEvidence()` searches both current-project episodes and the cross-project `global-episodes.jsonl` keyed on rule text; `supportingEpisodeSummaries()` consumes it so candidate rules get proper cross-project validation.
- **Rule auto-demotion**: When `failedUses > successfulUses + 1` and `allowAutoDemotion` is on, the rule is deprecated.
- **`/goal-status` real metrics**: Now shows aggregated `usage.input`, `usage.output`, `usage.cost` from evidence records (was incorrectly showing model-history length as "Total tokens").
- **`/goal-init` is a real wizard**: walks you through Laya provider choice (heuristic/local/HF/placeholder), lets you set endpoint URL and model name, then saves config.
- **Ponytail/Caveman loaded from actual skill files** (`~/.agents/skills/*/SKILL.md` with the "Intensity/Examples" sections trimmed) instead of hand-written imitations.
- **Foreground live progress**: `OrchestratorHooks.log` is now wired to `ui.notify` so per-agent progress lines actually appear during foreground runs.
- **`/goal-bg` exists** as documented, with foreground default preserved for `/goal` and `/goal-direct`.

### Test
- Test suite 13/13 green on Windows and Linux via `npm test`.
- `npm run typecheck` runs strict `tsc --noEmit` via `tsconfig.json`.
- CI runs `npm ci` cleanly — `package-lock.json` regenerated to include `@earendil-works/pi-coding-agent@0.87.1` as devDependency so peer types resolve.

## 0.6.0 — 2026-09-28 — autonomous-until-complete, Grill Me preflight, foreground default

### Critical fixes
- **Fix interactive runtime bug**: `promptRunMode()` was referencing `ctx` instead of `ui` parameter.
- **Foreground by default**: `/goal` runs in foreground without prompting. Background available via `/goal-bg`.
- **Real TypeScript validation**: Added `tsconfig.json` with strict settings + `npm run typecheck` in CI.
- **Goal stop/kill lifecycle**: Added `/goal-stop` and `/goal-kill` commands. `/goal-pause` + `/goal-resume` unchanged.
- **Autonomous-until-complete semantics**: `maxEquivalentFailures` now triggers planner replan with a different strategy instead of blocking.

### New features
- **Mandatory Grill Me preflight**: New `grillMePreflight()` hook runs before planning; a small UI prompt lets you freeze/refine the objective.
- **Ponytail default-on**: `architecture`, `coder`, `debugger` roles now include the Ponytail prompt (minimal native implementations).
- **Caveman default-on**: All roles now include the Caveman prompt (terse, decision-useful communication).
- **Actual Laya integration**: `decisionEngine.provider` supports `laya-local` and `laya-hf`. `confidenceEscalationThreshold` wired.
- **Safer parallelism**: Write tasks sequential by default. `parallelSafe: true` + non-overlapping `filesHint` required to run in parallel.
- **Learning engine**: rules now track `successfulUses`/`failedUses` and `lastUsed` updates on use.
- **Global learning evidence**: Episodes are also appended to `global-episodes.jsonl` for cross-project rule validation.
- **Completion recovery**: When repair cycles exhausted, re-enter Planner with failure evidence and generate new repair strategy.
- **Better status visibility**: `/goal-status` shows current wave, running tasks, elapsed time, token usage.
- **First-run setup wizard**: `/goal-init` command to choose Laya provider, set endpoint/model, verify external tools, and save config.

### Cleanup
- **Version**: `0.6.0` throughout.
- **Rename**: Storage now uses `PI_AUTOGRAPH_*` env vars (backward-compatible aliases to `PI_GOAL_GRAPH_*`). Spill marker `PI_AUTOGRAPH_SPILL`.
- **Config**: Removed `execution.runInBackground` (unused; foreground is the default).

