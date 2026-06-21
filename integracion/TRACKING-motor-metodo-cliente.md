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
| F5-0 Diseño y cierre del ledger | ✅ Hecho | ✅ ledger cerrado y firmado (2026-06-21); formas JSON fijadas | PoC roster→Opción A; #1 separadas, #3 spec-artefacto, #5 epic plegado; manifiesto ubicado |
| F5-1 Backend: operaciones de bootstrap | ✅ Hecho | ✅ gate firmado por el operador (2026-06-21) | T1–T4 hechas y validadas en `APTS_test`; gate firmado |
| F5-2 Regeneración MCP + manifiesto | ✅ Hecho | ✅ gate firmado por el operador (2026-06-21) | T1–T3 hechas; gate firmado |
| F5-3 Adaptador orquestador del método | ✅ Hecho | ✅ gate firmado por el operador (2026-06-21) | T1/T2/T3 hechas; lifecycle real conducido vía MCP a `done`; gate firmado |
| F5-4 Validación end-to-end desde cliente limpio | ✅ Hecho | ✅ gate firmado por el operador (2026-06-21) | T1/T2 hechas; cliente fresco conducido a `phase=done` vía MCP; `APTS_test` restaurado; informe de cierre F5 redactado |

**🎉 F5 CERRADA — todas las fases (F5-0…F5-4) hechas y firmadas (2026-06-21).** El motor de método BMAD
es conducible de punta a punta desde un cliente solo-spec vía MCP + adaptador orquestador, sin tocar la
DB a mano. Ver **Informe de cierre F5** abajo.

Leyenda: ⬜ Pendiente · 🟡 En curso · ✅ Hecho · ⛔ Bloqueado · 🛑 En gate (espera operador)

**Próxima acción:** ✅ **F5 CERRADA — gate F5-4 firmado por el operador (2026-06-21).** Todas las fases
hechas y firmadas. Cambios de F5 commiteados y pusheados a `main`. Pendiente opcional (no requerido):
corrida real contra el server de PROD desplegado (134.122.62.55:46315) con guarda de permiso por
escritura.

<details><summary>Historial de "Próxima acción" (F5-3)</summary>

**Próxima acción (F5-3, cerrada):** 🛑 **GATE F5-3 — espera firma del operador.** F5-3-T1/T2/T3 hechas y verificadas.
T2: cuerpo de conducción afinado contra las formas REALES del resolver (3 divergencias corregidas en
ambas superficies — template canónico + `apts-surface.json`): (1) **cierre de `dev-story`** — el motor
NO auto-libera la story; el orquestador debe cerrar vía `apts_submit_step` (el step declara
`output:{kind:'status'}`, `method_outputs.js:41`); (2) **`wait` con dos sentidos** — switch de identidad
(`role` distinto) vs. sin unidades libres (`role` igual, `method_resolver.js:308`); (3) **`apts_submit_step`
puede devolver `ok:false`** (p.ej. `await_input`, `method_resolver.js:530`). T3: lifecycle real conducido
**vía el adaptador MCP** (driver JSON-RPC → `apts-mcp.js` → `apts-client.js` → HTTP → rutas → resolver;
nunca `method_resolver` directo) contra `APTS_test` hasta `phase=done`: bootstrap idempotente
(`resumed:true`) → roster 6 roles → analysis(brief)/planning(prd)/solutioning(architecture, epics+1 story,
readiness)/implementation(sprint-planning, create-story, dev-story) con conmutación de identidad en cada
`wait` y `await_input` en 2 puntos. T3 surfaced que **`dev-story` es multi-paso (10 pasos iterables, solo
el terminal declara `status`)** → la Delegation Rule se corrigió para **recorrer** el workflow hasta el
output `status:done`+`code_ref` (no "un submit cierra la story"). Adaptadores regenerados idempotentes;
`contract-check` verde (21 ops). `APTS_test` restaurado (2 initiatives preexistentes intactas, 0 restos).
**No empezar F5-4 hasta la firma.** F5-1 y F5-2 GATES firmados (2026-06-21).

</details>

**Historial reciente:** F5-2 completa: T1 (regeneración idempotente
de adaptadores — solo cambió `claude/.claude/settings.json`, propagando `create_initiative` +
`set_agent_role` al allowlist MCP, derivado de `operationNames()`; opencode/vscode sin cambios);
T2 (entrada `method_orchestrator_agent` en `integrationArtifacts` + template canónico
`plantillas-agentes/apts-method-orchestrator.agent.md` + ruta express servible, copiando el patrón
`orchestrator_agent`); T3 (bump aditivo `integrationManifestSchemaVersion` `3.0.0→3.1.0` + nota
append-only en comentario sobre el const). `node --check backend/index.js` verde. **Tras la firma:**
F5-3-T1 (agente `apts-method-orchestrator` + comando `/apts-method` en `apts-surface.json`).

