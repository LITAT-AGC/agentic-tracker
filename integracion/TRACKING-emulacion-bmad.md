# Tracking: emulación de BMAD dentro de APTS

> Compañero de [`PLAN-emulacion-bmad.md`](./PLAN-emulacion-bmad.md).
> Este doc es **autosuficiente**: una sesión de chat nueva puede retomar leyendo solo esto + el plan.
> Marca `[x]` al completar cada tarea y actualiza "Estado global" y "Próxima acción".
> Rama: `feat/emulacion-bmad`.

## Regla de proceso (innegociable)

**Se PARA al final de cada fase.** Cada fase termina en un **GATE** de validación humana. No se
empieza la fase siguiente hasta que el operador apruebe el gate de la actual. Si una tarea revela que
una decisión del ledger estaba mal, **se detiene y se replantea**, no se improvisa.

## Cómo retomar en una sesión nueva

1. Lee este archivo entero y el PLAN.
2. Mira **Estado global** y **Próxima acción** abajo.
3. Confirma los criterios de aceptación de la tarea en curso antes de empezar.
4. Al terminar una tarea: marca el checkbox, anota archivos en el **Log de cambios** y actualiza
   **Próxima acción**.
5. Al llegar a un **GATE**: detente, presenta evidencia, espera aprobación del operador.

## Estado global

| Fase | Estado | Gate | Notas |
|---|---|---|---|
| F0 Modelo de datos y fundaciones | 🛑 En gate | esquema soporta jerarquía+flujos+goteo+multi-agente; migra limpio en `APTS_test` | T1–T3 hechos; migra/rollback/re-latest limpios en `APTS_test`; espera aprobación |
| F1 Motor determinista + `apts_next` (costo A) | ✅ Hecho | **GATE APROBADO 2026-06-20** | T1–T5 hechos. T4: 3 tools por contrato (17 ops), adaptadores idempotentes, ejercitadas vía CLI real. T5: reducción de contexto **6.8×–18.7×** (números reales). Gate aprobado por el operador |
| F2 Importador seed (BMAD v6.8 → datos) | 🛑 En gate | cobertura revisada; corpus valida; `apts_next` sobre flujos reales | **T1–T5 hechos 2026-06-20.** Cobertura balde 1–2 100%; catálogo balde 3 (104 checks→3 primitivas nuevas); 31 IR válidas; `apts_next` sobre 4 flujos reales role-aware; re-cableado 100%; idempotente. **Espera aprobación del gate.** Hallazgo: resolver multi-skill-por-fase = F3 |
| F3 Driver de goteo (costo B) | ⬜ Pendiente | `create-prd` por goteo end-to-end; contexto por paso ~constante | — |
| F4 Validación end-to-end (proyecto real) | ⬜ Pendiente | proyecto gestionado de punta a punta; métricas A y B vs BMAD; informe | — |

Leyenda: ⬜ Pendiente · 🟡 En curso · ✅ Hecho · ⛔ Bloqueado · 🛑 En gate (espera operador)

**Próxima acción:** 🛑 **F2-GATE — esperar aprobación del operador.** T1–T5 completos; evidencia
bajo "F2-GATE" abajo. NO empezar F3 sin aprobación. Para reproducir: `cd backend` →
`node scripts/import-bmad.js` (IR) → `node scripts/catalog-bucket3.js` (catálogo) →
`node scripts/rewire-bmad.js` (re-cableado) → `node seeds/bmad_seed.js` (carga DB). Estado de
`APTS_test` al cerrar: fixture toy + import bmad limpios, sin instancia demo. **Decisión pendiente
del gate:** mejora del resolver para DAG multi-skill-por-fase (hallazgo T5) → ¿F3 o replanteo aparte?
Tras aprobación, F3-T1 = implementar las 3 primitivas nuevas (`entity-status`, `count-compare`,
`next-sibling-exists`) del catálogo balde 3.

---

## F0 — Modelo de datos y fundaciones

- [x] **F0-T1** Migraciones de jerarquía: `initiatives` (track, phase, prd_artifact_id), `epics`
  (status derivado), `epic_id` nullable en `backlog_items`, enum de estado con `ready_for_dev`.
  - *Aceptación:* migra limpio en `APTS_test`; backlog plano sin épica sigue funcionando (Quick Flow).
  - *Hecho:* `backlog_items` gana `initiative_id` Y `epic_id` (ambos nullable) → plano/Quick/Method.
- [x] **F0-T2** Artefactos tipados: extender `semantic_documents` con `doc_type`, `version`, FK a
  iniciativa. `action_items`.
  - *Aceptación:* artefacto se guarda/recupera por embedding; versión incremental.
  - *Hecho:* extensión in-place, 1 fila/scope (unique intacto), `version`=contador; FK diferida
    `initiatives.prd_artifact_id → semantic_documents` cerrada aquí.
- [x] **F0-T3** Registros del método: `entities`, `workflow_definitions`, `workflow_steps`
  (kind generative|deterministic, needs[], outputs[], next_rules, iterable), `primitives_palette`,
  `project_state` (phase, asignaciones de rol).
  - *Aceptación:* esquema editable-by-design (datos, no hardcode); soporta multi-agente.
  - *Hecho:* registros del método GLOBALES (sin project_url); `project_state`=puntero por agente
    (`unique(initiative_id, agent_name)` → sin colisión); fase macro queda en `initiatives.phase`.
- [ ] **F0-GATE** 🛑 Revisión de esquema con el operador: ¿soporta jerarquía + flujos declarativos +
  goteo modelo B + multi-agente sin retrabajo? Migraciones verdes en `APTS_test`.
  - *Evidencia:* `migrate:latest`, `migrate:rollback`, `migrate:latest` corren limpios; 8 tablas
    nuevas + 17 FKs verificadas por introspección; `backlog_items_status_check` incluye `ready_for_dev`.

## F1 — Motor determinista + `apts_next` (costo A)

