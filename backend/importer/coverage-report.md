# F2 — Reporte de cobertura del importador (T1)

> Generado por `backend/scripts/import-bmad.js`. Fuente: github.com/bmad-code-org/BMAD-METHOD @ v6.8.0
> (tag anotado `c3769ab` → commit `3bcd6c3`). **Cero escrituras a DB** (T1).

## Resumen

| Métrica | Valor |
|---|---|
| Skills parseadas → IR | **31** (6 agentes, 25 workflows) |
| Saltadas (DEPRECATED) | 3 (bmad-create-prd, bmad-edit-prd, bmad-validate-prd) |
| Dialecto | 6 structured, 25 prose |
| Steps generativos (balde 2) | 137 |
| `<ask>` (elicitación) | 11 |
| `<template-output>` | 38 |
| Templates (balde 1) | 20 |
| Checklists (balde 1) | 7 |
| `<check>` candidatas (balde 3) | 104 |

### Por fase

| Fase | Skills |
|---|---|
| analysis | 6 |
| anytime | 7 |
| implementation | 10 |
| planning | 4 |
| solutioning | 4 |

## Cobertura automática baldes 1–2

- **Entidades (balde 1):** 6/6 agentes con persona extraída = **100%**.
- **Steps generativos (balde 2):** 25/25 workflows con ≥1 step = **100%**.
- **Routing (CSV):** 24/31 skills con fila en `module-help.csv`.
  - Sin fila de routing: bmad-agent-analyst, bmad-agent-pm, bmad-agent-ux-designer, bmad-agent-architect, bmad-agent-dev, bmad-advanced-elicitation, bmad-help.

## Catálogo balde 3 (NO auto-compilado — triage T3)

Los `<check if>` son lenguaje natural (decisión F2): se extraen como candidatas, no se compilan.
Total: **104** `<check>` en 6 skills estructuradas (102 con condición textual; 2 sin atributo `if`).
El routing inter-fase determinista sale de `module-help.csv` (ver IR `.routing`).
La **lista de primitivas faltantes** a implementar en backend se decide en **T3** a partir de este catálogo.

<details><summary>Condiciones `&lt;check&gt;` por skill (102)</summary>


**bmad-correct-course**

- (step 3) `mode is Incremental`
- (step 5) `no or revise`
- (step 5) `yes the proposal is approved by the user`
- (step 5) `Minor scope`
- (step 5) `Moderate scope`
- (step 5) `Major scope`

**bmad-create-story**

- (step 1) `{{story_path}} is provided by user or user provided the epic and story number such as 2-4 or 1.6 or epic 1 story 5`
- (step 1) `sprint status file does NOT exist`
- (step 1) `user chooses 'q'`
- (step 1) `user chooses '1'`
- (step 1) `user provides epic-story number`
- (step 1) `user provides story docs path`
- (step 1) `no user input provided`
- (step 1) `no backlog story found`
- (step 1) `this is first story in epic {{epic_num}}`
- (step 1) `epic status is 'done'`
- (step 1) `epic status is not one of: backlog, contexted, in-progress, done`
- (step 1) `no backlog story found`
- (step 1) `this is first story in epic {{epic_num}}`
- (step 1) `epic status is 'done'`
- (step 1) `epic status is not one of: backlog, contexted, in-progress, done`
- (step 2) `previous story exists AND git repository detected`
- (step 3) `architecture file is single file`
- (step 3) `architecture is sharded to folder`
- (step 5) `previous story learnings available`
- (step 5) `git analysis completed`
- (step 5) `web research completed`
- (step 6) `sprint status file exists`

**bmad-dev-story**

