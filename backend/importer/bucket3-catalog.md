# F2-T3 — Catálogo del balde 3 (routing/gates deterministas)

> Generado por `backend/scripts/catalog-bucket3.js` desde la IR (`importer/corpus/`).
> **El balde 3 NO se auto-compila** (ledger §9): esto es triage léxico para confirmación
> humana + la lista de primitivas a implementar en **F3-T1**. La clasificación es ayuda, no autoridad.

## Resumen

Total de condiciones `<check>` (6 skills estructuradas): **104**.

| Categoría | Conteo | % | Significado |
|---|--:|--:|---|
| `needs_new` | 8 | 7.7% | gate determinista de servidor SIN equivalente → **candidato a primitiva NUEVA** (ver propuesta). |
| `maps_existing` | 15 | 14.4% | gate determinista que mapea a una **primitiva ya implementada** (`artifact-exists`/`count-threshold`/`all-children-status`). |
| `file_model` | 17 | 16.3% | chequeo del modelo-de-archivos de BMAD → bajo APTS el estado vive en DB: **MOOT** o mapea a `artifact-exists`. Sin primitiva nueva. |
| `runtime` | 64 | 61.5% | rama conversacional / input de usuario / elicitación → estado **await-input** del goteo (F3). NO es primitiva. |

**Lectura:** la mayoría de los `<check>` de BMAD son **runtime** (elicitación/elección de
usuario) o **file_model** (chequeos sobre `sprint-status.yaml`/story files que desaparecen
cuando el estado es servidor-autoritativo en APTS). El determinismo de servidor real se
concentra en `maps_existing` + `needs_new`, y el **routing inter-fase ya es dato** (CSV).

## Routing inter-fase declarativo (de `module-help.csv`, NO de `<check>`)

Ya cargado en `workflow_definitions.metadata.routing` (T2). Es el DAG que `apts_next` recorre.

| Skill | fase | required | preceded_by | followed_by |
|---|---|:--:|---|---|
| bmad-agent-tech-writer | anytime |  | — | — |
| bmad-check-implementation-readiness | solutioning | ✓ | bmad-create-epics-and-stories | — |
| bmad-checkpoint-preview | implementation |  | — | — |
| bmad-code-review | implementation |  | bmad-dev-story | — |
| bmad-correct-course | anytime |  | — | — |
| bmad-create-architecture | solutioning | ✓ | — | — |
| bmad-create-epics-and-stories | solutioning | ✓ | bmad-create-architecture | — |
| bmad-create-story | implementation | ✓ | bmad-sprint-planning, bmad-create-story:create | bmad-create-story:validate, bmad-dev-story |
| bmad-dev-story | implementation | ✓ | bmad-create-story:validate | — |
| bmad-document-project | anytime |  | — | — |
| bmad-domain-research | analysis |  | — | — |
| bmad-generate-project-context | anytime |  | — | — |
| bmad-investigate | implementation |  | — | false |
| bmad-market-research | analysis |  | — | — |
| bmad-prd | planning | ✓ | bmad-product-brief | — |
| bmad-prfaq | analysis |  | — | — |
| bmad-product-brief | analysis |  | — | — |
| bmad-qa-generate-e2e-tests | implementation |  | bmad-dev-story | — |
| bmad-quick-dev | anytime |  | — | — |
| bmad-retrospective | implementation |  | bmad-code-review | — |
| bmad-sprint-planning | implementation | ✓ | — | — |
| bmad-sprint-status | implementation |  | bmad-sprint-planning | — |
| bmad-technical-research | analysis |  | — | — |
| bmad-ux | planning |  | bmad-prd | — |

## Primitivas existentes (F1, implementadas)

- `artifact-exists`
- `count-threshold`
- `all-children-status`

## ⭐ Primitivas NUEVAS requeridas (a implementar en F3-T1)

Propuesta de ingeniería derivada del bucket `needs_new` (8 condiciones).
Cada una se **confirma a mano** contra las condiciones reales antes de implementar.

### `entity-status` — Entity status equals (gate)

Verdadero si una entidad concreta (story/epic/initiative) está en el status dado. Complementa all-children-status (agregado) con el chequeo de UNA unidad. Cubre: "epic status is done", "story status == review", "current_status == ready-for-dev".

`params_schema`: `{"target":"string","status":"string"}`

### `count-compare` — Count comparison (gate)

Comparación numérica general (>, >=, <, <=, ==) de un conteo/índice contra un umbral. Generaliza count-threshold (que solo hace >= min). Cubre: "story_num > 1", "completion_percentage >= 90", "debt_count > 10", "prev_epic_num < 1".

`params_schema`: `{"metric":"string","op":"string","value":"number"}`

### `next-sibling-exists` — Next sibling exists (router)

Verdadero si existe el siguiente hermano en una secuencia (p. ej. epic siguiente, story siguiente en el sprint). Enruta el cierre de ciclo épico/sprint. Cubre: "next epic found/NOT found", "first story in epic", "previous story exists".

`params_schema`: `{"sequence":"string","from":"string"}`

## Condiciones por categoría (worklist de triage)

### `needs_new` (8)

needs_new — gate determinista de servidor SIN equivalente → **candidato a primitiva NUEVA** (ver propuesta).


**bmad-create-story**

- (step 1) `this is first story in epic {{epic_num}}`
- (step 1) `this is first story in epic {{epic_num}}`

