# Pi Goal Graph v0.4.0

An **actual Pi Coding Agent extension/package** that turns a high-level goal into a persistent, dependency-aware **multi-agent graph** and keeps working until the goal is **verified complete** or a real external blocker is reached.

This is not a prompt pack and not a simple Ralph `while (!done)` loop. The extension runs isolated Pi subagents with separate contexts, executes dependency waves in parallel where safe, routes work between NVIDIA Nemotron Super and Ultra, verifies code independently, manages context bloat reversibly, and learns validated lessons from completed runs.

## What it does

```text
Goal + acceptance contract
        ↓
Supervisor
        ↓
Planner ↔ Plan Critic
        ↓
Dependency Task DAG
        ↓
Safe parallel waves (max 4)
        ↓
Decision / Model Router
   ┌────┼────────┬─────────┐
Research Architecture Coder Debugger
   └────┼────────┴─────────┘
        ↓
Evidence + persistent state
        ↓
Tests / build / lint / typecheck
        ↓
Independent read-only AI Reviewer
        ↓
Completion Auditor
   ┌────┴─────────────┐
 repair / replan   VERIFIED
                       ↓
                 Learning Engine
                       ↓
       episodic / project / candidate-global
                       ↓
             validated global rules
```

### Core behavior

- **Pi-native TypeScript extension**; Pi itself remains the agent harness.
- **Isolated subagents** for planning, critique, research, architecture, coding, debugging, review, audit, and reflection.
- **Dependency-aware task DAG**, not a fixed sequence.
- **Parallel dependency waves**, capped at 4 workers; write tasks parallelize only when file hints do not overlap and the planner marked them safe.
- **Nemotron Super by default; Ultra on escalation** for high-risk architecture, repeated failures, difficult reviews/audits, and other harder decisions.
- **Decision Engine interface** with a deterministic heuristic implementation now and a `laya-placeholder` provider slot for a future Laya/local-Laya integration. No Jev dependency.
- **Progress-driven recovery**: failed work routes to debugger/coder/planner/architecture based on failure evidence instead of blindly repeating the same prompt.
- **Circuit breakers** stop equivalent failures and no-progress strategies instead of looping forever.
- **Persistent state** in the repository, so goal/task/evidence state survives sessions and fresh subagent contexts.
- **Independent completion gate**: an LLM saying “done” is not sufficient.
- **Self-improving memory without weight training or self-rewriting**: experiences become episodic/project/candidate-global lessons; global rules need repeated evidence and validation before promotion.

## Requirements

- Current Pi Coding Agent (`@earendil-works/pi-coding-agent`).
- Node.js version supported by your Pi release. Current Pi documentation requires Node 22.19+.
- NVIDIA NIM authentication configured in Pi, either with `/login` or `NVIDIA_API_KEY`.
- The two Nemotron models available in your Pi model catalog.

Before the first run, update the catalog and inspect the exact model names:

```bash
pi update --models
pi --list-models nemotron
```

The packaged defaults are:

```text
Super: nvidia/nvidia/nemotron-3-super-120b-a12b
Ultra: nvidia/nvidia/nemotron-3-ultra-550b-a55b
```

Pi's `--model` format is `provider/model-id`. NVIDIA's upstream model IDs themselves begin with `nvidia/`, so a built-in NVIDIA provider may appear as `nvidia/nvidia/...`. **Trust `pi --list-models nemotron` on your machine.** If your catalog uses different selectors, change them with `/goal-config` before running a goal.

Example:

```text
/goal-config set models.default nvidia/nvidia/nemotron-3-super-120b-a12b
/goal-config set models.escalation nvidia/nvidia/nemotron-3-ultra-550b-a55b
```

## Install

Extract the ZIP to a **stable folder** first. Pi local packages are loaded from the referenced path; they are not copied elsewhere.

Then install the folder:

```bash
pi install /absolute/path/to/pi-goal-graph-v0.4.0
```

Or from the parent directory:

```bash
pi install ./pi-goal-graph-v0.4.0
```

Do not move or delete that folder afterward unless you remove/reinstall the Pi package.

If Pi is already open after installation, restart it or use Pi's reload flow if available in your version.

## First run

Open Pi in the repository you want to modify:

```bash
cd /path/to/your/project
pi
```

Check configuration:

```text
/goal-config
```

Start directly:

```text
/goal-direct Implement user authentication with tests and preserve the existing API contract
```

Or use confirmation first:

```text
/goal Implement user authentication with tests and preserve the existing API contract
```

Then inspect progress with:

```text
/goal-status
/goal-graph
```

## Commands

