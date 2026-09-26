# Architecture

```mermaid
flowchart TD
    A[Goal / immutable objective] --> B[Supervisor]
    B --> C[Planner]
    C --> D[Plan Critic]
    D -->|weak plan| C
    D -->|approved| E[Dependency Task DAG]
    E --> F[Wave Scheduler max 4]
    F --> G[Decision + Model Router]
    G --> H1[Research]
    G --> H2[Architecture]
    G --> H3[Coder]
    G --> H4[Debugger]
    H1 --> I[Evidence / Persistent State]
    H2 --> I
    H3 --> I
    H4 --> I
    I --> J[Tests + Build + Lint + Typecheck]
    J -->|failure| G
    J -->|pass| K[Independent Read-only Reviewer]
    K -->|code issue| H3
    K -->|debug issue| H4
    K -->|architecture issue| H2
    K -->|plan issue| C
    K -->|pass| L[Completion Auditor]
    L -->|missing work| C
    L -->|verified| M[Experience Recorder]
    M --> N[Reflection Agent]
    N --> O[Lesson Extractor]
    O --> P{Scope Classifier}
    P -->|one-off| Q[Episodic Memory]
    P -->|project| R[Project Rule]
    P -->|generic candidate| S[Candidate Global Rule]
    S --> T[Evidence + Replay/LLM Validator]
    T -->|not proven| Q
    T -->|proven| U[Procedural / Global Rule]
    Q --> B
    R --> B
    U --> B
    M --> V[DONE]
```

## Runtime boundaries

- Parent Pi session: commands, UI/status, persisted orchestration.
- Child Pi workers: isolated `pi --mode json -p --no-session` processes with role-specific tools/prompts/models.
- Child context handler: reversible pruning of oversized tool results only.
- Disk state: source of truth for goal, task, evidence, and memory state.

## Model policy

- Super: default planning, coding, research, review, normal repairs.
- Ultra: high-risk architecture, repeated failure, difficult/invalid structured outputs, severe review findings, ambiguous completion audit, global-rule validation when needed.
- Laya slot: fast control-plane decisions in a future provider; never sole completion judge.
