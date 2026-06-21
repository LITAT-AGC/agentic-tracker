# Informe de cierre v1 — Emulación de BMAD dentro de APTS (motor de método servidor-autoritativo)

> **Nota histórica (v3.0.0):** este informe describe una etapa en la que el paquete de integración publicaba un CLI (`apts-cli.js`) como superficie de fallback. A partir de la **v3.0.0**, el servidor MCP (`apts-mcp.js`) es la **única** superficie soportada y toda referencia funcional al CLI fue retirada. Las menciones al CLI más abajo se conservan solo como registro histórico.

> Entregable del 🛑 **F4-GATE**. Compañero de [`PLAN-emulacion-bmad.md`](./PLAN-emulacion-bmad.md) y
> [`TRACKING-emulacion-bmad.md`](./TRACKING-emulacion-bmad.md). Fecha: 2026-06-21. Rama: `feat/emulacion-bmad`.
> **Estado: APROBADO por el operador (2026-06-21) — v1 CERRADO.** Las 5 fases (F0–F4) están hechas y
> aprobadas. Verificación final al cierre limpia (migración `20260621000015` up/down, re-seeds
> idempotentes toy+bmad+f4, módulos cargan); `APTS_test` prístino y re-seedeable.

## 1. Objetivo cumplido

Convertir APTS en un motor de gestión de proyectos equivalente a BMAD, con la **lógica del método en
el servidor** (no en el prompt), para reducir drásticamente el consumo de contexto del agente a
igualdad de funcionalidad. F4 valida la tesis gestionando **un proyecto real de punta a punta**.

## 2. Proyecto de validación

**Acortador de URLs** (greenfield, chico pero real), instancia committeada y reproducible en
`backend/seeds/f4_url_shortener.js` (idempotente, scopeada por `project_url`, sobre la librería
`bmad:v6.8.0`). Roster multi-agente: **1 analyst + 1 pm + 1 architect + 2 dev** (5 punteros).

## 3. Resultado end-to-end (vía la CLI real → HTTP backend `NODE_ENV=test`)

El lifecycle completo corrió **analysis → planning → solutioning → implementation → `done`**, guiado
por `apts_next` (costo A) y servido por goteo (`apts_workflow_step`/`apts_submit_step`, costo B),
multi-agente, **172 llamadas CLI** reales:

| Fase | Workflows ejecutados (rol) | Salida |
|---|---|---|
| analysis | `bmad-product-brief` (analyst) | artefacto `brief` |
| planning | `bmad-prd` (pm) | artefacto `prd` (cierra `prd_artifact_id`) |
| solutioning | `bmad-create-architecture` (architect), `bmad-create-epics-and-stories` (pm), `bmad-check-implementation-readiness` (architect) | `architecture`, `epics` + **4 stories creadas server-side**, `readiness` |
| implementation | `bmad-sprint-planning`, `bmad-create-story`, `bmad-dev-story`×4 (dev) | `sprint_plan`, `story_spec`, 4 stories `done` |

**Estado final verificado:** `phase=done`; 7 artefactos tipados (`brief, prd, architecture, epics,
readiness, sprint_plan, story_spec`); 4 stories `done` ligadas al epic; punteros liberados (`idle`).

**Multi-agente sin colisión (demostrado):** con `dev-story` activo, `agent-dev-1` y `agent-dev-2`
reclamaron stories **distintas** (`distintas=true`) y las completaron concurrentemente; el claim
transaccional (`FOR UPDATE`, `unique(initiative_id, agent_name)`) garantiza no-colisión de historia.

## 4. Métricas de contexto vs BMAD nativo (mismo proyecto)

Criterio reproducible: `tokens = ceil(chars/4)`, chars exactos. Medición sobre el corpus real y los
artefactos del proyecto. El cálculo BMAD-nativo es **conservador** (cuenta sólo el upstream inmediato
declarado, no todo el contexto acumulado que el agente BMAD realmente arrastra → la brecha real es mayor).

### Costo A — routing (por decisión)

| Artefacto | chars | ~tokens |
|---|---|---|
| **APTS** `apts_next` (request + payload §7), promedio | 215 | ~54 |
| **BMAD-nativo** routing del DAG required (lifecycle) + estado vivo | 2 888 | ~722 |

**Reducción costo-A: 13.4× (−92.6%).** `apts_next` resuelve el routing full-lifecycle como una sola
directiva; BMAD-nativo exige que el LLM cargue e interprete las reglas del DAG + lea el estado.