| Command | Purpose |
|---|---|
| `/goal <objective>` | Confirm and start a goal |
| `/goal-direct <objective>` | Start immediately |
| `/goal-status` | Current goal, criteria, progress, blocker |
| `/goal-graph` | Current task DAG/status |
| `/goal-pause` | Abort active workers while preserving state |
| `/goal-resume` | Resume persisted work |
| `/goal-config` | Show config |
| `/goal-config set <path> <value>` | Change a config value |
| `/goal-tools` | Inspect optional review/security tools |
| `/goal-tools approve <tool>` | Explicitly allow an installed external tool |
| `/goal-tools disable <tool>` | Disable it again |
| `/goal-memory` | Inspect learned project/global rules |

## Review and verification

The default completion pipeline is deliberately stronger than coder self-review:

1. Project checks are auto-detected where possible: test, lint, typecheck/check:types, build, pytest, Go, Rust, Maven, or Gradle.
2. Optional security analyzers can run only when **you explicitly approve them and they already exist on the machine**.
3. A fresh **read-only AI reviewer** evaluates the diff and evidence.
4. A separate **completion auditor** maps evidence back to every required acceptance criterion.
5. The goal completes only when required checks pass, blocking review findings are cleared, and required criteria are verified.

Optional adapters currently registered:

- `semgrep`
- `osv-scanner`
- `opencode-review`

The extension **never installs them automatically**.

## Context control

Each worker already starts with an isolated/fresh Pi context. The extension additionally performs reversible pruning of oversized **tool-result messages** before child model calls:

- below the soft target: only extremely large results are shortened;
- around 40% context usage: moderate pruning begins;
- around 55%: stronger pruning;
- around 70%: aggressive pruning.

These percentages are **operational defaults, not a scientific claim that model quality suddenly drops at 40%**.

Before anything is removed from active context, the complete raw output is stored under:

```text
.pi/goal-graph/context-spill/
```

The shortened message contains a path marker, so the raw material remains recoverable. The normal persisted goal evidence/archive is also kept outside the hot model context.

## Learning / self-improvement

After a success, or after a failure is successfully repaired:

```text
Outcome
  ↓
Experience Recorder
  ↓
Reflection Agent
  ↓
Lesson Extractor
  ↓
Scope Classifier
  ├─ one-off → Episodic Memory
  ├─ repository-specific → Project Rule
  └─ reusable → Candidate Global Rule
                    ↓
             Evidence + Validator
                    ↓
             Active Global Rule
```

A single model judgment cannot create a permanent global rule. Candidate rules accumulate evidence across episodes/projects, are checked for contradictions, and are validated before promotion. This is experience learning, **not model-weight training** and not unrestricted plugin self-modification.

## Persistence

Project state is stored under:

```text
<repo>/.pi/goal-graph/
```

This includes goal state, evidence, events, raw archives, context spills, configuration, tool approvals, project rules, and episodes.

Reusable/global learning is stored under the user's Pi agent area:

```text
~/.pi/agent/goal-graph/
```

## Decision engine / Laya

`decisionEngine.provider` supports:

```text
heuristic
laya-placeholder
```

`laya-placeholder` intentionally does **not** call a public Hugging Face Space or install a local model. It currently falls back to the same deterministic routing logic. This leaves a clean integration point for Laya/local Laya later without making the graph depend on a fragile external demo endpoint.

## Why Graphify is not included

A full code knowledge graph was considered but intentionally omitted from the default design. Current coding models plus targeted file search/read tools and isolated research workers make it unnecessary overhead for this version. It can be added behind an optional retrieval interface later if real runs show a measurable benefit.

## Safety / autonomy boundary

“Autonomous until complete” means the graph keeps choosing the next useful action while evidence shows progress. It does **not** mean endless retries. The system can end as:

- `completed` — verified against acceptance criteria;
- `blocked` — a real external/environment/permission blocker or exhausted materially distinct strategies;
- `paused` — user interruption with state preserved.

## Build validation for this ZIP

The package contains an 11-test local validation suite covering DAG behavior, parallel-write safety, configuration, Super/Ultra routing, reversible archives, check detection, isolated Pi JSON workers, extension command registration, reversible context pruning, post-settlement child-process reaping, and a mocked end-to-end plan → work → review → audit completion flow.

The build environment used to create this ZIP did **not** contain the real `pi` executable, so the package could not be end-to-end loaded against your exact local Pi/model catalog here. The tests use a fake Pi JSON worker where subprocess behavior is required. Your machine is therefore the first real Pi integration test; if your model selector names differ, adjust the two model config values as described above.

## Full design record

All reconstructed requirements, research decisions, trade-offs, and version history are preserved in:

```text
docs/MASTER_SPEC.md
```

That file is bundled specifically so the research from the design conversation does not get lost.