- (step 1) `{{story_path}} is provided`
- (step 1) `{{sprint_status}} file exists`
- (step 1) `no ready-for-dev or in-progress story found`
- (step 1) `user chooses '1'`
- (step 1) `user chooses '2'`
- (step 1) `user chooses '3'`
- (step 1) `user chooses '4'`
- (step 1) `user provides story file path`
- (step 1) `{{sprint_status}} file does NOT exist`
- (step 1) `no ready-for-dev stories found in story files`
- (step 1) `user chooses '1'`
- (step 1) `user chooses '2'`
- (step 1) `user chooses '3'`
- (step 1) `ready-for-dev story found in files`
- (step 3) `Senior Developer Review section exists`
- (step 3) `Senior Developer Review section does NOT exist`
- (step 4) `{{sprint_status}} file exists`
- (step 4) `{{sprint_status}} file does NOT exist`
- (step 4) `{{current_status}} == 'ready-for-dev' AND story file YAML frontmatter does NOT contain baseline_commit`
- (step 4) `{{sprint_status}} file exists`
- (step 4) `{{current_status}} == 'ready-for-dev' OR (review_continuation == true AND {{current_status}} != 'in-progress')`
- (step 4) `{{current_status}} == 'in-progress'`
- (step 4) `{{current_status}} is neither ready-for-dev nor in-progress`
- (step 4) `{{sprint_status}} file does NOT exist`
- (step 8) `task is review follow-up (has [AI-Review] prefix)`
- (step 8) `ALL validation gates pass AND tests ACTUALLY exist and pass`
- (step 8) `ANY validation fails`
- (step 8) `review_continuation == true and {{resolved_review_items}} is not empty`
- (step 9) `{sprint_status} file exists AND {{current_sprint_status}} != 'no-sprint-tracking'`
- (step 9) `{sprint_status} file does NOT exist OR {{current_sprint_status}} == 'no-sprint-tracking'`
- (step 9) `story key not found in sprint status`
- (step 10) `user asks for explanations`
- (step 10) `{sprint_status} file exists`

**bmad-retrospective**

- (step 1) `{{detected_epic}} found`
- (step 1) `{user_name} confirms`
- (step 1) `{user_name} provides different epic number`
- (step 1) `{{detected_epic}} NOT found in sprint-status`
- (step 1) `{{epic_number}} still not determined`
- (step 1) `epic is not complete`
- (step 1) `user says no`
- (step 1) `epic is complete`
- (step 3) `previous retrospectives found`
- (step 3) `no previous retro found`
- (step 3) `{{prev_epic_num}} < 1`
- (step 4) `sharded epic file found`
- (step 4) `sharded epic not found`
- (step 4) `whole epic file found`
- (step 4) `next epic found`
- (step 4) `next epic NOT found`
- (step 6) `previous retrospective exists`
- (step 7) `{{next_epic_exists}} == false`
- (step 8) `significant discoveries detected`
- (step 8) `no significant discoveries`
- (step 9) `{user_name} expresses concerns`
- (step 9) `not yet deployed`
- (step 9) `acceptance incomplete or feedback pending`
- (step 9) `{user_name} expresses stability concerns`
- (step 9) `blockers identified`
- (step 11) `update successful`
- (step 11) `retrospective key not found`

**bmad-sprint-status**

- (step 0) `mode == data`
- (step 0) `mode == validate`
- (step 0) `mode == interactive`
- (step 1) `file not found`
- (step 2) `any status is unrecognized`
- (step 2) `user provided corrections`
- (step 5) `choice == 1`
- (step 5) `choice == 2`
- (step 5) `choice == 3`
- (step 5) `choice == 4`
- (step 30) `missing`
- (step 30) `any required field missing`
- (step 30) `development_status missing or empty`
- (step 30) `any invalid status found`

</details>

## Por skill