⚠️ **Límite de fase a validar en el gate F5-2:** F5-3-T2 está rotulado "Lógica de conducción", pero el
manifiesto no puede publicar un artefacto cuyo `filePath` no existe, así que F5-2-T2 exigió crear el
template `.agent.md` ya con cuerpo de conducción real (precedente del backlog: template canónico en
`plantillas-agentes/` + variante de surface aparte). F5-3 PORTA ese cuerpo a `apts-surface.json`
(fuente del generador), añade el mapping `agent_runtime_adapters` (vscode), regenera el adaptador y lo
**valida end-to-end** conduciendo un lifecycle real. No se añadió mapping de surface en F5-2 (el agente
de surface es F5-3).

⚠️ **Para el gate F5-1 (decisión #3):** `bmad-product-brief` trae `needs:[]` vacío (verificado en la
librería bmad sembrada), así que la spec guardada (`doc_type='spec'`, migración 016) NO se autoconsume
por `resolveNeed` todavía. El artefacto queda persistido y recuperable por `doc_type`; el **cableado
del need** en el primer step generativo es trabajo de F5-3 (conducción). No bloquea T1 ni el gate
(la spec es opcional y el gate exige bootstrap+`apts_next`+contract-check).

---

## F5-0 — Diseño y cierre del ledger

- [x] **F5-0-T1** Cerrar decisión: forma del bootstrap (`bootstrap_method` única vs
  `create_initiative` + `set_agent_role` separadas). → **SEPARADAS** (firmado operador 2026-06-21).
  - *Aceptación:* ✅ decisión registrada con justificación; formas JSON fijadas (ver "Ledger cerrado").
- [x] **F5-0-T2** Cerrar decisión: modelo de roster/identidad frente a `unique(initiative_id, agent_name)`
  y el role-matching del resolver. → **RESUELTA por PoC: Opción A** (N punteros, 1 `agent_name` por rol,
  `entity_id` seteado; el orquestador conmuta de identidad usando el campo `role` que devuelve `apts_next`,
  sin polling). Coincide con el `ROSTER` del seed f4.
  - *Aceptación:* ✅ PoC throwaway en `APTS_test` (`scripts/_poc_f50_roster.js`, ya borrado) demostró:
    (a) puntero con `entity_id=null` → `wait` para siempre (reproduce el bug f4 stale en DB);
    (b) roster Opción A → la identidad del rol activo obtiene `run_step`, las demás `wait`;
    (c) una sola llamada con rol equivocado ya devuelve el `role` REQUERIDO → conmutar identidad da
    `run_step` sin recorrer los 6. `APTS_test` restaurado (0 initiatives throwaway).
- [x] **F5-0-T3** Cerrar decisión: la spec como insumo de `analysis` (artefacto inicial en bootstrap
    vs lectura del repo en el primer step generativo). → **ARTEFACTO EN BOOTSTRAP** (firmado 2026-06-21):
    `create_initiative` escribe un `semantic_documents` ligado; el server no ve el FS del cliente.
- [x] **F5-0-T4** Cerrar decisión: epic inicial (crear en bootstrap vs diferir) + `source_ref`/`track`.
    → **EPIC PLEGADO en `create_initiative`**; `source_ref='bmad:v6.8.0'`, `track='method'` (firmado 2026-06-21).
- [x] **F5-0-T5** Ubicar la fuente del manifiesto público y cómo se añade un artefacto de agente.
  - *Aceptación:* ✅ Fuente = objeto `integrationArtifacts` en `backend/index.js:1965`. Patrón a copiar:
    entrada `orchestrator_agent` (`index.js:2038`). Inserción = nueva entrada `method_orchestrator_agent`
    → archivo nuevo `integracion/plantillas-agentes/apts-method-orchestrator.agent.md`. El array
    `artifacts:` (`index.js:2519`) se deriva solo del objeto. Bump aditivo de
    `integrationManifestSchemaVersion` (`index.js:1962`, hoy `'3.0.0'`) → `'3.1.0'` + nota append-only.
    El agente + comando `/apts-method` también van en `apts-surface.json` (fuente del generador, F5-3).
- [x] **F5-0-GATE** ✅ Ledger cerrado y aprobado por el operador (2026-06-21); formas JSON listas para implementar.

### Ledger cerrado (F5-0) — ✅ firmado por el operador 2026-06-21

