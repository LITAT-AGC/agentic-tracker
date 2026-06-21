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
| F0 Modelo de datos y fundaciones | ⬜ Pendiente | esquema soporta jerarquía+flujos+goteo+multi-agente; migra limpio en `APTS_test` | — |
| F1 Motor determinista + `apts_next` (costo A) | ⬜ Pendiente | `apts_next` correcto sobre fixture; multi-agente sin colisión; medición de reducción de contexto | — |
| F2 Importador seed (BMAD v6.8 → datos) | ⬜ Pendiente | cobertura revisada; corpus valida; `apts_next` sobre flujos reales | — |
| F3 Driver de goteo (costo B) | ⬜ Pendiente | `create-prd` por goteo end-to-end; contexto por paso ~constante | — |
| F4 Validación end-to-end (proyecto real) | ⬜ Pendiente | proyecto gestionado de punta a punta; métricas A y B vs BMAD; informe | — |

Leyenda: ⬜ Pendiente · 🟡 En curso · ✅ Hecho · ⛔ Bloqueado · 🛑 En gate (espera operador)

**Próxima acción:** Arrancar **F0-T1** (migraciones de jerarquía). Antes de tocar código, confirmar
con el operador el boceto de esquema de §5 del PLAN. Recordar: F0 termina en GATE.

---

## F0 — Modelo de datos y fundaciones

- [ ] **F0-T1** Migraciones de jerarquía: `initiatives` (track, phase, prd_artifact_id), `epics`
  (status derivado), `epic_id` nullable en `backlog_items`, enum de estado con `ready-for-dev`.
  - *Aceptación:* migra limpio en `APTS_test`; backlog plano sin épica sigue funcionando (Quick Flow).
- [ ] **F0-T2** Artefactos tipados: extender `semantic_documents` con `doc_type`, `version`, FK a
  iniciativa. `action_items`.
  - *Aceptación:* artefacto se guarda/recupera por embedding; versión incremental.
- [ ] **F0-T3** Registros del método: `entities`, `workflow_definitions`, `workflow_steps`
  (kind generative|deterministic, needs[], outputs[], next_rules, iterable), `primitives_palette`,
  `project_state` (phase, asignaciones de rol).
  - *Aceptación:* esquema editable-by-design (datos, no hardcode); soporta multi-agente.
- [ ] **F0-GATE** 🛑 Revisión de esquema con el operador: ¿soporta jerarquía + flujos declarativos +
  goteo modelo B + multi-agente sin retrabajo? Migraciones verdes en `APTS_test`.

## F1 — Motor determinista + `apts_next` (costo A)

- [ ] **F1-T1** Fixture de flujo hecha a mano (toy: 2 fases, pocos steps) en los registros de F0.
- [ ] **F1-T2** Primitivas base de gate: `artifact-exists`, `all-children-status`, `count-threshold`,
  cascada de prioridad intra-fase.
- [ ] **F1-T3** Resolver `apts_next` declarativo full-lifecycle (inter+intra fase), **role-aware**,
  sin colisión de historia entre agentes. Una query, payload mínimo.
- [ ] **F1-T4** Tools por contrato: `apts_next`, `apts_status` (data-mode), `apts_set_status`
  (transición validada). Regenerar adaptadores.
  - *Aceptación:* `node contract-check.js` OK; adaptadores idempotentes.
- [ ] **F1-T5** Medición de contexto: comparar tokens de `apts_next` vs el equivalente "LLM lee el
  estado y razona el routing". Registrar números.
- [ ] **F1-GATE** 🛑 `apts_next` correcto sobre fixture; multi-agente sin colisión; reducción de
  contexto demostrada con números reales.

## F2 — Importador seed (corpus BMAD v6.8 → datos)

- [ ] **F2-T1** Clonar BMAD v6.8 (temporal) y parsear: frontmatter, persona, principios, templates,
  checklists, `<step>/<action>/<check>`.
- [ ] **F2-T2** Balde 1–2 → volcar `entities` + `workflow_steps` (generative, iterable si aplica)
  automáticamente.
- [ ] **F2-T3** Balde 3 → extraer/catalogar routing+gates como reglas declarativas + **lista de
  primitivas faltantes** a implementar en backend (no importar como prompt).
- [ ] **F2-T4** Re-cableado de referencias BMAD → APTS; `NOTICE` de atribución; idempotencia.
  - *Aceptación:* re-run reemplaza lo importado sin pisar primitivas implementadas.
- [ ] **F2-T5** `apts_next` corre sobre flujos reales importados (no fixtures).
- [ ] **F2-GATE** 🛑 Revisión de cobertura: % automático balde 1–2, catálogo balde 3, primitivas
  nuevas requeridas; corpus pasa validación estructural.

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

## Log de cambios (archivos tocados)

| Fecha | Tarea | Archivos |
|---|---|---|
| 2026-06-20 | Setup | `integracion/PLAN-emulacion-bmad.md`, `integracion/TRACKING-emulacion-bmad.md`; rama `feat/emulacion-bmad` desde `main` (FF del multi-runtime a main) |

## Mapa de archivos clave (se irá llenando)

- Plan: `integracion/PLAN-emulacion-bmad.md`
- Tracking: este archivo
- Backend (migraciones): `backend/migrations/` (F0)
- Motor / importador: _por crear_ (F1–F3)
- Contrato: `integracion/paquete-apts/apts_skills.json` (tools nuevas)
- Reglas globales del repo: `AGENTS.md` (raíz)
