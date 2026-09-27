# Changelog

## 0.6.0 — 2026-09-28 — autonomous-until-complete, Grill Me preflight, foreground default

### Critical fixes
- **Fix interactive runtime bug**: `promptRunMode()` was referencing `ctx` instead of `ui` parameter.
- **Foreground by default**: `/goal` now runs in foreground without prompting. For background, use a new `/goal-bg` command or rely on `cfg.execution.runInBackground` (kept for compatibility but unused). `/goal` is always foreground.
- **Real TypeScript validation**: Added `tsconfig.json` with strict settings + `npm run typecheck` now runs `tsc --noEmit` against it. CI job now runs typecheck. This catches runtime bugs that lazy jiti transform misses.
- **Goal stop/kill lifecycle**: Added `/goal-stop` (permanent graceful stop → `status=failed`) and `/goal-kill` (immediate SIGTERM abort of all Pi child workers). Existing `/goal-pause` + `/goal-resume` unchanged.
- **Autonomous-until-complete semantics**: When `maxEquivalentFailures` hits, the orchestrator now forces `plannerRepair` with a materially different strategy instead of blocking. Retry limits prevent dumb repetition, not terminate the goal.

### New features
- **Mandatory Grill Me preflight**: Before planning, the orchestrator now runs a `grillMePreflight()` step that resolves ambiguities (e.g., clarifies the goal objective) via hooks. After START, no further questions are asked.
- **Ponytail default-on**: `architecture`, `coder`, and `debugger` roles now include a `PONYTAIL` prompt: minimal, native, non-overengineered implementations; prefer stdlib, no unnecessary abstractions.
- **Caveman default-on**: All roles now include a `CAVEMAN` prompt: terse, decision-useful communication; no fluff; exact facts.
- **Actual Laya integration**: New `decisionEngine.provider` supports `laya-local` (local NIM model, e.g., `nvidia/nemotron-mini-4b-instruct`) and `laya-hf` (HF Inference Endpoint). Health-checks your Laya provider at startup. Falls back to `heuristic` if unavailable.
- **Use Laya confidence properly**: `confidenceEscalationThreshold` is now wired — if the Laya decision confidence drops below the threshold, we escalate from Super to Ultra deterministically.
- **Safer parallelism**: Write tasks are now sequential by default. `parallelSafe: true` is required AND `filesHint` must not overlap for write tasks to run in parallel.
- **Learning engine completion**: Rules now track `successfulUses` and `failedUses`, with contradiction-based demotion (`-0.05` confidence per failure). `lastUsed` timestamp updated on each use.
- **Global learning evidence**: Episodes are now appended to a `global-episodes.jsonl` for cross-project rule validation.
- **Completion recovery**: When repair cycles are exhausted, re-enter Planner with a compact failure summary to generate a new repair strategy.
- **Better status visibility**: `/goal-status` now shows current wave, active workers, elapsed time, token usage, current stage, and blocked reason if waiting.
- **First-run setup wizard**: New `/goal-init` command to check NVIDIA auth, Laya provider/tool installation, and save default config.

### Cleanup
- **Version**: `0.6.0` throughout (was `0.4.0` in code, `0.5.0` in package.json).
- **Rename**: Storage now uses `PI_AUTOGRAPH_*` env vars (with backward-compatible aliases to `PI_GOAL_GRAPH_*`). Spill marker is `PI_AUTOGRAPH_SPILL`.
- **Config**: Removed `execution.runInBackground` (unused; foreground is the default).


**New name:** `pi-autograph` — autonomous goal graph. (Package renamed; `/goal*` commands unchanged.)

### Reliability
- Worker now retries transient provider errors (429/50x/network) with exponential backoff before a
  failure ever reaches the repair pipeline.
- New `execution.retryWorkerOnTransient` (default 3).
- New `execution.maxCostUsd` — a goal blocks with a clear reason instead of silently burning budget.
- New optional `PI_GOAL_GRAPH_FAKE_PI` env test hook + `runPiAgent` `piInvocation` override so the
  whole graph can run headless on any OS without a real pi install.

### Cross-platform
- Test suite now passes on Windows (was POSIX-only). 13/13 green.

### Docs / contribution surface
- Rewrote README for pi-autograph; added CONTRIBUTING.md, MIT LICENSE, GitHub Actions CI,
  and issue templates.

## 0.4.0 — 2026-09-27

- Rebuilt as an actual Pi Coding Agent TypeScript extension/package.
- Added immutable goal contract and acceptance criteria.
- Added planner + independent plan critic.
- Added dependency-aware task DAG and parallel safe waves (max concurrency 4).
- Added isolated Pi subagents with role-specific tool sets.
- Added Nemotron 3 Super/Ultra routing and escalation.
- Added heuristic Decision Engine interface plus Laya placeholder provider.
- Added persistent goal/task/evidence/event/archive state.
- Added deterministic project-check discovery and repair routing.
- Added optional explicit-approval Semgrep, OSV Scanner, and OpenCode Review adapters.
- Added independent read-only AI review and completion audit.
- Added bounded equivalent-failure/no-progress circuit breakers.
- Added reversible context-tool-output spill/pruning with configurable 40/55/70 operational thresholds.
- Added child-worker post-`agent_settled` reaping and hard timeouts.
- Added experience/reflection learning with episodic, project, candidate-global, and validated global rules.
- Added promotion/demotion evidence metadata and contradiction handling.
- Bundled the full reconstructed design/research record under `docs/MASTER_SPEC.md`.
- Expanded validation suite to 11 tests.