| # | Decisión | Recomendación | Estado |
|---|---|---|---|
| 1 | Forma del bootstrap | **Separadas** `create_initiative` + `set_agent_role`: componibles, idempotentes, payload chico; el roster es de largo variable (N roles → N llamadas a `set_agent_role`). | ✅ firmada |
| 2 | Modelo de roster/identidad | **Opción A** (N punteros, 1 por rol, `entity_id` seteado; conmutar identidad por el `role` devuelto). | ✅ cerrada (PoC) |
| 3 | La spec como insumo | **Artefacto inicial en el bootstrap** (`create_initiative` escribe un `semantic_documents` ligado a la iniciativa): el server no tiene acceso al FS del repo cliente; el goteo (`resolveNeed`) ya sirve artefactos por `doc_type`. El primer step generativo (product-brief) la consume como `need`. | ✅ firmada |
| 4 | source_ref / track | `source_ref='bmad:v6.8.0'`, `track='method'` por defecto (validado en PoC: enruta a la librería bmad). | ✅ firmada |
| 5 | Epic inicial | **Plegar 1 epic vacío en `create_initiative`** (como f4): `loadEpic`/`claimDevStory` lo necesitan en implementation y no hay tool de epics. Simplificación conocida; la generación real de epics (solutioning) queda futura. | ✅ firmada |
| 6 | Publicación en manifiesto | Ubicada (ver F5-0-T5). Sin controversia. | ✅ firmada |

**Formas JSON propuestas (a fijar en F5-1):**
- `create_initiative { project_url, title, track?='method', source_ref?='bmad:v6.8.0', phase?='analysis', description?, spec_artifact?:{title,content} }`
  → `{ initiative_id, epic_id, phase, created|resumed }`. Idempotente por `(project_url, status='active')`.
  Crea iniciativa en `analysis` + 1 epic vacío + (si `spec_artifact`) un `semantic_documents` ligado.
- `set_agent_role { project_url, agent_name, entity_key }` → `{ project_state_id, role, created|updated }`.
  Upsert sobre `unique(initiative_id, agent_name)`; resuelve `entity_key`→`entity_id` y lo **persiste no-null**
  (el PoC probó que `entity_id=null` = `wait` eterno). Valida que `entity_key` exista en `source_ref` de la iniciativa.

## F5-1 — Backend: operaciones de bootstrap

- [x] **F5-1-T1** `create_initiative` (+ epic según ledger) en contrato + cliente + ruta + lógica.
  - *Aceptación:* ✅ idempotente por `project_url`+`status='active'` (resume, no duplica); crea initiative
    en `analysis` con `source_ref='bmad:v6.8.0'` + 1 epic plegado + spec opcional (`doc_type='spec'`);
    validado en `APTS_test` con harness throwaway (idempotencia, fase, source_ref, epic único, spec
    upsert v1→v2, alta sin spec, `apts_next` ya no bloquea por "sin iniciativa"). `APTS_test` restaurado.
- [x] **F5-1-T2** `set_agent_role` (upsert `project_state`) en contrato + cliente + ruta + lógica.
  - *Aceptación:* ✅ upsert idempotente respetando `unique(initiative_id, agent_name)` (re-asignación =
    `updated`, mismo `project_state_id`, sin duplicar); resuelve `entity_key`→`entity_id` contra la
    librería de la iniciativa (`entities` scopeadas por `source_ref`) y lo persiste **no-null**; rechaza
    `entity_key` ajeno a la librería; exige iniciativa activa. Validado en `APTS_test`.
- [x] **F5-1-T3** `contract-check.js` alineado (cliente ↔ contrato ↔ MCP) con las ops nuevas.
  - *Aceptación:* ✅ verde con 21 ops (incluye `create_initiative` y `set_agent_role`); el chequeo deriva
    del contrato (export camelCase `setAgentRole` + tool MCP automática), sin editar `contract-check.js`.
- [x] **F5-1-T4** Prueba: tras bootstrap, `apts_next` entrega el primer step real (no `blocked`).
  - *Aceptación:* ✅ harness throwaway en `APTS_test`: `create_initiative`+roster → `apts_next` devuelve
    `run_step` del rol requerido (`bmad-agent-analyst`, paso `0`/Overview) y `wait` (anunciando ese `role`)
    a los demás. `APTS_test` restaurado (2 initiatives preexistentes intactas; throwaway limpiado).
- [x] **F5-1-GATE** 🛑 Bootstrap idempotente + `apts_next` operativo + contract-check verde. **Evidencia
  lista; espera firma del operador.**

## F5-2 — Regeneración MCP + manifiesto

- [x] **F5-2-T1** Regenerar adaptadores (`generate-adapters.js`), idempotente.
  - *Aceptación:* ✅ corrida dos veces sin cambiar el árbol salvo lo derivado del contrato: solo
    `claude/.claude/settings.json` cambió, añadiendo `mcp__apts__create_initiative` y
    `mcp__apts__set_agent_role` al allowlist (deriva de `operationNames()`); opencode/vscode no listan
    permisos MCP por-op → sin cambios. Generador idempotente confirmado.