- [x] **F1-T1** Fixture de flujo hecha a mano (toy: **4 fases** del lifecycle, 10 steps) en los
  registros de F0 + instancia de prueba.
  - *Hecho:* seed idempotente `backend/seeds/f1_toy_fixture.js`, corrido limpio en `APTS_test`.
    Método global: 5 `entities` (analyst/pm/architect/sm/dev), 3 `primitives_palette`
    (`artifact-exists`/`count-threshold`/`all-children-status`, `implemented=false`), 4
    `workflow_definitions` (analysis→planning→solutioning→implementation), 10 `workflow_steps`
    (5 generative / 5 deterministic). Instancia: `projects` (`apts://fixture/toy`), 1 `initiative`
    (`phase=analysis`), 1 `epic`, 3 `backlog_items` (`ready_for_dev`), 3 `project_state`
    (1×pm, 2×dev → demo no-colisión).
  - *Contrato de formas JSON fijado (T2/T3 dependen):* `needs=["initiative"|"epic"|"story"|...]`;
    `outputs=[{kind:"artifact",doc_type}|{kind:"backlog_items"}|...]`; `next_rules` generative=null
    (avanza por `step_order`), gate=`{on_pass:{goto},on_fail:{goto}}` con `"__phase_done__"`=fin de
    fase; valores de gate en `workflow_steps.metadata.primitive_params` (sin columna dedicada en F0).
  - *Corrección de esquema F0:* migración 013 agrega `brief` al enum `doc_type` (analysis no tenía
    artefacto tipado). Migra/rollback/re-latest limpios en `APTS_test`.
- [x] **F1-T2** Primitivas base de gate: `artifact-exists`, `all-children-status`, `count-threshold`,
  cascada de prioridad intra-fase.
  - *Hecho:* `backend/scripts/lib/method_primitives.js` (lógica de servidor pura, patrón
    `scripts/lib/`). Firma única `async (db, ctx, params) => { pass, observed, detail }`; dispatcher
    `evaluatePrimitive`; cascada `resolvePhaseStep(db, ctx, wf, steps)` → `{ kind:
    actionable|phase_done|blocked }` (walk determinista del grafo con `visited`-set anti-ciclo;
    generative no-satisfecho corta = accionable, gates enrutan, `__phase_done__` cierra;
    `outputsSatisfied` mapea `outputs[]` a chequeos de estado y trata `dev-story` iterable por
    unidades sin terminar). Registro EN CÓDIGO = fuente de verdad de implementado;
    `reconcilePrimitiveRegistry` (opción A) setea `implemented=true`+`handler_ref` idempotente,
    cableado en la cola del seed.
  - *Aceptación:* harness throwaway contra `APTS_test` (no en repo) **17/17**: reconciliación,
    primitivas directas (incl. borde conjunto-vacío = false), y cascada en las 4 fases con estados
    intermedios forzados (analysis/planning/solutioning → actionable→phase_done; implementation →
    dev-story iterable hasta todas `done` → phase_done). Fixture restaurada a estado prístino.
- [x] **F1-T3** Resolver `apts_next` declarativo full-lifecycle (inter+intra fase), **role-aware**,
  sin colisión de historia entre agentes. Una query, payload mínimo.
  - *Hecho:* `backend/scripts/lib/method_resolver.js` (lógica de servidor pura, importa
    `resolvePhaseStep` de T2). `aptsNext(db, {project_url, agent_name})` corre todo en una transacción:
    carga iniciativa activa + puntero del caller + epic → `ctx`; **walk inter-fase** que selecciona el
    workflow de `initiatives.phase`, resuelve la cascada de T2, y en `phase_done` avanza
    `initiatives.phase` (LIFECYCLE `analysis→planning→solutioning→implementation→done`) y re-resuelve
    (set anti-ciclo); en `actionable` hace **role-matching** (`workflow_steps.entity_id ||
    default_entity_id` vs `project_state.entity_id`) y, para `dev-story` iterable, **claim sin colisión**
    (`claimDevStory`: `FOR UPDATE` sobre candidatas no-terminales, excluye las sostenidas por otro
    puntero `running`, idempotente si el caller ya sostiene una). Payload §7
    `{ next: run_step|wait|done|blocked, target_id, role, why, args:{phase,workflow_key,step_key} }`.
  - *Aceptación:* harness throwaway contra `APTS_test` (no en repo) **17/17**: role mismatch
    (pm en analysis/solutioning → wait), avance inter-fase persistido (las 4 fases → done), match
    positivo (pm en planning corre draft-prd), no-colisión (dev-1=A / dev-2=B distintas, idempotencia
    en re-pregunta, release+reclaim de C, wait al agotarse), cierre por `epic-done` gate → `done`.
    Fixture restaurada a estado prístino (`APTS_test` sin orphans; el re-seed cascadea `projects`).
- [x] **F1-T4** Tools por contrato: `apts_next`, `apts_status` (data-mode), `apts_set_status`
  (transición validada). Regenerar adaptadores.
  - *Aceptación:* `node contract-check.js` OK; adaptadores idempotentes.
  - *Hecho:* 3 tools en el contrato (`apts_skills.json`, sin oneOf/batch): `apts_next`
    {project_url,agent_name} req[]; `apts_status` {project_url,agent_name} req[]; `apts_set_status`
    {backlog_item_id,status enum[ready_for_dev,in_progress,review,done]} req[ambos]. Cliente
    (`apts-client.js`): exports `aptsNext`/`aptsStatus`/`aptsSetStatus` (camelCase derivado del
    contrato) + `AUTO_FILL_FIELDS_BY_OPERATION` (apts_next:[project_url,agent_name],
    apts_status:[project_url]). Backend (`index.js`): 3 rutas finas (apiLimiter+authenticateAgent)
    → `require('./scripts/lib/method_resolver')`: `POST /api/projects/next`→`aptsNext`,
    `GET /api/projects/method-status`→`methodStatus` (conteos + recomendación **read-only**,
    aptsNext en trx con rollback para no mutar), `PATCH /api/backlog/:id/method-status`→`setMethodStatus`
    (máquina lineal, 409 inválida / 404 inexistente). `method_resolver.js` gana `methodStatus`,
    `setMethodStatus`, `STORY_METHOD_STATUSES/TRANSITIONS`, `MethodStatusError`. Manifiesto público:
    `schema_version` 2.1.0→**2.2.0** (minor aditivo) + nota append-only prepended; `artifactVersion`+
    `updatedInSchemaVersion`→2.2.0 en skills_json/js_client/mcp_server/js_cli. Adaptadores
    regenerados (idempotentes; 3 entradas nuevas `mcp__apts__apts_{next,status,set_status}` en
    `claude/.claude/settings.json`).
  - *Aceptación cumplida:* `contract-check.js` → **17 ops alineadas**; `generate-adapters.js` 2×
    → árbol idéntico (sin delta sin-stagear); `apts_next` ejercitado **VÍA LA TOOL real** (apts-cli)
    contra `APTS_test`+fixture, reproduciendo T3: role mismatch→wait, avance inter-fase persistido
    (analysis→…→implementation→done), claim sin colisión dev-1≠dev-2 + idempotencia, cierre
    `epic-done`→done; `apts_status` (conteos + recomendación, sin mutar fase verificado);
    `apts_set_status` válidas 200 / 409 backward+terminal (con `error_code`) / 400 enum. `APTS_test`
    restaurado a estado prístino (re-seed cascada, 0 artefactos staged remanentes).