**bmad-retrospective**

- (step 1) `{user_name} provides different epic number`
- (step 1) `{{epic_number}} still not determined`
- (step 3) `{{prev_epic_num}} < 1`

**bmad-sprint-status**

- (step 2) `any status is unrecognized`
- (step 30) `any required field missing`
- (step 30) `development_status missing or empty`

### `maps_existing` (15)

maps_existing — gate determinista que mapea a una **primitiva ya implementada** (`artifact-exists`/`count-threshold`/`all-children-status`).


**bmad-create-story**

- (step 1) `epic status is 'done'`
- (step 1) `epic status is not one of: backlog, contexted, in-progress, done`
- (step 1) `epic status is 'done'`
- (step 1) `epic status is not one of: backlog, contexted, in-progress, done`
- (step 2) `previous story exists AND git repository detected`

**bmad-dev-story**

- (step 1) `{{story_path}} is provided`
- (step 3) `Senior Developer Review section exists`
- (step 3) `Senior Developer Review section does NOT exist`
- (step 4) `{{current_status}} is neither ready-for-dev nor in-progress`
- (step 8) `task is review follow-up (has [AI-Review] prefix)`
- (step 8) `ALL validation gates pass AND tests ACTUALLY exist and pass`
- (step 8) `review_continuation == true and {{resolved_review_items}} is not empty`

**bmad-retrospective**

- (step 1) `epic is not complete`
- (step 1) `epic is complete`
- (step 6) `previous retrospective exists`

### `file_model` (17)

file_model — chequeo del modelo-de-archivos de BMAD → bajo APTS el estado vive en DB: **MOOT** o mapea a `artifact-exists`. Sin primitiva nueva.


**bmad-create-story**

- (step 1) `sprint status file does NOT exist`
- (step 3) `architecture file is single file`
- (step 3) `architecture is sharded to folder`
- (step 6) `sprint status file exists`

**bmad-dev-story**

- (step 1) `{{sprint_status}} file exists`
- (step 1) `{{sprint_status}} file does NOT exist`
- (step 4) `{{sprint_status}} file exists`
- (step 4) `{{sprint_status}} file does NOT exist`
- (step 4) `{{current_status}} == 'ready-for-dev' AND story file YAML frontmatter does NOT contain baseline_commit`
- (step 4) `{{sprint_status}} file exists`
- (step 4) `{{sprint_status}} file does NOT exist`
- (step 9) `{sprint_status} file exists AND {{current_sprint_status}} != 'no-sprint-tracking'`
- (step 9) `{sprint_status} file does NOT exist OR {{current_sprint_status}} == 'no-sprint-tracking'`
- (step 10) `{sprint_status} file exists`

**bmad-retrospective**

- (step 4) `sharded epic file found`
- (step 4) `sharded epic not found`

**bmad-sprint-status**

- (step 1) `file not found`

### `runtime` (64)

runtime — rama conversacional / input de usuario / elicitación → estado **await-input** del goteo (F3). NO es primitiva.


**bmad-correct-course**

- (step 3) `mode is Incremental`
- (step 5) `no or revise`
- (step 5) `yes the proposal is approved by the user`
- (step 5) `Minor scope`
- (step 5) `Moderate scope`
- (step 5) `Major scope`

**bmad-create-story**

- (step 1) `{{story_path}} is provided by user or user provided the epic and story number such as 2-4 or 1.6 or epic 1 story 5`
- (step 1) `user chooses 'q'`
- (step 1) `user chooses '1'`
- (step 1) `user provides epic-story number`
- (step 1) `user provides story docs path`
- (step 1) `no user input provided`
- (step 1) `no backlog story found`
- (step 1) `no backlog story found`
- (step 2) `∅ sin condición`
- (step 5) `previous story learnings available`
- (step 5) `git analysis completed`
- (step 5) `web research completed`

**bmad-dev-story**

- (step 1) `no ready-for-dev or in-progress story found`
- (step 1) `user chooses '1'`
- (step 1) `user chooses '2'`
- (step 1) `user chooses '3'`
- (step 1) `user chooses '4'`
- (step 1) `user provides story file path`
- (step 1) `no ready-for-dev stories found in story files`
- (step 1) `user chooses '1'`
- (step 1) `user chooses '2'`
- (step 1) `user chooses '3'`
- (step 1) `ready-for-dev story found in files`
- (step 4) `{{current_status}} == 'ready-for-dev' OR (review_continuation == true AND {{current_status}} != 'in-progress')`
- (step 4) `{{current_status}} == 'in-progress'`
- (step 8) `ANY validation fails`
- (step 9) `story key not found in sprint status`
- (step 10) `user asks for explanations`

**bmad-retrospective**

- (step 1) `{{detected_epic}} found`
- (step 1) `{user_name} confirms`
- (step 1) `{{detected_epic}} NOT found in sprint-status`
- (step 1) `user says no`
- (step 3) `∅ sin condición`
- (step 3) `previous retrospectives found`
- (step 3) `no previous retro found`
- (step 4) `whole epic file found`
- (step 4) `next epic found`
- (step 4) `next epic NOT found`
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
- (step 2) `user provided corrections`
- (step 5) `choice == 1`
- (step 5) `choice == 2`
- (step 5) `choice == 3`
- (step 5) `choice == 4`
- (step 30) `missing`
- (step 30) `any invalid status found`