- [x] **F5-2-T2** Exponer el artefacto del orquestador del método en el manifiesto público.
  - *Aceptación:* ✅ entrada `method_orchestrator_agent` en `integrationArtifacts` (`index.js`,
    patrón `orchestrator_agent`, `artifactVersion`/`updatedInSchemaVersion` `'3.1.0'`); template
    canónico `integracion/plantillas-agentes/apts-method-orchestrator.agent.md` (bootstrap idempotente
    + roster Opción A + drive loop `apts_next`→generativo/`dev-story`→wait/await_input/done/blocked,
    con nombres y formas reales del resolver); ruta express `GET …/agentes/apts-method-orchestrator.agent.md`
    cableada (sin ella sería 404). `node --check` verde.
- [x] **F5-2-T3** Bump aditivo de `schema_version` del manifiesto + nota append-only.
  - *Aceptación:* ✅ `integrationManifestSchemaVersion` `'3.0.0'→'3.1.0'`; nota append-only como
    comentario sobre el const (no hay estructura de release-notes; baseline reset documentado). Solo
    se AÑADIÓ un artefacto opcional; ningún artefacto removido ni cambió de forma.
- [x] **F5-2-GATE** ✅ MCP con tools nuevas; manifiesto lista el agente; generador idempotente; versión subida.
  **Firmado por el operador (2026-06-21).**

## F5-3 — Adaptador orquestador del método

- [x] **F5-3-T1** Agente `apts-method-orchestrator` + comando `/apts-method` en `apts-surface.json`
    **y regenerar adaptadores** (`generate-adapters.js`, idempotente). Incluye verificar que
    `contract-check` sigue verde y que la forma del orquestador plano de backlog (y demás adaptadores
    existentes) NO cambia — solo se añaden el agente/comando del método.
  - *Aceptación:* ✅ agente `apts-method-orchestrator` (id, name "APTS Method Orchestrator", role
    `primary`, `userInvocable:true`, tools `[agent,read,search,edit,execute]`, subagente
    `backlog-item-executor-dev-test-commit`, `argumentHint`, `body` portado del template canónico de
    F5-2) insertado tras `apts-backlog-orchestrator` en `agents[]`; comando `apts-method`
    (`agent:apts-method-orchestrator`, `body` bootstrap→drive loop con `$ARGUMENTS` al final)
    insertado tras `apts-next` en `commands[]`. `git diff` del spec: solo adiciones (26 inserciones,
    0 borrados). Generador corrido **dos veces** → idempotente (2ª pasada sin diff). 5 archivos
    nuevos (`claude/.claude/agents/apts-method-orchestrator.md`, `claude/.claude/commands/apts-method.md`,
    equivalentes opencode y `vscode/agents/apts-method-orchestrator.agent.md`); ningún adaptador
    existente cambió de forma (único `M` previo = `claude/.claude/settings.json`, carryover de F5-2).
    `contract-check` verde (21 ops, sin tocar el contrato). Frontmatter generado verificado (subagente
    resuelto a nombre en vscode; `$ARGUMENTS` + footer `Runs via agent` en el comando).
- [x] **F5-3-T2** Lógica de conducción: bootstrap→`apts_next`→generativo(`apts_workflow_step`/
    `apts_submit_step`)→`dev-story` delega al executor→`wait`/`await-input`/`done`/`blocked`.
  - *Aceptación:* ✅ cuerpo afinado contra las formas REALES del resolver en **ambas** superficies
    (template canónico `plantillas-agentes/…` + `apts-surface.json`, fuente del generador). 3 divergencias
    corregidas: (1) **cierre `dev-story`** vía `apts_submit_step` (el step declara `output:{kind:'status'}`,
    `method_outputs.js:41`; el executor cierra en `review`=no-terminal → sin el submit la story se re-reclama);
    (2) **`wait` bicéfalo** — switch de identidad (`role`≠) vs. sin unidades libres (`role`=,
    `method_resolver.js:308`); (3) **`apts_submit_step ok:false`** (p.ej. `await_input`, `:530`).
    Adaptadores regenerados idempotentes (2ª pasada sin diff); `contract-check` verde (21 ops); único `M`
    de adaptador existente = `claude/.claude/settings.json` (carryover F5-2).
