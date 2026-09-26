# Changelog

## 0.5.0 — 2026-09-27 — renamed pi-goal-graph → pi-autograph

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
