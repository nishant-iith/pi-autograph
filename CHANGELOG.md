# Changelog

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
