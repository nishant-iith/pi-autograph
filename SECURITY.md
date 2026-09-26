# Security Policy

pi-autograph runs autonomous agents that read and write code, run shell commands, and
(optionally) call external models. We take that seriously.

## Reporting a vulnerability

Please **do not** open a public issue for a security vulnerability. Report it privately:

- Open a [security advisory](https://github.com/nishant-iith/pi-autograph/security/advisories) on the repo, or
- email the maintainer (see the GitHub profile for the contact).

We aim to acknowledge reports within a week.

## Abuse-model notes (things we deliberately do NOT do)

- **Never auto-install** a third-party tool. Semgrep / OSV-Scanner / OpenCode Review are
  registerable but require explicit `/goal-tools approve`.
- **A single model judgment never becomes a global rule** — candidate rules need repeated,
  validated evidence.
- **No default authorization consequences.** pi-autograph never sends messages, comments,
  posts, or purchases. It only edits the workspace it was pointed at.
- **The worker's shell commands come from the plan** and run in your Pi session as you,
  with your shell permission. Sandboxing those is Pi's responsibility (see Pi's security docs).

## What to watch for as a user

- Keep your model/cat/API keys out of the goal text and the workspace.
- Review `/goal-memory` for promoted global rules — that's where prior evidence lands.
- The reversible-prune spill directory (`.pi/goal-graph/context-spill/`) contains raw tool
  output. Treat it like a local log; it is not sent anywhere.

## Company use

If you run pi-autograph against a company repository, you are responsible for your
organization's secrecy policies (e.g. code-review requirements, data residency) as they
apply to the model provider you configured.
