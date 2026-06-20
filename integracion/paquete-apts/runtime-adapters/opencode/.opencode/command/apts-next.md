---
description: "Take the next ready backlog item from APTS and run it to completion or first blocker."
agent: apts-backlog-orchestrator
---
<!-- GENERADO — no editar; fuente: spec/apts-surface.json -->

Run the APTS backlog execution cycle to completion or the first blocker.

1. Resolve project and identity context (let the client auto-fill; do not hand-roll Git discovery).
2. Read project context and list `ready` backlog items (prefer `view = compact`).
3. Take the next `ready` item by priority and `sort_order`, create or resume its execution task, and delegate to the executor subagent.
4. On success continue to the next ready item; on a blocker, stop and report it.

Cycle scope (optional): $ARGUMENTS

_Runs via agent: APTS Backlog Orchestrator._
