---
description: "Bootstrap (if needed) and conduct a BMAD-method initiative end-to-end from a client spec, to completion (done) or first blocker."
argument-hint: "Initiative objective and spec to bootstrap from, for example: run the BMAD method for this repo from spec/SPEC.md"
---
<!-- GENERADO — no editar; fuente: spec/apts-surface.json -->

Conduct a server-authoritative BMAD method initiative end-to-end from this client.

1. Resolve project and identity context (let the MCP server auto-fill; do not hand-roll Git discovery).
2. Ensure the method is bootstrapped (idempotent): `create_initiative` (pass the client spec as `spec_artifact` when present) and one `set_agent_role` per BMAD role (Roster model A).
3. Drive the lifecycle with `apts_next`: handle `wait` by switching role identity, drive generative steps yourself (`apts_workflow_step` → produce the declared artifact → `apts_submit_step`), and delegate the iterable `dev-story` step to the executor subagent.
4. Continue until the engine returns `done`; on `blocked`, stop and report the blocker.

Initiative objective and spec to bootstrap from: $ARGUMENTS

_Runs via agent: APTS Method Orchestrator._
