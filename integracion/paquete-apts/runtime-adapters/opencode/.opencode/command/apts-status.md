---
description: "Read current APTS project context (tasks, backlog, recent logs) and summarize it."
---
<!-- GENERADO — no editar; fuente: spec/apts-surface.json -->

Summarize the current APTS project state (read-only).

1. Call `read_project_context` (prefer `view = compact`) to fetch tasks, backlog, and recent logs.
2. Present a concise summary: active and `stalled` tasks, `ready`/`blocked` backlog counts, and the most recent progress logs.
3. Do not modify any APTS state; this command only reads.

Optional filter (for example: only blocked items): $ARGUMENTS
