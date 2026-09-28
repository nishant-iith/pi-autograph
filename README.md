<div align="center">

# pi-autograph

**Turn a high-level goal into a verified multi-agent graph.**
Plan → critique → parallel dependency waves → deterministic checks → independent review → completion audit — with Nemotron routing, budget + retry circuit breakers, and validated learning memory.

`pi install ./pi-autograph` · [contribute](CONTRIBUTING.md) · MIT licensed

</div>

---

**This is an actual Pi Coding Agent extension/package.** It is not a prompt pack and not a simple `while (!done)` loop. It runs isolated Pi subagents with separate contexts, executes dependency waves in parallel where safe, routes work between NVIDIA Nemotron Super and Ultra, verifies code independently, manages context reversibly, and learns only from **validated** lessons.

**Current version: 0.6.3.** See [CHANGELOG.md](CHANGELOG.md) for what's new.

```text
Goal + acceptance contract
        ↓
Supervisor
        ↓
Planner ↔ Plan Critic            (plan must be approved before any write)
        ↓
Dependency Task DAG
        ↓
Safe parallel waves (max 4, write tasks only when non-overlapping)
        ↓
Decision / Model Router          (Super by default, Ultra on escalation)
   ┌────┼────────┬─────────┐
Research Architecture Coder Debugger
   └────┼────────┴─────────┘
        ↓
Evidence + persistent state
        ↓
Tests / build / lint / typecheck   (auto-detected)
        ↓
Independent read-only AI Reviewer
        ↓
Completion Auditor               (maps evidence to every required criterion)
   ┌────┴─────────────┐
 repair / replan   VERIFIED
                       ↓
                 Learning Engine   (episodic → project → candidate-global → validated global)
```

## Why not just a while loop

An LLM saying "done" is not evidence. pi-autograph requires deterministic checks, an independent
reviewer that never wrote the code, and a completion auditor that maps evidence to every acceptance
criterion. Failed work is routed to a planner/architecture/debugger by the failure signature, not
repeated verbatim.

## Requirements

- Current [pi](https://github.com/earendil-works/pi-coding-agent).
- Node.js version your Pi release supports (current docs: Node 22.19+; we develop on Node 24).
- NVIDIA NIM configured in Pi: `/login` or `NVIDIA_API_KEY`.
- The two Nemotron models in your catalog.

Confirm the exact selectors first (Pi/NVIDIA name NVIDIA models like `nvidia/nvidia/...`):

```bash
pi --list-models nemotron
```

Default / escalation:

```text
Super: nvidia/nvidia/nemotron-3-super-120b-a12b
Ultra: nvidia/nvidia/nemotron-3-ultra-550b-a55b
```

If your catalog differs, change them: `/goal-config set models.default <selector>`.

## Install

Extract to a **stable folder** (Pi packages load from the referenced path and are not copied away), then:

```bash
pi install /absolute/path/to/pi-autograph
```

Restart / reload Pi. Then:

```text
/goal-direct Add pagination to GET /users with tests, without changing the existing API
```

Watch it:

```text
/goal-status
/goal-graph
```

## Commands

| Command | Purpose |
|---|---|
| `/goal <objective>` | Confirm then start a goal |
| `/goal-direct <objective>` | Start immediately |
| `/goal-status` | current goal, criteria, progress, blocker |
| `/goal-graph` | task DAG + states |
| `/goal-pause` | abort workers, preserve state |
| `/goal-resume` | resume the persisted goal |
| `/goal-config` | show config |
| `/goal-config set <dotted.key> <value>` | change a config value |
| `/goal-tools` | inspect optional external reviewers |
| `/goal-tools approve <tool>` | allow an installed tool (never auto-installed) |
| `/goal-memory` | learned project / candidate / global rules |

## Key behaviors

- **Transient-error retry.** A provider 429/50x is retried with backoff by the worker, before it ever
  reaches the failure-repair pipeline — a flaky free tier must not look like a task bug.
  (`execution.retryWorkerOnTransient`, default 3.)
- **Cost budget.** Set `execution.maxCostUsd`; a goal that exceeds it blocks with a clear reason
  instead of silently burning your quota.
- **Dependency-aware parallel waves.** Read tasks parallelize freely; write tasks parallelize only
  when the planner marked them safe and `filesHint` do not overlap. Cap: `parallel.maxConcurrency` (default 4).
- **Reversible context pruning.** Oversized tool results are shortened; the raw material is stored
  under `.pi/goal-graph/context-spill/`, so pruning is always recoverable.
- **Validated learning.** A single run cannot write a global rule; candidate rules need repeated
  evidence across projects and a separate validator to promote.

## Configuration

```text
goal-config set models.default <selector>
goal-config set models.escalation <selector>
goal-config set parallel.maxConcurrency 4
goal-config set decisionEngine.provider heuristic | laya-placeholder
goal-config set execution.retryWorkerOnTransient 3
goal-config set execution.maxCostUsd 0.50
goal-config set learning.enabled true
```

## Safety / autonomy boundary

"Autonomous until complete" means it keeps picking the next useful action while evidence shows progress.
It can end as `completed` (verified), `blocked` (real external blocker), or `paused`. It never installs
tools, never signs up to an account, and never lets a single anecdote become a global rule.

## Design record

The full reconstructed requirements, research decisions, trade-offs, and version history live in
[`docs/MASTER_SPEC.md`](docs/MASTER_SPEC.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Short version: open an issue with a real run, keep it
framework-free, no auto-installed third parties, and never let one model judgment become a rule.

## License

MIT — see [LICENSE](LICENSE).