- [x] **F1-T5** Medición de contexto: comparar tokens de `apts_next` vs el equivalente "LLM lee el
  estado y razona el routing". Registrar números.
  - *Método:* medición throwaway (no en repo) sobre la fixture toy en `APTS_test` (estado prístino,
    fase analysis). Compara el **footprint completo de contexto del agente por decisión**: (A) el
    round-trip de `apts_next` (request `{project_url,agent_name}` + payload §7) vs (B) el equivalente
    BMAD-nativo donde el LLM **carga e interpreta** la máquina de estados (reglas del método) **y
    lee el estado** del proyecto, serializado en **JSON compacto** (conservador: BMAD real envía
    SKILL.md verboso YAML+markdown). Tokens = `ceil(chars/4)` (aproximación reproducible cl100k,
    no exacta por modelo; no hay tokenizer en el repo y no se agregó dependencia). Chars/bytes son
    exactos y reproducibles.
  - *Números reales (por decisión):*
    | Artefacto | chars | ~tokens |
    |---|---|---|
    | **A** `apts_next` request + payload §7 (total) | 290 | ~73 |
    | B — reglas del método (solo fase activa) | 1 217 | ~305 |
    | B — reglas del método (lifecycle completo, 4 wf) | 4 664 | ~1 166 |
    | B — estado vivo del proyecto | 759 | ~190 |
    | **B1** baseline charitable (fase activa + estado) | 1 976 | ~494 |
    | **B2** baseline paridad full-lifecycle (4 wf + estado) | 5 423 | ~1 356 |
  - *Reducción de costo A:* A vs **B1** = **6.8× menos** (−85.2%); A vs **B2** = **18.7× menos**
    (−94.7%). B2 es la comparación de paridad real: `apts_next` resuelve el routing full-lifecycle
    (inter-fase) que el LLM tendría que cargar entero. La medición **excluye** los tokens de
    razonamiento in-context para interpretar la máquina de estados y el preámbulo de activación del
    SKILL.md — ambos son costo-A real de BMAD y **ensancharían** la brecha. Tesis costo-A demostrada
    con números reales.
- [x] **F1-GATE** ✅ **APROBADO 2026-06-20.** `apts_next` correcto sobre fixture; multi-agente sin
  colisión; reducción de contexto demostrada con números reales.
  - *Evidencia:* (T4) `apts_next/status/set_status` ejercitados vía CLI real contra `APTS_test`+
    fixture: role match/mismatch, avance inter-fase persistido (analysis→…→implementation→done),
    claim dev-1≠dev-2 + idempotencia, cierre `epic-done`→done, `apts_status` read-only, transiciones
    válidas/409/400. (T5) reducción de contexto 6.8×–18.7× (números arriba). Contract-check 17/17,
    adaptadores idempotentes. **Espera aprobación del operador.**

## F2 — Importador seed (corpus BMAD v6.8 → datos)

### § Diseño F2 aprobado (2026-06-20)

Diseño del importador **aprobado por el operador** tras recon del corpus real. Es autosuficiente:
una sesión nueva codea T1 contra esto sin re-derivar.

**Fuente:** `github.com/bmad-code-org/BMAD-METHOD` @ tag **`v6.8.0`** (`c3769ab`). Clone **temporal**
en `%TEMP%/bmad-recon` (fuera del working tree; NO se committea el clone). Licencia **MIT** (BMad
Code, LLC 2025) + marca registrada "BMad"/"BMAD" → `NOTICE` reproduce copyright MIT y respeta la
decisión de marca ya cerrada.

**Layout del corpus (v6.8 reestructuró; ya no existe `_bmad/`):**
- `src/bmm-skills/{1-analysis,2-plan-workflows,3-solutioning,4-implementation}/` — mapea 1:1 al
  lifecycle de 4 fases de APTS.
- `src/core-skills/` — transversales (help, advanced-elicitation, brainstorming, shard-doc…).
- **Anatomía por skill:** dir con `SKILL.md` (frontmatter `name`/`description` + cuerpo) +
  `customize.toml`, y opcionales `template.md` / `checklist.md` / `discover-inputs.md`.
- Censo: **44 SKILL.md** (6 agentes `bmad-agent-*`, 38 workflows), 33 `customize.toml`, 2 templates,
  6 checklists.

**3 hallazgos que definen el parser (refinan el plan, no contradicen el ledger):**
1. **Routing inter-fase YA es dato:** `src/bmm-skills/module-help.csv` con columnas
   `skill, phase, preceded-by, followed-by, required, output-location, outputs` = el DAG de lifecycle
   que `apts_next` recorre. Se usa **eso** como fuente del routing macro, no los `<check>`.
2. **DOS dialectos de ejecución:** (a) **estructurado XML** `<workflow><step n goal><action>`
   `<check if><output><ask><template-output><goto>` — exactamente **6 skills, todas en
   `4-implementation`**: `create-story, dev-story, sprint-planning, sprint-status, correct-course,
   retrospective`. (b) **prosa markdown** (`## Discovery / ## Constraints / ## Finalize…`, sin tags) —
   las 32 workflows de análisis/planning/solutioning. El determinismo se concentra en implementation.
3. **Los `<check if="...">` son lenguaje natural** (`"sprint status file does NOT exist"`,
   `"story_num > 1"`) → **balde 3 NO se auto-compila**; se extrae `{condición, rama_true, rama_false,
   ubicación}` y se cataloga para triage backend. Vocabulario de tags XML:
   `action(445) check(104) output(102) step(48) template-output(38) critical(23) guideline(17)
   ask(11) goto(8)`.