| Skill | kind | dialecto | fase | steps | checks | asks | tmpl-out | templates | checklists | refs |
|---|---|---|---|--:|--:|--:|--:|--:|--:|--:|
| bmad-agent-analyst | agent | prose | analysis | 1 | 0 | 0 | 0 | 0 | 0 | 21 |
| bmad-agent-tech-writer | agent | prose | anytime | 1 | 0 | 0 | 0 | 0 | 0 | 21 |
| bmad-document-project | workflow | prose | anytime | 2 | 0 | 0 | 0 | 4 | 1 | 15 |
| bmad-prfaq | workflow | prose | analysis | 4 | 0 | 0 | 0 | 1 | 0 | 17 |
| bmad-product-brief | workflow | prose | analysis | 6 | 0 | 0 | 0 | 1 | 0 | 21 |
| bmad-domain-research | workflow | prose | analysis | 4 | 0 | 0 | 0 | 1 | 0 | 15 |
| bmad-market-research | workflow | prose | analysis | 4 | 0 | 0 | 0 | 1 | 0 | 15 |
| bmad-technical-research | workflow | prose | analysis | 4 | 0 | 0 | 0 | 1 | 0 | 15 |
| bmad-agent-pm | agent | prose | planning | 1 | 0 | 0 | 0 | 0 | 0 | 21 |
| bmad-agent-ux-designer | agent | prose | planning | 1 | 0 | 0 | 0 | 0 | 0 | 21 |
| bmad-prd | workflow | prose | planning | 6 | 0 | 0 | 0 | 2 | 1 | 25 |
| bmad-ux | workflow | prose | planning | 8 | 0 | 0 | 0 | 1 | 0 | 27 |
| bmad-agent-architect | agent | prose | solutioning | 1 | 0 | 0 | 0 | 0 | 0 | 21 |
| bmad-check-implementation-readiness | workflow | prose | solutioning | 3 | 0 | 0 | 0 | 1 | 0 | 15 |
| bmad-create-architecture | workflow | prose | solutioning | 3 | 0 | 0 | 0 | 1 | 0 | 15 |
| bmad-create-epics-and-stories | workflow | prose | solutioning | 3 | 0 | 0 | 0 | 1 | 0 | 15 |
| bmad-generate-project-context | workflow | prose | anytime | 3 | 0 | 0 | 0 | 1 | 0 | 16 |
| bmad-agent-dev | agent | prose | implementation | 1 | 0 | 0 | 0 | 0 | 0 | 21 |
| bmad-checkpoint-preview | workflow | prose | implementation | 3 | 0 | 0 | 0 | 0 | 0 | 12 |
| bmad-code-review | workflow | prose | implementation | 3 | 0 | 0 | 0 | 0 | 0 | 13 |
| bmad-correct-course | workflow | structured | anytime | 6 | 6 | 3 | 0 | 0 | 1 | 18 |
| bmad-create-story | workflow | structured | implementation | 6 | 23 | 1 | 13 | 1 | 1 | 21 |
| bmad-dev-story | workflow | structured | implementation | 10 | 33 | 4 | 0 | 0 | 1 | 17 |
| bmad-investigate | workflow | prose | implementation | 4 | 0 | 0 | 0 | 1 | 0 | 19 |
| bmad-qa-generate-e2e-tests | workflow | prose | implementation | 8 | 0 | 0 | 0 | 0 | 1 | 14 |
| bmad-quick-dev | workflow | prose | anytime | 5 | 0 | 0 | 0 | 1 | 0 | 15 |
| bmad-retrospective | workflow | structured | implementation | 13 | 28 | 1 | 0 | 0 | 0 | 24 |
| bmad-sprint-planning | workflow | structured | implementation | 5 | 0 | 0 | 0 | 1 | 1 | 30 |
| bmad-sprint-status | workflow | structured | implementation | 8 | 14 | 2 | 25 | 0 | 0 | 15 |
| bmad-advanced-elicitation | workflow | prose | anytime | 4 | 0 | 0 | 0 | 0 | 0 | 2 |
| bmad-help | workflow | prose | anytime | 6 | 0 | 0 | 0 | 0 | 0 | 3 |

## CSV: filas ragged (balde 3, robustez)

- línea 32 (`bmad-investigate`): 12 cols (esperaba 13)

## Notas de implementación (refinamientos IR no-disruptivos)

- `checklists[]` agregado como hermano de `templates[]`: el esquema aprobado listó solo
  `templates[]`, pero balde 1 incluye checklists explícitamente y el corpus trae 7.
- structured: `workflow_critical[]` (constraints `<critical>` a nivel `<workflow>`).
- prose: `dropped_sections[]` (secciones-andamiaje descartadas: On Activation/Conventions/Paths).
- Censo corregido: bmm tiene **32 SKILL.md** (6 agentes + 26 workflows), no 38. El "44/38" del
  diseño contaba bmm+core juntos (32+12). Scope intent ("lifecycle completo bmm" + 2 core) intacto.
- `source.sha`: el tag anotado `v6.8.0` es objeto `c3769ab`; deref al commit `3bcd6c3`. Mismo `v6.8.0`.
