# Plan: emulación de BMAD dentro de APTS (motor de método servidor-autoritativo)

> **Nota histórica (v3.0.0):** este documento describe una etapa en la que el paquete de integración publicaba un CLI (`apts-cli.js`) como superficie de fallback. A partir de la **v3.0.0**, el servidor MCP (`apts-mcp.js`) es la **única** superficie soportada y toda referencia funcional al CLI fue retirada. Las menciones al CLI más abajo se conservan solo como registro histórico.

> Documento de planificación. Estado y avance se llevan en
> [`TRACKING-emulacion-bmad.md`](./TRACKING-emulacion-bmad.md).
> Fecha de redacción: 2026-06-20. Rama: `feat/emulacion-bmad`.
> **Regla de oro: se PARA al final de cada fase** (gate de validación humana) antes de pasar a la
> siguiente. Ninguna fase encadena a la próxima sin checkpoint explícito del operador.

## 1. Objetivo

Convertir APTS en un **motor de gestión de proyectos equivalente a BMAD**, pero con la lógica del
método **en el servidor** en vez de residente en el prompt, de modo que el consumo de contexto del
agente sea drásticamente menor a igualdad de funcionalidad.

- **Alcance v1:** emulación 100% de BMAD como punto de partida, suficiente para **gestionar un
  proyecto real de punta a punta** (analysis → planning → solutioning → implementation).
- **No incluido en v1:** edición/diseño de flujos y entidades desde el frontend (versión futura).
  Pero **todo se modela como datos editables, no hardcode**, para no rehacer nada cuando llegue el
  editor.

## 2. Tesis (por qué APTS gana en contexto)

BMAD quema contexto porque **la lógica del método vive dentro del prompt**: cada operación carga un
`SKILL.md` grande (12–27 KB), resuelve `customize.toml`, carga `config.yaml` y `sprint-status.yaml`,
y **el LLM interpreta la máquina de estados a mano** (`<step>`/`<check if=...>`). Hay dos costos:

- **Costo A — sobrecarga de método (fija):** el SKILL.md + preámbulo de activación. No depende del
  tamaño del proyecto; es un *piso* que se re-paga en cada operación.
- **Costo B — payload de estado/artefactos (creciente):** sprint-status, PRD, épicas, historia.
  Escala con el proyecto.

APTS ataca **A primero** (mover lo determinista al servidor) y **B después** (servir artefactos y
pasos por demanda). Bonus: mover lo determinista a SQL no solo es más barato, es **correcto** (el
LLM contando estados se equivoca).

## 3. Ledger de decisiones (cerrado antes de redactar)

| # | Decisión |
|---|---|
| **Alcance** | Emulación 100% de BMAD como arranque. **BMAD = semilla, no spec**: se ingiere v6.8 **una vez** y APTS forkea (sin re-sync ni acoplamiento a versiones futuras). |
| **1 Diagnóstico** | Atacar **costo A primero**, luego B. Causa: método en prompt + máquina de estado interpretada por el LLM. |
| **2 Partición** | **Generativo** (persona, principios, elicitación, instrucciones de step, templates) = importado verbatim y servido por goteo. **Determinista** (tracking, routing, gates, conteos) = lógica de servidor. El importador ejecuta la partición. |
| **3 `apts_next`** | Resolver **único full-lifecycle** (inter-fase tipo `bmad-help` + intra-fase tipo `sprint-status`). Routing **declarativo (datos)** sobre una paleta de primitivas. **Consciente de rol/multi-agente.** Payload mínimo. |
| **4 Goteo** | **Contexto fresco por paso (modelo B):** el server reconstruye el payload de cada paso desde su estado y reinyecta solo lo que el paso `needs`. Unidad = `<step>` de BMAD, **iterable**. Elicitación = estado **espera-input** (≠ blocker). Doc-artefactos→APTS; código→repo+referencia. |
| **5 Importador** | **Seed de un solo uso.** Automatiza baldes 1–2 (ADN generativo); extrae/cataloga balde 3 (determinista) para implementar en backend. Vuelca todo a registros de datos. |
| **6 Arranque** | Motor de estado + `apts_next` primero (puro costo-A), antes del goteo. |
| **Editabilidad** | **Generativo = texto libre** (futuro editor). **Determinista = composición de paleta de primitivas extensible por backend.** El modelo de datos de v1 ya respeta ese límite aunque no haya UI. |
| **Multi-agente** | APTS **diverge de BMAD a propósito**: BMAD asume agente secuencial; APTS es multi-agente (rol, heartbeats, sin colisión de historia). |
| **Contrato** | Las tools nuevas entran por el contrato existente (`apts_skills.json`) y se regeneran MCP/CLI/adaptadores con la maquinaria multi-runtime ya construida. |
| **IP** | Proyecto open source. Requisitos prácticos: **atribución BMAD** (`NOTICE` en el corpus importado) y **no usar la marca "BMAD"** como identidad del producto. |