**Scope v1 (decisión del operador):** **lifecycle completo bmm** = 38 workflows + 6 agentes de
`src/bmm-skills`, + core-skills que el lifecycle invoca (`advanced-elicitation`, `help`). Resto de
core-skills no se importa en v1.

**Scope de T1 (acotado):** clonar + parsear → **IR (Representación Intermedia) + reporte de
cobertura**. **CERO escrituras a DB en T1** (eso es T2 baldes 1–2 → `entities`/`workflow_steps`,
y T3 balde 3 → reglas + primitivas faltantes). La IR es la costura T1↔T2/T3.

**IR — un JSON por skill, committeada (decisión del operador) en `backend/importer/corpus/`:**
```jsonc
{
  "source": { "repo","tag":"v6.8.0","sha":"c3769ab","path" },
  "kind": "agent"|"workflow", "key", "phase",            // phase de module-help.csv / prefijo de dir
  "frontmatter": { "name","description" },
  "entity": { "name","title","icon","role","identity","communication_style","principles":[],"persona_md","menu":[] }, // agentes = BALDE 1
  "dialect": "structured"|"prose",
  "steps": [ { "n","goal",
      "generative": { "instruction_md","asks":[],"template_outputs":[] },  // BALDE 2
      "checks":     [ { "condition_text","true","false","raw" } ],         // BALDE 3 (candidatas)
      "control":    [ "HALT" | { "goto":"2a" } ] } ],
  "routing":   { "preceded_by","followed_by","required","outputs","output_location" }, // BALDE 3 (CSV)
  "templates": [ { "name","body_md" } ],                 // BALDE 1
  "unresolved_refs": [ "{project-root}/_bmad/...", "resolve_customization.py", ... ] // worklist T4 re-cableado
}
```
El parser **auto-detecta dialecto** por presencia de `<step>`. Prosa → cada `## sección` con
instrucción = un step generativo; se descartan secciones-andamiaje (`Conventions`/`On Activation`/
`Paths`) = re-cableado BMAD, no ADN. Skills `DEPRECATED` (p. ej. `bmad-create-prd`→`bmad-prd`) se
saltan y se sigue al canónico.

**Layout de archivos (honra `scripts/lib`=lógica pura, scripts ejecutables aparte):**
- `backend/scripts/importer/` — parser modular puro (`dialect_structured.js`, `dialect_prose.js`,
  `agent.js`, `routing_csv.js`, `classify.js`).
- `backend/scripts/import-bmad.js` — entry CLI: clone (o ruta dada) → parsea → escribe IR + reporte.
- `backend/importer/{corpus/*.json, coverage-report.md, NOTICE}` — salida committeada.
- (T2/T3) loader idempotente `backend/seeds/bmad_seed.js`, separado de la fixture toy.

**Idempotencia / no-colisión:** importador usa `source_ref: bmad:v6.8.0` y keys namespaced
(`bmad-agent-pm`, `bmad-dev-story`) → re-run borra-por-`source_ref` y reinserta, **sin pisar** la
fixture toy (`source_ref: fixture:f1-toy`) ni las primitivas `implemented` (el registro en código
sigue siendo la autoridad, decisión F1).

- [x] **F2-T1** Clonar BMAD v6.8 (temporal) y parsear: frontmatter, persona, principios, templates,
  checklists, `<step>/<action>/<check>`. **Hecho 2026-06-20.**
  - *Hecho:* parser modular puro `backend/scripts/importer/` (`toml_min.js` subconjunto TOML,
    `classify.js` frontmatter/dialecto/fase/andamiaje/refs, `dialect_structured.js`,
    `dialect_prose.js`, `agent.js`, `routing_csv.js`, `parse_skill.js`) + entry CLI
    `backend/scripts/import-bmad.js`. Salida committeada `backend/importer/{corpus/*.json (31),
    coverage-report.md, NOTICE}`. **CERO escrituras a DB.** Idempotente (2 corridas → salida
    byte-idéntica; sin `Date`/random).
  - *Cobertura:* **31 skills** → IR (6 agentes + 23 workflows bmm + 2 core `advanced-elicitation`/
    `help`); **3 DEPRECATED saltadas** (`bmad-create-prd/edit-prd/validate-prd` → forwardean a
    `bmad-prd` canónico). Balde 1: **6/6 agentes** con persona (100%). Balde 2: **25/25 workflows**
    con ≥1 step generativo (100%, 137 steps). Balde 3: **104 `<check>`** catalogados (102 con
    condición textual, no auto-compilados) + routing inter-fase desde `module-help.csv` en `.routing`.
  - *Validación de fidelidad:* el vocabulario de tags del parser estructurado coincide EXACTO con el
    recon: `step(48)`, `check(104)`, `template-output(38)`, `ask(11)`. 31/31 IR estructuralmente
    válidas (campos requeridos presentes; agentes con `entity`).
  - *Correcciones de recon (no contradicen el diseño; ver Log de decisiones):* censo real bmm =
    **32 SKILL.md** (6 agentes + 26 workflows), no 38 (el "44/38" contaba bmm+core juntos); `source`
    sha = tag anotado `c3769ab` deref a commit `3bcd6c3` (mismo `v6.8.0`).
- [x] **F2-T2** Balde 1–2 → volcar `entities` + `workflow_steps` (generative). **Hecho 2026-06-20.**
  - *Hecho:* loader idempotente `backend/seeds/bmad_seed.js` (separado de la fixture toy,
    `source_ref: bmad:v6.8.0`, keys namespaced). Vuelca desde la IR committeada: **6 entities**
    (personas de agentes, balde 1), **31 workflow_definitions**, **137 workflow_steps**
    (kind=generative, balde 2, ADN verbatim en `instruction_chunk`; `template_slice` desde
    `<template-output>`). Routing CSV + `workflow_critical` en `def.metadata`; `asks`/`checks`
    (balde 3, candidatas)/`control` en `step.metadata` (preservados, NO como prompt).
  - *Validado contra `APTS_test`:* idempotente (re-run → mismos conteos); fixture toy intacta
    (5 entities/4 defs); `anytime`→phase enum `null` con `phase_raw` conservado.
  - *Diferido (anotado):* `needs[]`/`outputs[]` por step e `iterable` (dev-story) = F3-wiring;
    `entity_id`/`default_entity_id` por step (rol) = T5/F3; deterministas = T3.
