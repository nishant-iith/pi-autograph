# Roadmap — next release (v0.6)

**Status:** research complete, not yet implemented. This file is the plan; it is not the code.

This is the roadmap for the next release of **pi-autograph** and it emerged from
two released-shape problems: (1) the plugin currently starts a goal **in the
background** with only notifications, so the user can't watch progress, and
(2) we want a **goal interview** before planning and **caveman-terse** progress.

The user's own words that set the direction:

> not on background by default. the user should see detailed progress - what's
> running, what's not - in verify-short caveman style.

---

## 1. Foreground-by-default with a visible progress view (the headline change)

### Problem

`index.ts` does `runInBackground(...)` and gives the user spinning-notifications only.
The user asked for **detailed, always-visible** progress.

### DESIGN: two presentation layers

**1a. Persistent status strip (always on, zero interaction cost).**
Use `ctx.ui.setWidget("goal-progress", lines, { placement: "belowEditor" })`.
Update it on every orchestrator event. Compact by default.

```
goal-20260927-... [running]  T1 ✓  T2 ▶ coder[super]  T3 ○  (CVV: 1 of 3)
```

**1b. Full live watch overlay (foreground, on demand).**
`/goal-watch` opens a custom component (via `ctx.ui.custom()`) that renders:

- the task DAG top-to-bottom with per-task status glyph (✓ ▶ ○ ✗)
- the current task's title + role + model tier + attempt count
- a live log tail (last ~12 lines of agent/verify/audit events)
- a bottom bar: `cost: $0.00 · turns: 7 · running: 40s`
- Esc / q to close (non-destructive).

Because the component wraps a real `AbortController`, Esc also pauses cleanly.

### The orchestrator change this needs

`OrchestratorHooks` gains `onEvent(type, details)`. `appendEvent` calls it. The
`index.ts` factory subscribes and forwards to both the widget and the overlay.

### Why this beats "verbose"

Verbose = dumping logs. The widget gives **structure** (a live DAG + 1-line status),
which is what a user actually wants to follow. `notify` stays reserved for terminal
events (completed/blocked/failed), and `/goal-watch` is the opt-in deep view.

---

## 2. Goal interview (the grill-me pattern) — `/goal-interview`

### Problem

`/goal-direct` plans from a one-line objective. Ambiguity in → mediocrity out.

### DESIGN

New command: `/goal-interview <objective>`.

1. Planner role is invoked in **interview mode** (system prompt: *"You are an interview
   engine. Given the goal and the repository, produce the 4-8 highest-leverage clarifying
   questions. Do NOT plan yet. Rank them by impact"*) — cheap, read-only.
2. Present the questions **one at a time** with `ctx.ui.input()` (per-question).
3. Concatenate objective + answers → run the normal planner → plan-critic → `/goal` gate.
4. Persist the answers into the goal contract (`objectiveContext`), so a resumed goal
   never re-asks.

### Bundle as a skill

`pi-autograph` will ship `skills/pi-autograph-interview/SKILL.md` (adapted from the
existing `grill-me` skill in this repo). Register the package's `skills/` directory so
`pi install` offers it. The skill adds a frontmatter description like:
*"Interview before planning. Use when a goal is ambiguous or high-stakes."*

### Why a skill, not just a command

Contributors can improve the interview prompts without touching plugin internals. The
command is the *transport*; the skill is the *content*.

---

## 3. Caveman progress (verify short) — `progress.style`

### Problem

Long, wordy status lines bury the signal. The user asked for terse, useful,
immediate-progress messages.

### DESIGN

- New config node `progress.style: "normal" | "caveman"` (default `normal`).
- A pure function `toCaveman(text)` in `src/caveman.ts` drops articles/filler/hedging
  while preserving code/ids/paths verbatim (per the `caveman` skill rules).
- Applied centrally at the `OrchestratorHooks.notify/status/log` boundary, not in every
  message — so it can never corrupt a tool result or an evidence record.
- On auto-clarity conditions (security warnings, irreversible confirms, multi-step
  sequences), temporarily fall back to normal for that one message only.

### Example

```
normal : "Running wave: T1, T2 (plan-critic approved the plan)"
caveman: "wave T1 T2 · plan-critic ok"
```

---

## 4. Deeper pi integration (bigger ideas)

Measured first; each entry has the reason and the owner-visible test.

1. **Structured-output planning where available.** pi's tool results accept
   `constrainedSampling`. Where a model supports it, we can pass the planner schema that
   way instead of parsing prose `extractJson(...)`. Fewer invalid-JSON repair loops.
   *Test:* fewer plan-critic retries on the same goal.

2. **Render `/goal-graph` as an entry renderer.** `pi.registerEntryRenderer()` draws a
   nicer DAG than a notification. Zero behavior change, better presentation.

3. **Per-worker tool scoping via `pi.setActiveTools()`.** Coder gets write tools;
   reviewer/auditor get read-only; reflection gets neither. Reduces blast radius.
   *Test:* an e2e test that asserts reviewer never received a `write` tool.

4. **Skill bundling for contributors.** `skills/` dir shipped with the package so
   `pi install git:github.com/nishant-iith/pi-autograph@v...` exposes
   `pi-autograph-interview` and `pi-autograph-caveman` without extra setup.

5. **Git checkpoint before write waves** (opt-in, default off). Before a write wave,
   snapshot `git rev-parse HEAD`; if the wave blocks and `execution.gitRollbackOnBlock`
   is true, offer a one-key revert. *Test:* a scripted bad wave → state restored.

6. **A rich `/goal-status` from metrics.** Reuse the existing evidence ledger to show a
   burns-down: plan tasks remaining, checks passing %, review findings open, spend so far.

---

## What changes, what doesn't

| | This release (0.5.0) | Next (0.6) |
|---|---|---|
| Runs in foreground by default | background + status strip | foreground + `/goal-watch` overlay |
| Interview | — | `/goal-interview` |
| Terse progress | — | `progress.style: caveman` |
| Contributor install | `pi install ./path` | also `pi install git:github.com/nishant-iith/pi-autograph.git` |
| Bundled skills | — | `pi-autograph-interview`, `pi-autograph-caveman` |

---

## Open questions for the maintainer (or first contributors)

- Should the interview default to **always-on** for new goals, or only on
  `/goal-interview`? (Leaning: opt-in; automation-first workflows don't want it.)
- What's the right `caveman` toggle surface — `/goal-config set progress.style caveman`
  or a hot command? (Leaning: both.)
- Should `progress.style` also apply to the **critic/review/audit summaries** the user
  reads, or only to transient progress lines?