### Costo B — goteo (contexto por paso)

Corrida real (artefactos del proyecto ~579 chars promedio): **reducción total 2.2× (−54.2%)**
(133 504 → 291 325 chars), por-workflow 1.1×–4.1×.

El valor estructural está en el **escalado**: el contexto por paso de APTS está **acotado**
(`SLICE_CHARS=1200` por need); no crece con el tamaño de los artefactos. BMAD-nativo sostiene el
workflow entero + artefactos completos en cada paso → crece lineal sin techo.

| Escala de artefactos (prom. chars) | APTS total (~tok) | BMAD-nativo total (~tok) | Reducción |
|---|---|---|---|
| 1× (579) | 17 298 | 72 832 | 4.2× |
| 10× (5 787) | 22 420 | 118 538 | 5.3× |
| 50× (28 936) | 22 420 | 321 678 | 14.3× |
| 200× (115 743) | 22 420 | 1 083 453 | 48.3× |

APTS se **aplana en ~22 420 tokens** (los needs topan en `SLICE_CHARS`); BMAD-nativo crece sin límite.
Consistente con el gate F3 (5.8×–41.1× para `bmad-prd` a escala). Tesis costo-A y costo-B demostrada
con números reales y reproducibles.

## 5. Divergencias documentadas respecto a BMAD

1. **Multi-agente** (divergencia a propósito, ledger): BMAD asume agente secuencial; APTS reparte
   trabajo entre roles y reclama unidades iterables (`dev-story`) sin colisión. El agente **`sm`**
   (scrum master) del toy **no existe en BMAD v6.8**: el agente `dev` posee todo el ciclo de
   implementation; se subsumió `sm→dev`.
2. **Estado servidor-autoritativo**: el cursor, el routing, los gates y la jerarquía
   (initiative→epic→story) viven en el servidor. Los `<ask>` file-model de BMAD (selección de story
   por archivo) son **MOOT** (el claim ya elige la story).
3. **Creación de stories server-authoritative** (F4): el agente genera el CONTENIDO; el motor
   (`apts_submit_step` de `create-epics-and-stories`) crea los `backlog_items` ligados al epic con el
   status canónico `ready_for_dev`. Partición fiel a la tesis: generativo=contenido, determinista=estructura.
4. **Tools de backlog legacy** (gap detectado y rodeado en F4): `create_backlog_item`/
   `update_backlog_item` no exponen `epic_id`/`initiative_id` ni el status `ready_for_dev`. El método
   no depende de ellas para las stories gestionadas (las crea el motor); siguen disponibles para
   backlog libre/externo. **Follow-up sugerido (no v1):** alinear el contrato si se quiere creación
   de stories del método vía la tool pública (bump aditivo).
5. **Goteo vs máquina de estados manual**: el goteo de `dev-story` lleva la story a `done` vía
   `apts_submit_step`; los estados intermedios `in_progress`/`review` (vía `apts_set_status`) son una
   superficie manual separada, no la ejercita el goteo.

## 6. Deuda provisional resuelta en F4

- **Completitud de workflows de proceso/validación** (era PROVISIONAL `count-threshold epic>=1`):
  `check-implementation-readiness`, `sprint-planning`, `create-story` ahora producen **doc tipado**
  (`readiness`, `sprint_plan`, `story_spec`) y cierran por `artifact-exists` (uniforme, fiel a BMAD
  que escribe esos `.md`). **0 completitudes provisionales restantes.** Migración aditiva al enum
  `doc_type` (`20260621000015`). Solutioning ya no se traba; el lifecycle cierra.

## 7. Estado del repo y de la DB al cierre

- Contrato: 19 ops, `schema_version` 2.3.0 (sin cambios en F4: no se agregaron tools).
- `APTS_test` prístino: fixture toy + corpus bmad + instancia F4 (re-seedeable). Migraciones suben/
  bajan limpias.
- Cambios de F4: 1 migración aditiva, 1 seed de instancia, refinamiento de `method_outputs.js` +
  `wiring.js` + `method_resolver.js` (creación server-side de stories). Sin tocar el ADN verbatim.

## 8. Conclusión

APTS gestiona un proyecto real de punta a punta emulando BMAD, con la lógica del método en el
servidor, multi-agente y sin colisión, reduciendo el contexto del agente **13.4× (costo A)** y
**hasta 48.3× (costo B) a escala** — el objetivo central del proyecto. **El operador aprobó el
F4-GATE el 2026-06-21: v1 queda cerrado.**