- [x] **F2-T3** Balde 3 → catálogo de routing+gates + **lista de primitivas faltantes**. **Hecho 2026-06-20.**
  - *Hecho:* `backend/scripts/importer/bucket3.js` (clasificador léxico puro) +
    `backend/scripts/catalog-bucket3.js` (entry) → `backend/importer/bucket3-catalog.md`.
    **NO auto-compila** (ledger §9): triage léxico para confirmación humana. **104 condiciones**
    `<check>` clasificadas: **runtime 64** (elicitación/elección → await-input F3), **file_model 17**
    (modelo-archivos BMAD → MOOT en APTS server-state), **maps_existing 15** (→ 3 primitivas F1),
    **needs_new 8**. Routing inter-fase = dato (CSV, ya en `def.metadata.routing`).
  - *Lista de primitivas NUEVAS a implementar en F3-T1:* `entity-status` (status de UNA unidad),
    `count-compare` (comparación numérica general), `next-sibling-exists` (secuencia épica/sprint).
- [x] **F2-T4** Re-cableado de referencias BMAD → APTS; `NOTICE` de atribución; idempotencia. **Hecho 2026-06-20.**
  - *Hecho:* re-cableado como **mapa declarativo** (no muta el ADN verbatim, ledger):
    `backend/scripts/importer/rewire.js` (reglas + `classifyRef` + `applyRewire`) +
    `backend/scripts/rewire-bmad.js` (entry) → `backend/importer/rewire-map.json`. **79 refs
    distintas, cobertura 100%** en 7 clases (server_resolved 26, state 18, artifact_location 11,
    config/artifact_content 7, persona_field 6, template 4). Aplicado en serve-time por el goteo (F3).
  - `NOTICE` (escrito en T1) cubre atribución MIT + decisión de marca.
  - *Idempotencia (verificada en `APTS_test`):* import T1 byte-idéntico ×2; `bmad_seed` ×2 estable;
    re-run NO pisa la fixture toy (`fixture:f1-toy`) ni las 3 primitivas implementadas.
- [x] **F2-T5** `apts_next` corre sobre flujos reales importados (no fixtures). **Hecho 2026-06-20.**
  - *Hecho:* harness throwaway (no en repo, patrón F1) sobre instancia real del corpus bmad en
    `APTS_test`. `apts_next` devuelve **steps reales** (ADN verbatim) role-aware en las 4 fases:
    analysis→`bmad-product-brief`, planning→`bmad-prd`, solutioning→`bmad-create-architecture`,
    implementation→`bmad-sprint-planning`; role mismatch (dev en analysis)→`wait`. Instancia
    demo limpiada; `APTS_test` restaurado (bmad re-seed + fixture toy).
  - *⚠️ HALLAZGO DE DISEÑO (para el gate):* el corpus real es **multi-skill-por-fase** (DAG, p. ej.
    planning tiene 4 workflows), pero `selectPhaseWorkflow` del resolver (F1) asume **~1 workflow
    por fase** (modelo del toy). Para T5 se desambiguó el spine canónico vía `tracks`/`default_entity`
    (en el harness, no committeado). La navegación completa del DAG (consumir el routing CSV ya
    cargado) es una **mejora del resolver para F3**, no se improvisó en código committeado (regla 2).
- [ ] **F2-GATE** 🛑 Revisión de cobertura: % automático balde 1–2, catálogo balde 3, primitivas
  nuevas requeridas; corpus pasa validación estructural. **ESPERA APROBACIÓN DEL OPERADOR.**
  - *Evidencia (toda en `APTS_test` + artefactos committeados):*
    - **Cobertura balde 1–2:** 6/6 agentes con persona (100%), 25/25 workflows con ≥1 step
      generativo (100%, 137 steps). Ver `backend/importer/coverage-report.md`.
    - **Catálogo balde 3:** 104 `<check>` clasificados (64 runtime / 17 file_model / 15 existentes /
      8 nuevos). **3 primitivas nuevas** requeridas (`entity-status`, `count-compare`,
      `next-sibling-exists`) → F3-T1. Ver `backend/importer/bucket3-catalog.md`.
    - **Validación estructural:** 31/31 IR válidas; vocabulario de tags = recon exacto
      (step 48, check 104, template-output 38, ask 11). 31 skills (3 DEPRECATED saltadas).
    - **`apts_next` sobre flujos reales:** 4 fases con steps reales role-aware + mismatch→wait (T5).
    - **Re-cableado:** 79 refs, 100% clasificadas (`rewire-map.json`).
    - **Idempotencia:** import byte-idéntico; seed estable; fixture y primitivas intactas.
  - *Decisión abierta para el gate:* la mejora del resolver para DAG multi-skill-por-fase (T5
    hallazgo) — ¿se hace al inicio de F3 o se replantea aparte?

## F3 — Driver de goteo generativo (costo B)

- [ ] **F3-T1** Implementar primitivas del balde 3 catalogadas en F2.
- [ ] **F3-T2** `apts_workflow_step` modelo B: reconstrucción de payload por paso desde estado;
  reinyección solo de `needs[]` (referencia + recuperación semántica). Pasos iterables.
- [ ] **F3-T3** Estado **espera-input** para elicitación (≠ blocker): pausa, expone pregunta, reanuda.
- [ ] **F3-T4** Captura de output: doc-artefactos → APTS (`artifacts`); código → repo + referencia.
  `apts_submit_step`.
- [ ] **F3-T5** Tools por contrato + regenerar adaptadores.
- [ ] **F3-GATE** 🛑 `create-prd` (u otro real) corre por goteo end-to-end; **contexto por paso
  ~constante** demostrado con números; elicitación funciona.

## F4 — Validación end-to-end: gestionar un proyecto real

- [ ] **F4-T1** Definir un proyecto real de prueba y correrlo: analysis → planning → solutioning →
  implementation, con entidades+flujos importados y `apts_next` guiando.
- [ ] **F4-T2** Ejecutar el ciclo de implementación (create-story → dev-story → code-review →
  retrospective) por goteo, multi-agente.
