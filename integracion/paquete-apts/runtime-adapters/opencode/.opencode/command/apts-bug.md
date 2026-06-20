---
description: "Triage a reported bug read-only and, on explicit confirmation, track it as a bug item in APTS."
agent: apts-bugfix-intake
---
<!-- GENERADO — no editar; fuente: spec/apts-surface.json -->

Triage a reported bug read-only before any implementation.

1. Run read-only triage to decide whether the symptom is a real defect or only a question.
2. Search APTS with `search_similar_bug_reports` and reuse an existing bug item when the scope already exists.
3. Create or update a `bug` item only after the user explicitly confirms tracking; otherwise return `NEEDS_CONFIRMATION`.

Bug report or symptom to triage: $ARGUMENTS

_Runs via agent: APTS Bugfix Intake._