- [x] **F5-3-T3** Conducir el lifecycle real end-to-end contra `APTS_test` **vía el adaptador**
    (no por harness directo): bootstrap→roles→generativos→`dev-story`→cierre.
  - *Aceptación:* ✅ driver throwaway JSON-RPC contra `apts-mcp.js` (→`apts-client.js`→HTTP→rutas→resolver;
    nunca importa `method_resolver`), backend en `NODE_ENV=test`/`APTS_test`. Lifecycle a `phase=done`:
    `create_initiative`+spec (idempotente: 2º intento `resumed:true, same`), roster 6 roles, drive loop
    analysis(brief)→planning(prd)→solutioning(architecture, epics+1 backlog_item, readiness)→
    implementation(sprint-planning, create-story, dev-story) con conmutación de identidad por `role` en
    cada `wait` y `await_input` (2 puntos, reanudado con `answers`). Cierre dev-story: **walk de los 10
    pasos**, `status:done`+`code_ref` capturado en el paso terminal → story `done`, cursor liberado, fase→
    `done` (`apts_status` final: `phase=done`, `by_status.done=1`, recomendación `done`). 429 manejado con
    backoff (anti-loop). T3 **surfaced** que `dev-story` es multi-paso → corrección portada a la Delegation
    Rule de ambas superficies (recorrer hasta el output `status`, no "un submit cierra la story").
    `APTS_test` restaurado: 2 throwaway borradas con todas sus filas; las 2 initiatives preexistentes
    intactas; 0 restos. Sin migraciones nuevas. Server de test y temporales eliminados.
- [x] **F5-3-GATE** 🛑 Conduce un lifecycle real end-to-end contra `APTS_test` vía el adaptador.
  **Evidencia lista; espera firma del operador.**

## F5-4 — Validación end-to-end desde cliente limpio

> **Decisión de enfoque F5-4 (firmada operador 2026-06-21): Opción B — simular el cliente fresco contra
> `APTS_test`** (`NODE_ENV=test`), no contra el server de producción. Cero escritura en prod. El
> "manifiesto del server desplegado" se invoca contra el server de test local (`GET /api/public/integrar`).

- [x] **F5-4-T1** Integrar un proyecto solo-spec invocando el manifiesto del server (simulado en `APTS_test`).
  - *Aceptación:* ✅ cliente fresco throwaway (dir fuera del repo, solo-spec) integrado **descargando del
    manifiesto por HTTP** (no copiando del working tree): `GET /api/public/integrar` (schema 3.1.0) →
    9 artefactos a `.ia/apts/` (paquete MCP completo: `apts-mcp.js`+`apts-client.js`+`contract-check.js`+
    `package.json`, más surface/generador/plantilla del agente del método/skills/guidelines) → `.env`
    (APTS_BASE_URL+APTS_API_KEY) + registro MCP en `.mcp.json`. Arranque **desde la spec vía el adaptador
    MCP** (JSON-RPC a `apts-mcp.js`, sin tocar la DB a mano): `initialize` ok (21 tools), `create_initiative`
    con `spec_artifact` (idempotente: 2ª llamada `resumed`, mismo `initiative_id`), roster Opción A de 6
    roles (`entity_id` no-null), `apts_next` (analyst) → `run_step` (no `blocked`). Verificado
    `environment:test` + identidad de DB (2 initiatives preexistentes) ANTES de escribir.
- [x] **F5-4-T2** Correr `analysis → … → implementation` con `/apts-method`, multi-rol.
  - *Aceptación:* ✅ drive loop del cliente fresco (replica de la plantilla `apts-method-orchestrator`:
    drive loop + identity switching + generative step rule + delegation rule) conducido **vía el adaptador
    MCP** (JSON-RPC a `apts-mcp.js`, nunca el resolver directo) hasta `phase=done`. Conmutación de identidad
    en cada `wait` (analyst→pm→architect→pm→architect→dev), generativos `bmad-product-brief`/`bmad-prd`/
    `bmad-create-architecture`/`bmad-create-epics-and-stories`(epics+2 backlog_items)/
    `bmad-check-implementation-readiness`/`bmad-sprint-planning`/`bmad-create-story` (1 `await_input`
    resuelto con `answers`), y `bmad-dev-story` iterable recorrida (10 pasos, status terminal
    `{status:done,code_ref}`) por las 2 stories. Estado final: `phase=done`, backlog 2/2 `done`,
    recomendación `done`; 8 artefactos tipados (brief/prd/architecture/epics/readiness/sprint_plan/
    story_spec + spec). Rate limit de test (100/min) manejado con backoff; reanudación idempotente
    (2ª corrida retomó en la story restante y cerró el lifecycle).
- [x] **F5-4-GATE** 🛑 Proyecto gestionado de punta a punta desde cliente fresco; informe de cierre F5.
  **Evidencia lista; espera firma del operador.** Cliente fresco (solo-spec, fuera del repo) integrado
  desde el manifiesto por HTTP y conducido vía el adaptador MCP de `analysis` a `phase=done` (2 stories
  `done`, 8 artefactos). `APTS_test` restaurado al baseline (2 initiatives preexistentes, epics:2,
  backlog_items:358, 0 restos); server de test apagado; cliente fresco y harness borrados. Ver
  **Informe de cierre F5** abajo. **No marcar F5 cerrada hasta la firma.**

---

## Informe de cierre F5 — motor de método conducible desde el cliente

**Objetivo (PLAN §2):** hacer el lifecycle BMAD conducible de punta a punta desde un cliente que solo
tiene una spec, vía tools MCP + un adaptador orquestador empaquetado en el manifiesto, sin tocar la DB
a mano. **Logrado.**