- [ ] **F4-T3** Métricas: consumo de contexto A y B en APTS **vs BMAD nativo** sobre el mismo
  proyecto.
- [ ] **F4-GATE** 🛑 Proyecto gestionado de punta a punta; informe de cierre v1 con métricas y
  divergencias respecto a BMAD.

---

## Log de decisiones

| Fecha | Decisión | Motivo |
|---|---|---|
| 2026-06-20 | BMAD = semilla, no spec (seed one-shot, sin re-sync) | APTS cobra vida propia; no acoplarse a versiones futuras de BMAD |
| 2026-06-20 | Partición generativo (importado/goteo) vs determinista (servidor) | Raíz del ahorro de contexto; el importador la ejecuta |
| 2026-06-20 | `apts_next` = resolver declarativo full-lifecycle, role-aware, una query | Costo A + corrección (no razonamiento en contexto) + multi-agente |
| 2026-06-20 | Goteo modelo B (contexto fresco por paso) | Única forma de atacar costo B (contexto plano a cualquier escala) |
| 2026-06-20 | Tools nuevas por el contrato existente | Reusar maquinaria multi-runtime (contract-check + generador) |
| 2026-06-20 | Editabilidad: generativo libre / determinista por paleta | Modelo de datos v1 ya lo respeta; habilita editor futuro sin retrabajo |
| 2026-06-20 | Edición en frontend → versión futura | Foco v1: probar gestión de proyecto desde emulación 100% |
| 2026-06-20 | Enums en snake_case (`ready_for_dev`, no `ready-for-dev`) | Alinear con convención del modelo actual (`in_progress`) |
| 2026-06-20 | `backlog_items` con `initiative_id` + `epic_id` (ambos nullable) | Soporta backlog plano (actual) / Quick Flow / Method sin romper nada |
| 2026-06-20 | Artefactos = extensión in-place de `semantic_documents`, 1 fila/scope, `version`=contador | No historial multi-versión en F0; unique existente intacto |
| 2026-06-20 | Registros del método GLOBALES (sin `project_url`) | Biblioteca reutilizable entre flujos/proyectos; override por-proyecto = futuro |
| 2026-06-20 | `project_state` = puntero por agente; fase macro en `initiatives.phase` | Multi-agente sin colisión; evita duplicar la fase |
| 2026-06-20 | Fixture toy = **4 fases** (lifecycle completo), no 2 | Decisión del operador; ejercita routing inter-fase real (4 workflows encadenados por `phase`) |
| 2026-06-20 | Migración 013: agregar `brief` al enum `doc_type` | El lifecycle de 4 fases necesita artefacto tipado para `analysis` (Product Brief BMAD); F2 lo requeriría igual |
| 2026-06-20 | Params de gate viven en `workflow_steps.metadata.primitive_params` | F0 no creó columna dedicada; `metadata` jsonb es el flex field por diseño (no defecto de esquema) |
| 2026-06-20 | Contrato de `next_rules` = `{on_pass,on_fail:{goto}}` + `"__phase_done__"` | Fijado por la fixture; el resolver T3 lo implementa, no improvisa |
| 2026-06-20 | `all-children-status` sobre conjunto vacío = `false` (no vacuamente verdadero) | Una épica sin historias no debe pasar el gate "todas done"; borde nuevo decidido en T2 |
| 2026-06-20 | Primitivas: registro EN CÓDIGO = fuente de verdad de `implemented` (opción A) | `primitives_palette.implemented` se reconcilia desde el registro (hint de catálogo/UI, no autoridad); el resolver consulta el código |
| 2026-06-20 | Resolución `parent→hijos`: `epic→backlog_items`, `initiative→epics` (extensible) | Tabla en `method_primitives.js`; solo `epic` se ejercita en la fixture, `initiative` queda listo |
| 2026-06-20 | (T3-A) Input de `apts_next` = `{project, agent_name}`, no `{project, role?}` de §7 | El reparto sin colisión necesita identidad de agente: `role='dev'` no distingue `agent-dev-1`/`-2`. El output conserva `role` (entidad requerida). Refinamiento de §7; la firma de la tool se fija en T4 |
| 2026-06-20 | (T3-B) "una query" (§3) = **un round-trip del agente**, no un único SQL | La cascada evalúa primitivas (cada gate = un COUNT); colapsar a una sentencia sería artificial y peor. Internamente: lecturas indexadas + COUNTs, en una transacción |
| 2026-06-20 | (T3-C) `apts_next` hace 2 escrituras deterministas idempotentes | Avanzar `initiatives.phase` en `phase_done` y reclamar la story en `dev-story`. El claim es imprescindible (una lectura pura daría la misma story a 2 agentes); el avance es la transición de la máquina de estado |
| 2026-06-20 | (T4-A) `apts_status` reusa `aptsNext` dentro de una transacción que se ROLLBACKEA | El endpoint es solo-lectura, pero `apts_next` escribe (avance de fase/claim). Rollback ⇒ recomendación sin duplicar el routing y sin mutar estado; los conteos se leen ANTES de invocar (reflejan lo persistido). Verificado: `apts_status` no avanza la fase |
| 2026-06-20 | (T4-B) `apts_set_status` = máquina lineal hacia adelante story-only (ready_for_dev→in_progress→review→done) | Diseño aprobado. Forward-only ⇒ backward/terminal/skip = 409; no en máquina = 409; story inexistente = 404. Distinta de `update_backlog_item` (edición libre). `backlog_item_id` (no `entity_id`: entities=roles). Ampliable a epic/initiative en F2 (aditivo) |
| 2026-06-20 | (T4-C) `contract_check.selection_rule` "(14 operations)" → "(17 operations)" sin bump de `artifactVersion` | El archivo `contract-check.js` no cambia (su lógica es genérica); solo se corrige un conteo factual en la metadata del manifiesto, ya cubierto por el bump de `schema_version` 2.2.0 |
| 2026-06-20 | **F1-GATE aprobado** por el operador | `apts_next/status/set_status` correctos sobre fixture (vía CLI real), multi-agente sin colisión, reducción de contexto 6.8×–18.7× con números reales. Habilita F2 (importador seed) |
| 2026-06-20 | (F2-design) Fuente = `bmad-code-org/BMAD-METHOD` @ tag **`v6.8.0`** (`c3769ab`), clone temporal en `%TEMP%` | Tag exacto verificado por `ls-remote`; clone fuera del working tree para no contaminar git ni committear el corpus crudo |
| 2026-06-20 | (F2-design) Routing inter-fase se toma de **`module-help.csv`** (no de `<check>`) | El corpus v6.8 ya expone el DAG de lifecycle como datos (`phase/preceded-by/followed-by/required/outputs`); parsearlo de `<check>` sería peor y redundante |
| 2026-06-20 | (F2-design) El corpus tiene **2 dialectos**: XML estructurado (6 skills de `4-implementation`) y prosa markdown (resto) | Hallazgo de recon; el plan asumía un solo grammar `<check>`. El parser auto-detecta por presencia de `<step>`; prosa → 1 step generativo por `## sección` con instrucción |
| 2026-06-20 | (F2-design) `<check if>` son lenguaje natural → balde 3 se extrae+cataloga, NO se auto-compila | Confirma el riesgo del plan (§9); se capturan condición + ramas + ubicación para triage backend |
| 2026-06-20 | (F2-design) Scope seed v1 = **lifecycle completo bmm** (38 wf + 6 agentes), core-skills solo los invocados | Decisión del operador; más cercano a "emulación 100%" sin arrastrar todo core |
| 2026-06-20 | (F2-design) IR **committeada** en `backend/importer/corpus/` + `NOTICE` | Decisión del operador; seed reproducible sin re-clonar, IR porta el ADN verbatim y la atribución |
| 2026-06-20 | (F2-design) T1 = parse → IR + reporte de cobertura, **CERO DB** (DB es T2/T3) | Acota T1 a la costura IR; aísla el componente delicado (parser balde 3) de la carga |
| 2026-06-20 | **F2-T1 diseño aprobado** por el operador | Recon de `v6.8.0` hecho; diseño consolidado (§ Diseño F2). Habilita codear el parser |
| 2026-06-20 | (F2-T1) Censo corregido: bmm = **32 SKILL.md** (6 agentes + 26 workflows), no 38 | El "44/38" del diseño contaba bmm+core juntos (32+12). Intent del scope ("lifecycle completo bmm" + `advanced-elicitation`/`help`) intacto: 31 skills parseadas (3 DEPRECATED saltadas) |
| 2026-06-20 | (F2-T1) `source.sha` = tag anotado `c3769ab` deref a commit `3bcd6c3` | `v6.8.0` es tag anotado: su objeto es `c3769ab`, el commit que dereferencia es `3bcd6c3`. Mismo contenido; la IR registra ambos (`tag_object_sha`/`commit_sha`) |
| 2026-06-20 | (F2-T1) Partición en la IR: `generative.instruction_md` (espina incondicional) vs `checks[]` (subárbol `<check>` crudo) | Realiza la tesis (routing NO va al prompt): por step, los `<action>` hijos directos = balde 2; cada `<check if>` (cualquier anidamiento) = balde 3 con su raw para triage T3. Sin pérdida: lo condicional vive en `checks[].raw` |
| 2026-06-20 | (F2-T1) `unresolved_refs` EXCLUYE vars de runtime `{{…}}` | `{{story_path}}`/`{{#if…}}` son ADN generativo (estado del workflow), no re-cableado. Solo placeholders de config/ruta `{…}` + `_bmad/…` + `resolve_customization.py` van a la worklist T4 |
| 2026-06-20 | (F2-T1) IR gana campos no-disruptivos: `checklists[]`, `workflow_critical[]`, `dropped_sections[]` | El esquema aprobado listó solo `templates[]` pero balde 1 incluye checklists (corpus trae 7); `workflow_critical[]` captura `<critical>` a nivel `<workflow>`; `dropped_sections[]` audita el andamiaje descartado. Aditivos, no rompen el contrato T2/T3 |
| 2026-06-20 | (F2-T1) `NOTICE` escrito en T1 (no esperar a T4) | El corpus se committea en T1 y porta ADN MIT verbatim; la atribución debe acompañarlo desde el commit (requisito de licencia). T4 lo refina con el re-cableado |
| 2026-06-20 | (F2-T1) No se agrega dependencia TOML; parser mínimo propio (`toml_min.js`) | Mismo criterio que F1-T5 (sin dep de tokenizer). Subconjunto acotado y estable; validado contra los 33 `customize.toml`. Falla ruidoso si excede el subconjunto |
| 2026-06-20 | (F2-T2) Loader carga TODAS las skills (incl. agentes) como `workflow_definition`; persona del agente también en `entities` | No perder el ADN del SKILL.md del agente (su `## Overview` = step generativo); la persona estructurada (role/menu/…) vive en `entities` (balde 1). `default_entity_id` del agente = su propia entity |
| 2026-06-20 | (F2-T2) `needs[]`/`outputs[]`/`iterable`/rol-por-step = NULL en T2 | T2 es solo balde 2 (ADN generativo). El wiring de dependencias (F3-goteo), iterable (dev-story) y asignación de rol (T5/F3) y los gates deterministas (T3) son fases posteriores; balde 3 se preserva en `step.metadata` sin contaminar el prompt |
| 2026-06-20 | (F2-T3) Balde 3 = triage léxico en 4 buckets (runtime/file_model/maps_existing/needs_new), NO compilación | Confirma riesgo §9. Resultado: 62% runtime + file_model (no son determinismo de servidor), validando la tesis. Solo 8 condiciones → 3 primitivas nuevas |
| 2026-06-20 | (F2-T3) 3 primitivas nuevas: `entity-status`, `count-compare`, `next-sibling-exists` | Propuesta de ingeniería desde el bucket `needs_new`; se confirman e implementan en F3-T1 (no en F2: el ledger separa catálogo de implementación) |
| 2026-06-20 | (F2-T4) Re-cableado = mapa declarativo aplicado en serve-time (F3), NO mutación del ADN | El ledger manda importar el ADN verbatim y tocar solo el andamiaje. `rewire-map.json` (data, editable-by-design) preserva el verbatim y deja el reemplazo para el goteo |
| 2026-06-20 | (F2-T5) Hallazgo: resolver asume 1-workflow-por-fase; corpus real = multi-skill-por-fase (DAG) | El toy tenía 1 wf/fase; el corpus tiene varios (planning=4). `selectPhaseWorkflow` necesita consumir el routing CSV (ya cargado). NO se improvisó en código committeado: se desambiguó el spine en el harness throwaway y se eleva al gate como tarea F3 |