## 4. Arquitectura objetivo

```
APTS (servidor autoritativo del método)
  ├─ Modelo de datos (todo editable-by-design)
  │   initiatives ── epics ── stories(=backlog_items+) ── tasks ── agent_logs
  │   artifacts (extiende semantic_documents: doc_type, version, FK initiative)
  │   action_items (retrospectivas)
  │   entities            (personas/roles: PM, arquitecto, diseñador, elicitación…)
  │   workflow_definitions ── workflow_steps  (kind: generative | deterministic)
  │   primitives_palette  (gates deterministas: artifact-exists, all-children-status, …)
  │   project_state       (phase, role assignments)
  │
  ├─ Motor determinista (costo A)
  │   apts_next  → resolver declarativo full-lifecycle, role-aware  (UNA query)
  │   state machine + gates  (transiciones validadas en servidor)
  │
  ├─ Driver de goteo (costo B)
  │   apts_workflow_step  → modelo B (contexto fresco por paso)
  │   reconstruye payload desde estado; reinyecta solo `needs` (ref + semántica)
  │
  ├─ Importador seed (one-shot, BMAD v6.8 → datos)
  │
  └─ Superficie MCP/CLI (vía contrato + generador existentes)

Cliente (Claude Code / opencode / …): tools finas. NO carga el método en contexto.
Frontend: dashboard (v1) · editor de flujos/entidades (futuro).
```

## 5. Modelo de datos (boceto)

- **`initiatives`** — equivale a un proyecto/PRD BMAD. Campos: `track` (quick/method/enterprise),
  `phase` (analysis/planning/solutioning/implementation), `prd_artifact_id`.
- **`epics`** — nivel intermedio. Status derivado de hijos (done cuando todas las historias done).
- **`backlog_items` (stories)** — extender: `epic_id` nullable (plano = "Quick Flow" de BMAD),
  enum de estado con `ready-for-dev` añadido (`backlog / ready-for-dev / in-progress / review / done`).
- **`artifacts`** — extiende `semantic_documents`: `doc_type` (`prd|architecture|epics|story_spec|retro`),
  `version`, FK a iniciativa. Recuperación por embedding ⇒ el "sharding" de BMAD es innecesario.
- **`action_items`** — `{ epic, action, owner, status: open|in-progress|done }`.
- **`entities`** — registro de personas/roles importadas de BMAD (prompt/persona/principios/estilo),
  reutilizables entre flujos, editables-by-design.
- **`workflow_definitions` / `workflow_steps`** — un flujo = secuencia de steps
  `{ id, goal, kind, instruction_chunk?, needs[], outputs[], next_rules, iterable? }`.
  `generative` lleva el prompt importado; `deterministic` referencia una primitiva, no texto.
- **`primitives_palette`** — catálogo de gates deterministas que el resolver entiende.
- **`project_state`** — fase actual, asignaciones de rol, punteros de ejecución por agente.

## 6. El importador (3 baldes)

| Balde | Contenido BMAD | Automatización | Destino en APTS |
|---|---|---|---|
| 1 | Frontmatter, persona, principios, templates, checklists | **~100% automático** | `entities`, `workflow_steps.instruction_chunk`, templates |
| 2 | `<step>/<action>` **generativo** ("escribí esta sección") | **automático con parser** | `workflow_steps` (kind=generative, iterable si aplica) |
| 3 | `<check if=...>` routing y gates **deterministas** | **extrae y cataloga; no se importa como prompt** | reglas declarativas + lista de primitivas a implementar en backend |

- One-shot e **idempotente** (re-run reemplaza lo importado, no pisa primitivas implementadas).
- Re-cablea referencias BMAD (`{project-root}/_bmad/...`, `{story_location}`, `tracking_system`,
  `resolve_customization.py`) a equivalentes de APTS.
- Emite `NOTICE` de atribución.

## 7. Contrato MCP nuevo (alto nivel)

Entran por `apts_skills.json` y se regeneran adaptadores. Payloads mínimos (costo A):

