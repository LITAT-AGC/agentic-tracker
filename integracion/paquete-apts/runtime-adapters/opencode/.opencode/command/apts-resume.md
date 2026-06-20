---
description: "Inspect APTS for interrupted (stalled) work and resume the existing task instead of creating a duplicate."
agent: apts-backlog-orchestrator
---
<!-- GENERADO — no editar; fuente: spec/apts-surface.json -->

Resume interrupted (`stalled`) APTS work instead of starting duplicates.

1. Inspect `read_project_context` for `stalled` tasks or backlog items still pointing to an interrupted task.
2. For the interrupted item, call `register_task` with the same `backlog_item_id` so APTS resumes the existing task (`todo`/`in_progress`/`stalled`) instead of creating a parallel one.
3. Continue the execution cycle from the resumed task.

Optional backlog item id to resume: $ARGUMENTS

_Runs via agent: APTS Backlog Orchestrator._