## Log de cambios (archivos tocados)

| Fecha | Tarea | Archivos |
|---|---|---|
| 2026-06-20 | Setup | `integracion/PLAN-emulacion-bmad.md`, `integracion/TRACKING-emulacion-bmad.md`; rama `feat/emulacion-bmad` desde `main` (FF del multi-runtime a main) |
| 2026-06-20 | F0-T1 | `backend/migrations/20260620000010_bmad_hierarchy.js` (initiatives, epics, alter backlog_items) |
| 2026-06-20 | F0-T2 | `backend/migrations/20260620000011_bmad_artifacts.js` (alter semantic_documents, action_items, FK prd_artifact_id) |
| 2026-06-20 | F0-T3 | `backend/migrations/20260620000012_bmad_method_registry.js` (entities, workflow_definitions, workflow_steps, primitives_palette, project_state) |
| 2026-06-20 | F1-T1 | `backend/migrations/20260620000013_artifact_doc_type_brief.js` (enum doc_type +brief); `backend/seeds/f1_toy_fixture.js` (fixture toy 4 fases + instancia, idempotente) |
| 2026-06-20 | F1-T2 | `backend/scripts/lib/method_primitives.js` (3 primitivas + dispatcher + cascada `resolvePhaseStep` + `reconcilePrimitiveRegistry`); `backend/seeds/f1_toy_fixture.js` (cablea reconcile en la cola) |
| 2026-06-20 | F1-T3 | `backend/scripts/lib/method_resolver.js` (resolver `aptsNext` full-lifecycle role-aware + claim sin colisión, encima de `resolvePhaseStep`). Harness de validación throwaway (no en repo), 17/17 contra `APTS_test` |
| 2026-06-20 | F1-T4 | `integracion/paquete-apts/apts_skills.json` (+3 tools); `apts-client.js` (+3 exports + autofill); `backend/index.js` (+3 rutas, require del resolver, manifiesto 2.2.0 + nota append-only + bumps de artefacto + corrección 14→17 ops); `backend/scripts/lib/method_resolver.js` (+`methodStatus`/`setMethodStatus`/máquina de estados story); `integracion/paquete-apts/runtime-adapters/**` (regenerados, idempotentes). Validado vía CLI real contra `APTS_test`+fixture; fixture restaurada |
| 2026-06-20 | F1-T5 | Medición de contexto throwaway (no en repo) sobre fixture en `APTS_test`. Sin cambios de código. Números registrados arriba (reducción costo A 6.8×–18.7×). Fixture restaurada prístina |
| 2026-06-20 | F2-T1 (diseño) | Recon de `BMAD-METHOD@v6.8.0` (clone temporal en `%TEMP%`, no en repo). Sin código aún. Diseño aprobado registrado en `TRACKING` (§ Diseño F2 + Log de decisiones). Próximo: codear parser → IR |
| 2026-06-20 | F2-T1 (código) | `backend/scripts/importer/` (`toml_min.js`, `classify.js`, `dialect_structured.js`, `dialect_prose.js`, `agent.js`, `routing_csv.js`, `parse_skill.js`) + `backend/scripts/import-bmad.js` (entry). Salida committeada: `backend/importer/corpus/*.json` (31), `backend/importer/coverage-report.md`, `backend/importer/NOTICE`. Cero DB; idempotente (byte-idéntico en 2 corridas) |
| 2026-06-20 | F2-T2 | `backend/seeds/bmad_seed.js` (loader idempotente baldes 1–2 → entities/workflow_definitions/workflow_steps, `source_ref bmad:v6.8.0`). Validado contra `APTS_test` |
| 2026-06-20 | F2-T3 | `backend/scripts/importer/bucket3.js` (clasificador) + `backend/scripts/catalog-bucket3.js` (entry) → `backend/importer/bucket3-catalog.md` (104 checks, 3 primitivas nuevas). Sin DB |
| 2026-06-20 | F2-T4 | `backend/scripts/importer/rewire.js` (mapa + classifyRef + applyRewire) + `backend/scripts/rewire-bmad.js` (entry) → `backend/importer/rewire-map.json` (79 refs, 100%). `NOTICE` ya de T1. Sin DB |
| 2026-06-20 | F2-T5 | Harness throwaway (no en repo): `apts_next` sobre instancia real del corpus en `APTS_test`, 4 fases role-aware + mismatch→wait. Sin cambios de código committeado. `APTS_test` restaurado |

