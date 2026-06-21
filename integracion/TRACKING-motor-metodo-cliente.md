# Tracking F5: motor de método conducible desde el cliente

> Compañero de [`PLAN-motor-metodo-cliente.md`](./PLAN-motor-metodo-cliente.md).
> Este doc es **autosuficiente**: una sesión nueva retoma leyendo solo esto + el plan.
> Marca `[x]` al completar cada tarea y actualiza "Estado global" y "Próxima acción".
> Rama: `feat/motor-metodo-cliente`.

## Regla de proceso (innegociable)

**Se PARA al final de cada fase** en un GATE de validación humana. No se empieza la fase siguiente
hasta que el operador apruebe el gate de la actual. Si una tarea revela que una decisión del ledger
estaba mal, se detiene y se replantea, no se improvisa.

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
| F5-0 Diseño y cierre del ledger | ⬜ Pendiente | ledger cerrado; formas JSON fijadas | bloqueo verificado: sin op de bootstrap, `apts_next`→`blocked` |
| F5-1 Backend: operaciones de bootstrap | ⬜ Pendiente | bootstrap idempotente; `apts_next` entrega 1er step; contract-check verde | depende de F5-0 |
| F5-2 Regeneración MCP + manifiesto | ⬜ Pendiente | MCP expone tools nuevas; manifiesto lista el agente; generador idempotente; bump versión | depende de F5-1 |
| F5-3 Adaptador orquestador del método | ⬜ Pendiente | conduce lifecycle real end-to-end vía adaptador | depende de F5-2 |
| F5-4 Validación end-to-end desde cliente limpio | ⬜ Pendiente | proyecto solo-spec gestionado de punta a punta; informe de cierre F5 | depende de F5-3 |

Leyenda: ⬜ Pendiente · 🟡 En curso · ✅ Hecho · ⛔ Bloqueado · 🛑 En gate (espera operador)

**Próxima acción:** **F5-0.** Cerrar el ledger de decisiones del PLAN §3 con el operador, en orden:
(1) forma del bootstrap (una tool vs separadas), (2) modelo de roster/identidad —el más delicado—,
(3) cómo entra la spec a `analysis`, (4) epic inicial, (5) dónde se publica el agente en el manifiesto.
Recomendado: antes de cerrar #2, hacer una prueba de concepto throwaway sobre `APTS_test` (crear
initiative + project_state a mano y ver `apts_next` entregar el primer step con cada modelo de roster)
para decidir con evidencia, no en abstracto.

---

## F5-0 — Diseño y cierre del ledger

- [ ] **F5-0-T1** Cerrar decisión: forma del bootstrap (`bootstrap_method` única vs
  `create_initiative` + `set_agent_role` separadas).
  - *Aceptación:* decisión registrada con justificación; formas JSON de payload/respuesta fijadas.
- [ ] **F5-0-T2** Cerrar decisión: modelo de roster/identidad frente a `unique(initiative_id, agent_name)`
  y el role-matching del resolver.
  - *Aceptación:* PoC throwaway en `APTS_test` demuestra que el modelo elegido hace que `apts_next`
    entregue steps de cada rol sin colisión; `APTS_test` restaurado.
- [ ] **F5-0-T3** Cerrar decisión: la spec como insumo de `analysis` (artefacto inicial en bootstrap
    vs lectura del repo en el primer step generativo).
- [ ] **F5-0-T4** Cerrar decisión: epic inicial (crear en bootstrap vs diferir) + `source_ref`/`track`.
- [ ] **F5-0-T5** Ubicar la fuente del manifiesto público y cómo se añade un artefacto de agente.
  - *Aceptación:* identificado el archivo/módulo que arma `/api/public/integrar` y el punto de inserción.
- [ ] **F5-0-GATE** 🛑 Ledger cerrado y aprobado; formas JSON listas para implementar.

## F5-1 — Backend: operaciones de bootstrap

- [ ] **F5-1-T1** `create_initiative` (+ epic según ledger) en contrato + cliente + ruta + lógica.
  - *Aceptación:* idempotente por `project_url`+`status='active'`; crea initiative en `analysis` con
    `source_ref='bmad:v6.8.0'`; validado en `APTS_test`.
- [ ] **F5-1-T2** `set_agent_role` (upsert `project_state`) en contrato + cliente + ruta + lógica.
  - *Aceptación:* upsert idempotente respetando `unique(initiative_id, agent_name)`; valida `entity_key`.
- [ ] **F5-1-T3** `contract-check.js` alineado (cliente ↔ contrato ↔ MCP) con las ops nuevas.
- [ ] **F5-1-T4** Prueba: tras bootstrap, `apts_next` entrega el primer step real (no `blocked`).
  - *Aceptación:* harness throwaway en `APTS_test`: bootstrap → `apts_next` → `run_step` del rol
    correcto; `APTS_test` restaurado.
- [ ] **F5-1-GATE** 🛑 Bootstrap idempotente + `apts_next` operativo + contract-check verde.

## F5-2 — Regeneración MCP + manifiesto

- [ ] **F5-2-T1** Regenerar adaptadores (`generate-adapters.js`), idempotente.
- [ ] **F5-2-T2** Exponer el artefacto del orquestador del método en el manifiesto público.
- [ ] **F5-2-T3** Bump aditivo de `schema_version` del manifiesto + nota append-only.
- [ ] **F5-2-GATE** 🛑 MCP con tools nuevas; manifiesto lista el agente; generador idempotente; versión subida.

## F5-3 — Adaptador orquestador del método

- [ ] **F5-3-T1** Agente `apts-method-orchestrator` + comando `/apts-method` en `apts-surface.json`.
- [ ] **F5-3-T2** Lógica de conducción: bootstrap→`apts_next`→generativo(`apts_workflow_step`/
    `apts_submit_step`)→`dev-story` delega al executor→`wait`/`await-input`/`done`/`blocked`.
- [ ] **F5-3-T3** Regenerar adaptadores; `contract-check` y forma del orquestador plano sin cambios.
- [ ] **F5-3-GATE** 🛑 Conduce un lifecycle real end-to-end contra `APTS_test` vía el adaptador.

## F5-4 — Validación end-to-end desde cliente limpio

- [ ] **F5-4-T1** Integrar un proyecto solo-spec invocando el manifiesto del server desplegado.
- [ ] **F5-4-T2** Correr `analysis → … → implementation` con `/apts-method`, multi-rol.
- [ ] **F5-4-GATE** 🛑 Proyecto gestionado de punta a punta desde cliente fresco; informe de cierre F5.

---

## Log de cambios

- 2026-06-21 — Creados PLAN y TRACKING F5 tras verificar el bloqueo (sin op de bootstrap; `apts_next`
  devuelve `blocked` sin initiative/project_state; únicos creadores = seeds `f1`/`f4`).
