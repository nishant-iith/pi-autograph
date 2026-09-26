# Contributing to pi-autograph

Thanks for helping. A few ground rules so contributions stay shippable.

## What kinds of contributions we want

- **Bugs with a repro.** A failing goal run beats a paragraph; include
  `<repo>/.pi/goal-graph/` events + evidence if you can.
- **Real-measurement improvements.** Changing a heuristic, threshold, or routing rule
  should come with a before/after measurement, not a guess.
- **Reliability fixes.** Retries, timeouts, reaping, Windows/POSIX parity.

## Setup

```bash
git clone https://github.com/nishant-iith/pi-autograph
cd pi-autograph
pi install ./        # loads the extension into Pi Coding Agent
```

There are no prod dependencies; Pi (`@earendil-works/pi-coding-agent`) is a peer.

## Test

```bash
npm test            # the local validation suite (node --test, TS via --experimental-transform-types)
npm run typecheck   # optional strict check
```

## Rules for the rules

- **Never auto-install** third-party tools (Semgrep/OSV/OpenCode Review). They are
  registerable but must be explicitly approved at runtime.
- **Never let one model judgment become a global rule** — candidate rules need
  repeated evidence + validation first.
- **Auth failures vs transient failures are different.** A 504/429 is a retry, not a bug
  in the task. Add evidence before claiming either improvement or regression.
- Keep the plugin **framework-free** (no LangGraph/vector DB). New requirements need
  a MASTER_SPEC.md entry explaining why an existing layer can't absorb it.

## Pull requests

Small, single-purpose, with a test where behavior changes. Explain the failure you saw
in a real run if it's a reliability fix.

## License

By contributing you agree your contributions are licensed under the MIT License.