**Qué se entregó (F5-0 → F5-4):**
- **Bootstrap en el contrato:** `create_initiative` (+ epic plegado + spec como `semantic_documents`
  tipado) y `set_agent_role` (roster Opción A, `entity_id` no-null), recorriendo
  contrato→cliente→ruta→lógica (`method_bootstrap.js`). Idempotentes. Migración aditiva 016 (`doc_type='spec'`).
- **Superficie + manifiesto:** agente `apts-method-orchestrator` + comando `/apts-method` en
  `apts-surface.json`; artefacto `method_orchestrator_agent` publicado y servible en `/api/public/integrar`;
  bump aditivo del schema del manifiesto `3.0.0→3.1.0`. Adaptadores regenerados idempotentes (claude/
  opencode/vscode); `contract-check` verde (21 ops).
- **Cuerpo de conducción** afinado contra las formas REALES del resolver (cierre `dev-story` vía
  `apts_submit_step`; `wait` bicéfalo; `apts_submit_step ok:false`/`await_input`; `dev-story` multi-paso
  recorrida hasta el `status` terminal) en ambas superficies (template canónico + surface).

**Validación end-to-end (F5-4, simulada contra `APTS_test`, decisión del operador):**
- Cliente fresco solo-spec **integrado desde el manifiesto por HTTP** (no copiando del working tree):
  9 artefactos → `.ia/apts/`, `.env`, MCP registrado en `.mcp.json`.
- Arranque **desde la spec vía el adaptador MCP** (`create_initiative` con `spec_artifact`; idempotencia
  `resumed` verificada; roster de 6 roles; `apts_next`→`run_step`, no `blocked`).
- Lifecycle conducido multi-rol con conmutación de identidad de `analysis → planning → solutioning →
  implementation → done`: 8 artefactos tipados, 2 stories creadas e implementadas (dev-story iterable
  recorrida por las 2), `await_input` resuelto, rate limit (100/min) manejado con backoff + reanudación
  idempotente. Estado final `phase=done`, backlog 2/2 `done`, recomendación `done`.
- **Sin escritura en prod** (Opción B firmada). `APTS_test` restaurado al baseline; 0 restos.

**Simplificaciones conocidas (heredadas del ledger, no bloqueantes):** epic único plegado en bootstrap
(la generación real de epics en solutioning queda futura); goteo de `needs[]` por slice acotado sin
embeddings en vivo; UI de gestión del método fuera de alcance v1.

**Estado del árbol:** working tree con los cambios de F5 sin pushear (igual que el carryover de la
remoción CLI→MCP). Sin migraciones nuevas en F5-4.

---

## Log de cambios

- 2026-06-21 — **F5-4 GATE ✅ firmado por el operador → F5 CERRADA.** Aprobada la evidencia (cliente
  fresco solo-spec conducido de `analysis` a `phase=done` vía el adaptador MCP contra `APTS_test`,
  `APTS_test` restaurado). Cambios de F5 commiteados y pusheados a `main`.
- 2026-06-21 — **F5-4 T1/T2 hechas → GATE F5-4 (informe de cierre F5 redactado).** Validación end-to-end
  desde cliente fresco contra `APTS_test` (Opción B firmada, sin tocar prod). Server de test arrancado
  in-process (`scripts/start_test_server.js`, `NODE_ENV=test`); verificado `environment:test` + identidad
  de DB (2 initiatives preexistentes: `apts://f4/url-shortener`, `apts://fixture/toy`; epics:2;
  backlog_items:358) ANTES de escribir. Cliente fresco throwaway fuera del repo (solo-spec): integrado
  **descargando del manifiesto por HTTP** (`GET /api/public/integrar`, 9 artefactos a `.ia/apts/`, `.env`,
  `.mcp.json`); arranque desde la spec y lifecycle conducidos **vía el adaptador MCP** (driver JSON-RPC →
  `apts-mcp.js` → `apts-client.js` → HTTP → rutas → resolver; nunca el resolver directo) hasta
  `phase=done`: `create_initiative`+spec (idempotente `resumed`), roster 6 roles, drive loop multi-rol
  con conmutación de identidad por las 4 fases, 8 artefactos tipados, `bmad-create-epics-and-stories`
  (epics+2 backlog_items), `await_input` resuelto en `bmad-create-story`, `bmad-dev-story` iterable
  recorrida (10 pasos, status terminal) por las 2 stories. Rate limit de test (100/min) manejado con
  backoff + reanudación idempotente (2ª corrida cerró la story restante → `done`). `APTS_test` restaurado
  al baseline exacto (2 initiatives, epics:2, backlog_items:358, 0 restos); server de test apagado;
  cliente fresco + harness eliminados; sin restos en el repo. Sin migraciones nuevas. Ningún archivo de
  código del repo cambió en F5-4 (validación pura); el working tree mantiene los cambios de F5-1/2/3.