## Mapa de archivos clave (se irá llenando)

- Plan: `integracion/PLAN-emulacion-bmad.md`
- Tracking: este archivo
- Backend (migraciones): `backend/migrations/` (F0 + 013 de F1)
- Fixture toy (F1-T1): `backend/seeds/f1_toy_fixture.js` (idempotente, contra `APTS_test`)
- Motor — primitivas + cascada (F1-T2): `backend/scripts/lib/method_primitives.js`
- Resolver `apts_next` (F1-T3): `backend/scripts/lib/method_resolver.js` (`aptsNext`, encima de `resolvePhaseStep`)
- Importador (F2 T1–T5, HECHO): parser puro `backend/scripts/importer/` (`toml_min.js`, `classify.js`,
  `dialect_structured.js`, `dialect_prose.js`, `agent.js`, `routing_csv.js`, `parse_skill.js`,
  `bucket3.js`, `rewire.js`) + entries `backend/scripts/{import-bmad.js, catalog-bucket3.js,
  rewire-bmad.js}`. Salida committeada `backend/importer/{corpus/*.json (31), coverage-report.md,
  bucket3-catalog.md, rewire-map.json, NOTICE}`. Loader DB (baldes 1–2): `backend/seeds/bmad_seed.js`
  (`source_ref bmad:v6.8.0`, idempotente, separado de la fixture toy). Driver de goteo + primitivas
  nuevas: F3
- Contrato: `integracion/paquete-apts/apts_skills.json` (tools nuevas)
- Reglas globales del repo: `AGENTS.md` (raíz)