- **`apts_next`** `{ project, role? }` → `{ next, target_id, role, why, args? }`.
- **`apts_status`** (data-mode) → conteos + recomendación, sin prosa.
- **`apts_set_status`** `{ entity_id, status }` → transición validada en servidor.
- **`apts_workflow_step`** `{ workflow, state, role }` → `{ step, instruction_chunk, needs[],
  template_slice, outputs[], mode: run|await-input }`.
- **`apts_submit_step`** `{ step_id, outputs }` → persiste output (artefacto/repo-ref) y avanza.

## 8. Fases de ejecución (cada una PARA en su gate)

> El **orden honra A-primero**: el motor determinista se prueba sobre *fixtures* antes de traer el
> corpus real, para de-riesgar la tesis con números temprano.

### F0 — Modelo de datos y fundaciones
Migraciones del esquema de §5 (jerarquía, artefactos tipados, entidades, workflow_definitions/steps,
primitives_palette, project_state, action_items). Sin lógica. Editable-by-design.
**GATE STOP:** el esquema soporta jerarquía + flujos declarativos + goteo + multi-agente; migraciones
corren limpias en DB `APTS_test`; revisión del operador.

### F1 — Motor determinista + `apts_next` (costo A)
Resolver declarativo full-lifecycle, role-aware, sobre una **fixture de flujo hecha a mano** (toy de
2 fases / pocos steps). Primitivas base (`artifact-exists`, `all-children-status`, `count-threshold`,
cascada de prioridad). Tools `apts_next` / `apts_status` / `apts_set_status` por el contrato.
**GATE STOP:** `apts_next` correcto sobre la fixture; multi-agente sin colisión; **medición de
reducción de contexto vs leer estado en prompt** (números reales).

### F2 — Importador seed (corpus BMAD v6.8 → datos)
Parser one-shot. Baldes 1–2 → `entities` + `workflow_steps` automáticamente. Balde 3 → reglas
declarativas + catálogo de primitivas faltantes. `NOTICE` de atribución. Idempotente.
**GATE STOP:** revisar cobertura (% automático, catálogo del balde 3, primitivas nuevas requeridas);
el corpus pasa validación estructural; `apts_next` corre sobre **flujos reales de BMAD**, no fixtures.

### F3 — Driver de goteo generativo (costo B)
`apts_workflow_step` modelo B (contexto fresco por paso): reconstrucción de payload desde estado,
reinyección solo de `needs` (referencia + recuperación semántica). Pasos iterables. Elicitación =
estado espera-input. Captura de output (doc→APTS / código→repo+ref). Implementar las primitivas del
balde 3 catalogadas en F2.
**GATE STOP:** un workflow generativo real (p. ej. `create-prd`) corre por goteo end-to-end;
**contexto por paso ~constante** demostrado con números.

### F4 — Validación end-to-end: gestionar un proyecto real
Correr un proyecto real completo a través de APTS (analysis→planning→solutioning→implementation),
con entidades+flujos importados, `apts_next` guiando, goteo sirviendo, multi-agente.
**GATE STOP:** proyecto gestionado de punta a punta; **métricas de contexto A y B vs BMAD nativo**
(el objetivo del proyecto); informe de cierre v1.

## 9. Riesgos

- **El parser del importador (balde 3)** es el componente más delicado; nunca llegará al 100%
  automático. Mitigación: extraer/catalogar y aceptar trabajo manual de backend (decisión cerrada).
- **Modelo B (contexto fresco por paso)** exige que *todo* paso sea reconstruible desde el estado del
  servidor, sin memoria conversacional. Mitigación: disciplina de `needs[]` explícitos + persistencia
  de outputs por paso.
- **Round-trips MCP** aumentan con el goteo. Aceptable: el objetivo es contexto plano, no menos
  llamadas. Vigilar latencia en F3/F4.
- **Deriva de fidelidad vs BMAD** al re-cablear prompts. Mitigación: importar verbatim el ADN
  generativo; tocar solo el andamiaje determinista.

## 10. Convenciones vigentes (heredadas)

- Contrato como única fuente de verdad: tools nuevas → `apts_skills.json` → regenerar adaptadores.
- Validación contra DB `APTS_test` (modo `test`), nunca la DB principal.
- Artefactos generados = gestionados (se regeneran, no se editan a mano).
- Todo cambio en el manifiesto público exige bump de `schema_version` + nota append-only.