- 2026-06-21 — **F5-3 GATE ✅ firmado por el operador.** Aprobada la evidencia (lifecycle real conducido
  end-to-end vía el adaptador MCP contra `APTS_test` hasta `phase=done`; 3 divergencias del resolver
  corregidas en ambas superficies; adaptadores regenerados idempotentes; `contract-check` 21 ops).
  Arranca F5-4. Decisión de enfoque de F5-4-T1 (server de PROD desplegado vs. simular cliente fresco
  contra `APTS_test`) pendiente de confirmación del operador antes de cualquier escritura.
- 2026-06-21 — **F5-3-T2/T3 hechas y verificadas → GATE F5-3.** T2 (afinado de conducción): editado el
  cuerpo del orquestador en **ambas** superficies — `integracion/plantillas-agentes/apts-method-orchestrator.agent.md`
  (template canónico) y `integracion/paquete-apts/runtime-adapters/spec/apts-surface.json` (fuente del
  generador) — corrigiendo 3 divergencias contra el resolver real: cierre `dev-story` vía `apts_submit_step`,
  `wait` bicéfalo (switch identidad vs. sin unidades libres), y `apts_submit_step ok:false`/`await_input`.
  T3 (validación end-to-end): driver throwaway `_f5_t3_driver.cjs` (JSON-RPC → `apts-mcp.js`, **borrado**
  tras la prueba) condujo un lifecycle real contra `APTS_test` hasta `phase=done` vía el adaptador (no
  harness directo). T3 surfaced `dev-story` multi-paso (10 pasos) → la Delegation Rule se corrigió para
  recorrer el workflow hasta el output `status` (re-editadas ambas superficies). Adaptadores regenerados
  (`node scripts/generate-adapters.js` x2, idempotente): los 5 archivos del método (claude/opencode/vscode)
  reflejan el cuerpo afinado; ningún adaptador existente cambió de forma (único `M` = `claude/.claude/settings.json`,
  carryover F5-2). `contract-check` verde (21 ops). Sin migraciones. Infra de test: backend arrancado con
  launcher in-process `NODE_ENV=test` (el prefijo de env inline no se propaga a procesos background en este
  entorno; verificado `environment:test` + identidad de DB por las 2 initiatives conocidas antes de escribir).
  `APTS_test` restaurado (2 throwaway borradas íntegras; 2 preexistentes intactas; 0 restos); server y
  temporales eliminados.
- 2026-06-21 — **F5-3-T1 hecha y verificada → GATE F5-3-T1.** Surface + regeneración idempotente.
  Archivos: `integracion/paquete-apts/runtime-adapters/spec/apts-surface.json` (nuevo agente
  `apts-method-orchestrator` tras `apts-backlog-orchestrator` en `agents[]` con el cuerpo de
  conducción portado del template canónico de F5-2; nuevo comando `apts-method` tras `apts-next` en
  `commands[]` con `agent:apts-method-orchestrator`, bootstrap→drive loop y `$ARGUMENTS` al final; el
  `git diff` del spec son solo adiciones: 26 inserciones, 0 borrados). `node scripts/generate-adapters.js`
  corrido **dos veces** → idempotente (2ª pasada sin diff vs árbol generado). 5 archivos nuevos:
  `runtime-adapters/{claude/.claude/agents/apts-method-orchestrator.md,claude/.claude/commands/apts-method.md,
  opencode/.opencode/agent/apts-method-orchestrator.md,opencode/.opencode/command/apts-method.md,
  vscode/agents/apts-method-orchestrator.agent.md}`. Ningún adaptador existente cambió de forma; único
  `M` previo = `claude/.claude/settings.json` (carryover de F5-2, allowlist `create_initiative`/
  `set_agent_role`). `contract-check` verde (21 ops; F5-3 no toca el contrato). Sin migraciones. La
  lógica fina de conducción + la validación end-to-end vía el adaptador quedan para F5-3-T2/T3 tras la
  firma del gate.
- 2026-06-21 — **F5-2 GATE ✅ firmado por el operador.** Aprobada la evidencia (adaptadores regenerados
  idempotentes, `method_orchestrator_agent` publicado + servible, bump `3.0.0→3.1.0`). Arranca F5-3-T1.
- 2026-06-21 — **F5-1 GATE ✅ firmado por el operador.** Aprobada la evidencia (bootstrap idempotente,
  `set_agent_role` con `entity_id` no-null, `apts_next` entrega 1er step, contract-check 21 ops).
  Arranca F5-2.
- 2026-06-21 — **F5-2 T1/T2/T3 hechas → F5-2 en GATE.** T1: `node scripts/generate-adapters.js` x2,
  idempotente; único cambio derivado del contrato = `runtime-adapters/claude/.claude/settings.json`
  (allowlist MCP + `create_initiative` + `set_agent_role`). T2: archivos `backend/index.js` (entrada
  `method_orchestrator_agent` en `integrationArtifacts` + ruta express
  `GET …/agentes/apts-method-orchestrator.agent.md`) y nuevo
  `integracion/plantillas-agentes/apts-method-orchestrator.agent.md` (cuerpo de conducción real:
  bootstrap + roster Opción A + drive loop con las formas reales del resolver). T3: `backend/index.js`
  (`integrationManifestSchemaVersion` `3.0.0→3.1.0` + nota append-only en comentario). `node --check
  backend/index.js` verde. Sin migraciones nuevas. Límite de fase registrado: el cuerpo de conducción
  se escribió en F5-2-T2 (el manifiesto exige `filePath` existente); F5-3 lo porta a `apts-surface.json`,
  añade mapping vscode, regenera el adaptador y valida end-to-end.
- 2026-06-21 — Creados PLAN y TRACKING F5 tras verificar el bloqueo (sin op de bootstrap; `apts_next`
  devuelve `blocked` sin initiative/project_state; únicos creadores = seeds `f1`/`f4`).
- 2026-06-21 — **F5-0 (investigación):** PoC roster en `APTS_test` (throwaway, ya borrado) cierra la
  decisión #2 → Opción A. Hallazgo lateral: la instancia f4 viva tiene `project_state.entity_id=null`
  en sus 5 punteros (estado stale) → `wait` eterno, prueba en vivo del bug. Ubicada la fuente del
  manifiesto (`integrationArtifacts` en `index.js:1965`). Ledger propuesto completo; quedan firmas
  #1/#3/#5. Sin cambios de código (fase de diseño); no quedó nada sin borrar en `APTS_test`.
- 2026-06-21 — **F5-0 GATE ✅ firmado.** Operador aprobó las 6 decisiones tal como se recomendaron
  (#1 separadas, #3 spec-artefacto, #5 epic plegado; #2/#4/#6 ya cerradas). Formas JSON fijadas.
  Fase F5-0 cerrada. Próximo: F5-1-T1 (`create_initiative`).
- 2026-06-21 — **F5-1-T2/T3/T4 hechas y validadas → F5-1 en GATE.** `set_agent_role` recorriendo
  contrato→cliente→ruta→lógica. Archivos: `backend/scripts/lib/method_bootstrap.js` (nuevo `setAgentRole`
  + export); `backend/index.js` (require de `setAgentRole` + ruta fina `POST /api/projects/agent-roles`);
  `integracion/paquete-apts/apts_skills.json` (skill `set_agent_role`, required `agent_name`+`entity_key`);
  `integracion/paquete-apts/apts-client.js` (autofill `set_agent_role:['project_url']` + `validateSetAgentRoleInput`
  + `setAgentRole` + export). Upsert idempotente sobre `unique(initiative_id, agent_name)`; resuelve
  `entity_key`→`entity_id` contra `entities` scopeadas por el `source_ref` de la iniciativa y lo persiste
  **no-null** (causa del `wait` eterno del PoC); rechaza key ajena; exige iniciativa activa.
  `apts-mcp.js` expone la tool automáticamente (deriva del contrato). T3: `contract-check` verde (21 ops),
  sin tocar `contract-check.js`. T4: harness throwaway en `APTS_test` (14 asserts verdes) — bootstrap+roster
  → `apts_next` da `run_step` del rol requerido y `wait` a los demás; `APTS_test` restaurado (2 initiatives
  preexistentes intactas, 0 restos). Migración: ninguna nueva (reusa el esquema `project_state` de F0).
- 2026-06-21 — **F5-1-T1 hecha y validada.** `create_initiative` recorriendo contrato→cliente→ruta→lógica.
  Archivos: `backend/scripts/lib/method_bootstrap.js` (nuevo: `createInitiative` + `writeSpecArtifact` +
  `ensureProject`); `backend/migrations/20260621000016_artifact_doc_type_spec.js` (nuevo: `spec` al enum
  `doc_type`, aditivo); `backend/index.js` (require + ruta fina `POST /api/projects/initiatives`);
  `integracion/paquete-apts/apts_skills.json` (skill `create_initiative`); `integracion/paquete-apts/apts-client.js`
  (validador + `createInitiative` + autofill `project_url` + enums track/phase + export). Migración aplicada
  en `APTS_test` (Batch 8). `contract-check` verde (20 ops, incluye `create_initiative`). `apts-mcp.js`
  expone la tool automáticamente (deriva del contrato). Harness throwaway corrido y borrado; `APTS_test`
  restaurado (2 initiatives preexistentes intactas). Hallazgo registrado para el gate: `bmad-product-brief`
  tiene `needs:[]` → la spec no se autoconsume aún (cableado del need = F5-3).
