# Tracking F6: MCP remoto

> Compañero de [`PLAN-mcp-remoto.md`](./PLAN-mcp-remoto.md).
> Este doc es **autosuficiente**: una sesión nueva retoma leyendo solo esto + el plan.
> Marca `[x]` al completar cada tarea y actualiza "Estado global" y "Próxima acción".
> Rama: `feat/mcp-remoto`. Base: `main` @ `6fd94ac`, que es el commit que trae este documento y el
> PLAN. *(Este doc decía antes `52e68dc`; ese commit es anterior y no contiene los dos documentos.)*

## Regla de proceso (innegociable)

**Se PARA al final de cada fase** en un GATE de validación humana. No se empieza la fase siguiente
hasta que el operador apruebe el gate de la actual. Si una tarea revela que una decisión del registro
estaba mal planteada, se detiene y se replantea, no se improvisa.

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
| F6-0 Diseño, verificación y cierre del registro de decisiones | ✅ Hecho | ✅ **firmado 2026-08-01** | 7/7 decisiones firmadas. La #1 replantea el registro: identidad en la configuración del cliente |
| F6-1 Prueba del transporte Streamable HTTP | ✅ Hecho | ✅ **firmado 2026-08-01** | 4/4 tareas. Cabecera confirmada en Claude Code **y** opencode; cero identidad del servidor en `APTS_test` |
| F6-2 Ejecución dentro del proceso + igualdad de validación | ✅ Hecho | ✅ **firmado 2026-08-01** | 5/5 tareas. **21/21 operaciones en verde, cero bloqueos**; sin salto HTTP interno; sin dependencias nuevas ni migraciones |
| F6-3 Registro remoto en el manifiesto | ✅ Hecho | ✅ **firmado 2026-08-01** | 4/4 tareas. Bump aditivo 3.1.0 → 3.2.0 comprobado (0 claves perdidas); `vscode` **sí** envía las cabeceras |
| F6-4 Validación end-to-end desde cliente fresco | ✅ Hecho | 🛑 **espera firma** | 3/3 tareas. `phase=done` desde cliente fresco; **0 descargas del núcleo ejecutable**; `APTS_test` restaurado |

Leyenda: ⬜ Pendiente · 🟡 En curso · ✅ Hecho · ⛔ Bloqueado · 🛑 En gate (espera operador)

**Próxima acción:** **F6-4 está en su punto de parada, esperando la firma del operador.** La
evidencia está en [Informe de identidad F6-4-T2](#informe-de-identidad-f6-4-t2), en
[Hallazgos de F6-4](#hallazgos-de-f6-4) y en el [Informe de cierre F6](#informe-de-cierre-f6--mcp-remoto).
Al firmar: borrar el cliente desechable y los seis programas de comprobación, que están fuera del
repositorio. **No marcar F6 cerrada hasta la firma.**

## Contexto de arranque (lo que ya está verificado)

- **F5 cerrada y firmada** (2026-06-21): el motor de método es conducible desde un cliente solo-spec
  vía MCP stdio + adaptador orquestador. Ver [`TRACKING-motor-metodo-cliente.md`](./TRACKING-motor-metodo-cliente.md).
- **`dispatch()` es transporte-agnóstico** salvo que escribe en stdout (`apts-mcp.js:133`; `send()`
  en `:52`). Métodos soportados: `initialize`, `tools/list`, `tools/call`, `ping`, más notificaciones.
- **Las tools se derivan del contrato**: `buildTools()` sobre `contractOperations()`
  (`apts-mcp.js:28`), con `checkMcpContract()` en el arranque. 21 operaciones.
- **Protocolo declarado**: `2025-06-18` (`apts-mcp.js:24`).
- **Auth ya existente**: `authenticateAgent` valida `Bearer <APTS_API_KEY>` (`backend/index.js:159`).
- **`trust proxy` ya configurado** (`backend/index.js:35`).
- **Rate limits actuales**: `loginLimiter` 5/15min, `apiLimiter` 100/min (`backend/index.js:156-157`).
- **Manifiesto**: `schema_version` 3.1.0 (`backend/index.js:1980`), 13 artefactos en
  `integrationArtifacts` (`:1983`), base pública `/api/public/integrar` (`:1981`).
- **Coste medido del manifiesto**: `bootstrap` 22,4 KB (~5.600 tokens), `instructions[]` 4,7 KB
  (~1.160), `artifacts[]` 9,8 KB (~2.450). Total ~9k tokens por integración.
- **El `.mcp.json` existe pero no se publica**: lo genera `generate-adapters.js` en
  `runtime-adapters/claude/.mcp.json`; el manifiesto declara que los adaptadores generados **no** son
  artefactos descargables (`agent_runtime_adapters.generation.policy`, `backend/index.js:2392`), y
  `agent_runtime_adapters.mappings` (`:2394`) solo tiene entradas `vscode`.

---

## F6-0 — Diseño, verificación y cierre del registro de decisiones

> Sin código. Salida: las 7 decisiones de §3 del PLAN cerradas por escrito.
> **Fase terminada y firmada el 2026-08-01.** Lo que sigue queda como constancia de lo hecho.

- [x] **F6-0-T1** Verificaciones sobre el repositorio. → resultados en
  [Verificaciones F6-0-T1](#verificaciones-f6-0-t1).
  - *(a)* De las 21 operaciones, ¿cuántas tienen ya la lógica en una función aparte reutilizable, y
    cuántas la llevan dentro de la ruta? Alimenta la decisión #3. → **18 de 21 reutilizables.**
  - *(b)* ¿Dónde se valida hoy cada llamada — en `apts-client.js`, en la ruta, o en ambas? Alimenta
    la decisión #4. → **6 huecos.**
  - *(c)* ¿Qué operaciones pueden agotar el plazo de espera del cliente? → **el riesgo no era el que
    suponía el PLAN**: `analyze` y el reindexado son rutas del panel y no están entre las 21; el
    problema real es la llamada a OpenRouter sin plazo en las escrituras de backlog.
  - *Aceptación:* tres listas concretas, con archivo y línea. ✅
- [x] **F6-0-T2** Cerrar **#1, el modelo de identidad** → resuelto **sin prueba de concepto** (se
  cerró sobre el código; `APTS_test` no se tocó). Ver
  [Decisión #1](#decisión-1--modelo-de-identidad).
  **Replantea el registro de decisiones**: la resolución no es ninguna de las tres opciones que
  proponía el PLAN.
- [x] **F6-0-T3** Cerrar las decisiones restantes (#2, #5, #6, #7) → tabla de abajo, 7 de 7 con
  resolución; detalle en [Decisiones #2, #5, #6 y #7](#decisiones-2-5-6-y-7).
- [x] **F6-0-GATE** ✅ **Firmado por el operador el 2026-08-01.** Las 7 decisiones quedaron
  resueltas, más una añadida (plazo de espera en la llamada externa). Forma de la ruta y modelo de
  identidad fijados por escrito. F6-1 queda habilitada.

### Verificaciones F6-0-T1

> Inspección de repo, sin ejecutar nada. Base: `feat/mcp-remoto` @ `6fd94ac`.

#### (a) Cuántas operaciones tienen ya la lógica en una función aparte — alimenta la decisión #3

**18 de 21 la tienen** ("ruta delgada": la ruta solo recibe y reenvía, el trabajo está en una
función aparte que se puede llamar directamente). Las 3 restantes llevan la lógica dentro de la
ruta, y las tres son de **solo lectura**: ninguna escribe.

| # | Operación | Ruta | Destino | Clasif. |
|---|---|---|---|---|
| 1 | `register_task` | `POST /api/projects/tasks` `index.js:3084` | `registerTaskInternal` `index.js:2699` | fina |
| 2 | `read_project_context` | `GET /api/projects/context` `index.js:3123` | — queries `tasks`/`agent_logs` en la ruta | **dentro de la ruta** |
| 3 | `list_backlog_items` | `GET /api/projects/backlog` `index.js:3235` | `listBacklogItems` `index.js:1805` | fina |
| 4 | `get_backlog_item` | `GET /api/backlog/:id` `index.js:3363` | — query `backlog_items` en la ruta | **dentro de la ruta** |
| 5 | `get_task` | `GET /api/tasks/:id` `index.js:3709` | — query `tasks`+`agent_logs`+heartbeats en la ruta | **dentro de la ruta** |
| 6 | `get_project_constraints` | `GET /api/projects/:url/constraints` `index.js:3215` | `getProjectConstraints` `index.js:1779` | fina |
| 7 | `search_similar_bug_reports` | `POST /api/projects/backlog/semantic-search` `index.js:3281` | `searchSimilarBugReports` `index.js:1883` | fina |
| 8 | `create_backlog_item` | `POST /api/projects/backlog` `index.js:3334` | `createBacklogItemInternal` `index.js:2802` | fina |
| 9 | `update_backlog_item` | `PATCH /api/backlog/:id` `index.js:3397` (batch `:3423`) | `updateBacklogItemInternal` `index.js:2837` | fina |
| 10 | `delete_backlog_item` | `DELETE /api/backlog/:id` `index.js:3410` (batch `:3466`) | `deleteBacklogItemInternal` `index.js:2877` | fina |
| 11 | `update_task_status` | `PATCH /api/tasks/:id/status` `index.js:3789` (batch `:3812`) | `updateTaskStatusInternal` `index.js:2902` | fina |
| 12 | `log_agent_progress` | `POST /api/tasks/:id/logs` `index.js:3859` (batch `:3882`) | `logAgentProgressInternal` `index.js:2975` | fina |
| 13 | `report_blocker` | `POST /api/projects/blockers` `index.js:3929` | `reportBlockerInternal` `index.js:3009` | fina |
| 14 | `heartbeat` | `POST /api/tasks/:id/heartbeat` `index.js:3968` (batch `:3991`) | `heartbeatInternal` `index.js:3058` | fina |
| 15 | `apts_next` | `POST /api/projects/next` `index.js:3583` | `aptsNext` (`method_resolver.js`) | fina |
| 16 | `apts_status` | `GET /api/projects/method-status` `index.js:3606` | `methodStatus` (`method_resolver.js`) | fina |
| 17 | `apts_set_status` | `PATCH /api/backlog/:id/method-status` `index.js:3627` | `setMethodStatus` (`method_resolver.js`) | fina |
| 18 | `apts_workflow_step` | `POST /api/projects/workflow-step` `index.js:3655` | `aptsWorkflowStep` (`method_resolver.js`) | fina |
| 19 | `apts_submit_step` | `POST /api/projects/submit-step` `index.js:3683` | `aptsSubmitStep` (`method_resolver.js`) | fina |
| 20 | `create_initiative` | `POST /api/projects/initiatives` `index.js:3509` | `createInitiative` `method_bootstrap.js:75` | fina |
| 21 | `set_agent_role` | `POST /api/projects/agent-roles` `index.js:3550` | `setAgentRole` `method_bootstrap.js:183` | fina |

Matiz que importa para #3: de las 18 finas, **7 apuntan a módulos reales de
`backend/scripts/lib/`** (5 al `method_resolver.js`, 2 al `method_bootstrap.js`), con `db`
inyectado y sin Express. Las **11 restantes son `const` de ámbito de módulo dentro del propio
`backend/index.js`** (`*Internal`, `listBacklogItems`, `getProjectConstraints`,
`searchSimilarBugReports`). Eso **no es un obstáculo**: la ruta `POST /mcp` vive también en
`index.js`, así que las tiene todas en ámbito sin extraer nada ni crear ciclos de import. Todas
aceptan ya `{ connection }` o `db` como parámetro.

Lo que **no** es reutilizable y habría que rehacer al llamar directamente, porque hoy vive en la
ruta y no en la función:
- El parseo de query-string (`normalizeUrl`, `validateResponseView`,
  `parseOptionalNonNegativeInteger`, `parseCommaSeparatedUuidList`) — las 4 ops que leen de
  `req.query` (`read_project_context`, `list_backlog_items`, `get_backlog_item`, `get_task`).
- La orquestación de batch (`normalizeBatchRequestBody`, `executeBatchOperation`,
  `executeStrictBatchOperation`, `sendBatchOperationResponse`) — 7 ops la tienen en la ruta.
- El envoltorio de respuesta de `search_similar_bug_reports` (el bloque `query:{…}`, `index.js:3309`)
  y el clamp de `top_k` (`index.js:3296`).

#### (b) Dónde se valida hoy y qué hueco deja el remoto — alimenta la decisión #4

El camino remoto **no pasa por `apts-client.js`**, así que todo lo que hoy solo valida el cliente es
hueco. Resultado: **6 huecos reales, 1 divergencia de comportamiento, 14 ops en paridad.**

| Operación | Cliente (`apts-client.js`) | Servidor | Veredicto |
|---|---|---|---|
| `register_task` | `agent_name`, `agent_email` **requiredString** `:816-817` | `registerTaskBodySchema:847-848` ambos **opcionales**; inserta `agentName \|\| null` `:2770` | 🔴 **hueco** |
| `update_task_status` | requiere `project_url`, `agent_name`, `agent_email` `:1173-1175` | `taskStatusUpdateBodySchema:859` solo exige `status`; `agent_email` **ni existe** en el schema | 🔴 **hueco** |
| `log_agent_progress` | requiere `agent_name` y `branch` `:1199-1200` | `logAgentProgressBodySchema:869` ambos opcionales; `branch` va crudo al insert `:3001` | 🔴 **hueco** |
| `report_blocker` | requiere `agent_name` `:1215` | `reportBlockerBodySchema:884` opcional | 🟠 hueco menor |
| `heartbeat` | requiere `task_id`, `agent_name`, `project_url` `:1237-1239` | `heartbeatBodySchema:887` opcionales — y `heartbeatInternal:3058` **ignora el body entero** | 🟠 hueco cosmético (los campos no se usan) |
| `create_initiative` | valida `track`∈enum, `phase`∈enum, `spec_artifact.content` **requiredString** `:1782-1801` | ruta `:3509` solo valida `project_url`+`title`+`spec_artifact` es objeto; `createInitiative` `method_bootstrap.js:85-95` solo `project_url`+`title`; `track`/`phase` van **directos al insert** `:129` | 🔴 **hueco** |
| `search_similar_bug_reports` | `top_k` fuera de 1..20 → **rechaza** `:1021` | `semanticBugSearchBodySchema:903` sin min/max; la ruta **clampea** `:3296` | 🟡 divergencia (rechaza vs. clampea) |
| `create_backlog_item` | enums/enteros `:1050` | `createBacklogItemInternal:2802` → `getBacklogPayload:1950` → `backlogCreatePayloadSchema:975` | ✅ paridad |
| `update_backlog_item` | uuid + ≥1 campo `:1107` | `updateBacklogItemInternal:2838,2847` | ✅ paridad |
| `delete_backlog_item` | uuid | `deleteBacklogItemInternal:2878` | ✅ paridad |
| `get_backlog_item` / `get_task` | uuid | `backlogIdParamSchema:840` / `taskIdParamSchema:836` | ✅ paridad |
| `read_project_context` / `list_backlog_items` / `get_project_constraints` | url + enums + enteros | ruta `:3125-3143` / `:3237-3261` / `:3217` | ✅ paridad |
| `apts_next` / `apts_workflow_step` / `apts_submit_step` | `project_url`+`agent_name` (+objeto) | rutas `:3584-3667`, `:3684-3695` | ✅ paridad |
| `apts_status` | `project_url` | ruta `:3607` | ✅ paridad |
| `apts_set_status` | uuid + enum | ruta `:3629-3635` | ✅ paridad |
| `set_agent_role` | los 3 campos | ruta `:3551-3562` | ✅ paridad |

Sobre la gravedad de cada hueco:

1. **`create_initiative` es el único que llega a la base de datos.** `track` y `phase` se insertan
   sin comprobar, pero la migración los declara `t.enu(...)`
   (`20260620000010_bmad_hierarchy.js:21-22`), que en Postgres crea una restricción. O sea: no se
   corrompen datos, pero un `phase:'banana'` enviado desde el cliente remoto sale como **error 500
   con el detalle interno de la base filtrado**, en vez de un rechazo limpio con 400. Lo mismo si
   `spec_artifact.content` no es texto: revienta en `crypto.createHash().update()`
   (`method_bootstrap.js:50`).
2. **Los otros cinco son de trazabilidad, no de integridad.** El servidor acepta guardar
   `agent_name`, `agent_email` o `branch` vacíos donde el camino actual los exigía. No rompen nada;
   se pierde el rastro de quién hizo cada cosa.

#### (c) Operaciones que pueden agotar el plazo de espera del cliente

**El riesgo no está donde lo situaba el PLAN.** `analyze` y el reindexado son rutas del panel de
control (`requireAuth`, `index.js:4300`, `:4324`, `:4166`) y **no están entre las 21 operaciones**,
así que no se alcanzan desde `/mcp`. El riesgo real es otro:

- **Llamada externa a OpenRouter con el cliente esperando, en toda escritura de backlog.**
  `runNonBlockingSemanticOperation` (`index.js:609`) tolera fallos, pero **no difiere nada**: hace
  `return await operation()`. La cadena `syncBacklogCoverageDocument`
  (`semantic_documents.js:237`) → `persistSemanticDocumentEmbedding` (`:192`) → `requestEmbedding`
  (`semantic_embeddings.js:162`) llama a la API de OpenRouter **con el cliente esperando**. Afecta a
  `create_backlog_item`, `update_backlog_item`, `register_task` (con `backlog_item_id`),
  `update_task_status` y `report_blocker` (cuando hay item ligado). Aplica a **todos** los items, no
  solo a los `bug` (el embedding de bug, `index.js:1409`, sí es solo para bugs).
- **Esa llamada no tiene plazo de espera** (`semantic_embeddings.js:173`: `fetch` sin `AbortSignal`).
  Si OpenRouter no responde, la escritura queda esperando sin límite. Por el camino actual se notaba
  menos, porque el cliente local no imponía plazo; un cliente remoto sí lo impone y corta.
- **En modo lote se multiplica**: N elementos en una llamada son N llamadas externas, una detrás de
  otra (`syncBacklogCoverageDocuments`, `semantic_documents.js:272`, es un bucle con espera).
- `search_similar_bug_reports` hace una sola llamada externa, para la consulta. Es lo esperado.
- `apts_submit_step` **no** hace ninguna: `upsertArtifact` (`method_resolver.js:497`) guarda el
  documento sin calcular índice. No es riesgo.
- Los listados grandes **ya están acotados** desde `25b1111` (50 por omisión, 200 como máximo).

**Hallazgo adicional del mismo repaso:** `express.json()` está sin configurar (`index.js:109`), lo
que deja el tamaño máximo de mensaje en **100 kb**. `create_initiative.spec_artifact.content` (la
especificación completa del cliente) y `apts_submit_step.output` (un PRD, un documento de
arquitectura) lo superan con facilidad. Ya ocurre por el camino actual; el remoto solo lo hace más
visible. Se resuelve en la decisión #6.

### Decisión #1 — Modelo de identidad

> **Decidida por el operador (2026-08-01): la identidad va en la configuración del cliente.**
> Esta resolución **replantea el registro de decisiones**: no es ninguna de las tres opciones que
> proponía el PLAN. Las tres daban por hecho que la identidad tenía que viajar dentro de la llamada
> o dentro de una sesión. Hay un cuarto sitio, que es donde ya viaja la clave de acceso: **la
> cabecera HTTP**.

**Por qué se descartaron las otras dos, comprobado en el código:**

- **Clave por proyecto.** Haría falta una clave distinta por proyecto. Hoy `APTS_API_KEY` es **un
  único secreto global**, comparado por igualdad literal (`backend/index.js:165`). No hay tabla de
  claves, ni emisión, ni rotación, ni relación clave–proyecto. Construirlo es una migración más un
  ciclo de vida de credenciales: queda fuera de las "~150 líneas, sin dependencias nuevas, sin
  migraciones" que estimaba el PLAN §5, y además reabre la decisión #5.
- **Identidad guardada por sesión.** Obliga a mantener estado, en contra de la decisión #2. Y tiene
  un fallo peor: si la sesión se cae a mitad de un ciclo de trabajo, el agente sigue escribiendo con
  la identidad equivocada **sin que nadie se entere**.

**Cómo queda: la cabecera pone el valor por omisión, y la llamada lo puede sobrescribir.**

El bloque de registro ya lleva una cabecera para la clave de acceso; ahora lleva también la
identidad. Es la misma resolución automática que hoy hace `apts-client.js` leyendo el entorno, salvo
que se muda al archivo de configuración del cliente, que se escribe **una sola vez** al integrar y
lo lee el programa cliente, nunca el agente:

```json
{ "mcpServers": { "apts": {
    "type": "http",
    "url": "https://apts.informaticos.ar/mcp",
    "headers": {
      "Authorization":      "Bearer ${APTS_API_KEY}",
      "X-APTS-Project-Url": "${APTS_PROJECT_URL}",
      "X-APTS-Agent-Name":  "${APTS_AGENT_NAME}",
      "X-APTS-Agent-Email": "${APTS_AGENT_EMAIL}"
    }
}}}
```

**Orden de prioridad en el servidor**, que reproduce el del cliente actual quitando la parte de Git:
**lo que trae la llamada gana a la cabecera, y si faltan las dos se responde con un error claro.**
Nunca hay un tercer nivel adivinado.

Tres motivos, por orden de peso:

1. **Conserva el cambio de rol de F5.** El reparto de roles es *un nombre de agente por rol*, y el
   orquestador va cambiando de identidad según el rol que le devuelve `apts_next`
   (`method_bootstrap.js:175-177`). Con una identidad totalmente fija eso se rompe. Como la llamada
   gana a la cabecera, el orquestador manda el nombre cuando cambia de rol y omite el resto. Las
   otras dos opciones también lo habrían roto.
2. **No añade texto en el ciclo de trabajo.** Ver la tabla siguiente.
3. **No inventa ningún mecanismo.** Poner cabeceras en la configuración de un servidor HTTP es lo
   habitual en Claude Code, opencode y VS Code: es el mismo sitio donde ya iría la clave de acceso.
   No necesita estado, así que encaja con la decisión #2. *(Queda por comprobar programa por
   programa en F6-3; aquí se afirma por convención del protocolo, no por evidencia del repositorio.)*

**Cuánto texto extra cuesta**, midiendo con la misma convención (4 caracteres por unidad) con la que
se midieron los ~9k del manifiesto. Se compara contra el camino actual, que no cuesta nada:

| Situación | Si el agente lo escribiera siempre | Con la identidad en la configuración |
|---|---|---|
| Una pasada por las 16 operaciones que hoy resuelven identidad sola | **~360** | ~50 (solo `task_id`) |
| Un ciclo de método modesto (12 pasos: `apts_next`+`workflow_step`+`submit_step` ×12) | **~790** | **0** |
| Bucle de ejecución de tarea (heartbeat y registro de avance ×20) | ~680 | ~240 (`task_id`) |

Conviene decirlo con claridad: **el ahorro de texto no es el argumento principal.** Unas 800
unidades sobre un manifiesto de 9.000 es ruido. El costo real de hacer que el agente lo escriba
todo es la **tasa de error**: obligarlo a arrastrar un identificador largo y una URL correctos a lo
largo de decenas de llamadas, sin ningún archivo local contra el que contrastarlos. Eso es lo que
mide el punto de parada de F6-1, y es la razón de que exista.

**Qué escribe el agente en cada operación.** Lo de la derecha es lo que deja de escribir.

| Operación | El agente escribe | Lo pone la cabecera |
|---|---|---|
| `create_initiative` | `{title, spec_artifact?}` | `project_url` |
| `set_agent_role` | `{agent_name, entity_key}` | `project_url` |
| `apts_next` | `{}` · `{agent_name}` al conmutar rol | `project_url`, `agent_name` |
| `apts_status` | `{}` | `project_url` |
| `apts_workflow_step` | `{}` · `{answers}` si reanuda | `project_url`, `agent_name` |
| `apts_submit_step` | `{output}` | `project_url`, `agent_name` |
| `apts_set_status` | `{backlog_item_id, status}` | — (no lleva identidad) |
| `register_task` | `{title, backlog_item_id?}` | `project_url`, `agent_name`, `agent_email` |
| `read_project_context` | `{}` + filtros | `url` ← `project_url` |
| `list_backlog_items` | `{}` + filtros | `url` ← `project_url` |
| `get_project_constraints` | `{}` | `url` ← `project_url` |
| `search_similar_bug_reports` | `{query_text}` | `url` ← `project_url` |
| `create_backlog_item` | `{title, …}` | `project_url` |
| `update_backlog_item` | `{backlog_item_id, …}` | — |
| `delete_backlog_item` | `{backlog_item_id}` | — |
| `get_backlog_item` / `get_task` | `{backlog_item_id}` / `{task_id}` | — |
| `update_task_status` | `{task_id, status}` | `project_url`, `agent_name`, `agent_email` |
| `log_agent_progress` | `{task_id, message, technical_details?}` | `project_url`, `agent_name` |
| `report_blocker` | `{task_id, error_message}` | `project_url`, `agent_name` |
| `heartbeat` | `{task_id}` | `project_url`, `agent_name` |

**Hay dos datos que la cabecera no puede cubrir, y se tratan distinto:**

- **La rama** (`branch`, solo en `log_agent_progress`) no puede ir en la cabecera porque cambia
  durante la sesión y el servidor no ve el repositorio del cliente. Pasa a escribirse en la llamada,
  y queda **opcional**: el servidor ya la acepta vacía (`index.js:869`, `:3001`). Se asume la
  pérdida, porque es un dato de rastro, no de integridad.
- **El identificador de tarea** (`task_id`, en 5 operaciones) se escribe en la llamada, y **no** se
  va a deducir en el servidor en esta versión. El motivo es que el agente **lo recibe en la
  respuesta de `register_task`** (`index.js:2793`), o sea que lo tiene delante; y las 3 operaciones
  del ciclo principal del método (`apts_next`, `apts_workflow_step`, `apts_submit_step`) **no lo
  usan**. Deducirlo a partir del proyecto y el agente es posible —`backlog_items.active_task_id` y
  la tabla `tasks` lo permiten— pero hay casos ambiguos (varias tareas en curso del mismo agente) y
  sería comportamiento nuevo. **Queda como salida de emergencia**: si en F6-1 se ve que el agente se
  equivoca con esos identificadores, se añade la deducción ahí, respondiendo con un error claro
  cuando sea ambigua.

> ⚠️ **Restricción obligatoria para F6-1**, que sale de la verificación (a).
> En F6-1 la ruta `/mcp` llama a `apts-client.js` **dentro del propio proceso del servidor**. La
> resolución automática del cliente (`enrichPayloadWithExecutionIdentity`, `apts-client.js:710`)
> ejecutaría entonces `git remote get-url origin` y leería `.apts/execution-context.json` **del
> servidor**, no del cliente: una llamada sin `project_url` acabaría escribiendo contra el propio
> repositorio de APTS, en silencio.
> Por eso `/mcp` **tiene que** resolver la identidad (llamada, luego cabecera), **metérsela a la
> llamada antes** de invocar al cliente, y **rechazar con un error claro** cuando falte, para que la
> resolución automática del cliente no llegue a actuar nunca. El `hasNonEmptyString` de
> `apts-client.js:719` garantiza que un campo ya presente no se pisa. Son ~10 líneas, pero **no son
> opcionales**.

### Decisiones #2, #5, #6 y #7

**#2 — Sin estado.** Al viajar la identidad en cabeceras, que acompañan a *cada* petición, no queda
nada que recordar entre una llamada y la siguiente. No se emite `Mcp-Session-Id`, y `GET /mcp`
responde `405`. La única opción que obligaba a mantener estado era la de guardar la identidad por
sesión, que quedó descartada en la decisión #1.

**#5 — Clave de acceso fija, reutilizando `authenticateAgent` (`index.js:159`) sin tocarlo.** Se
aplica **antes** de interpretar el mensaje, de modo que una clave inválida se rechaza a nivel de
transporte (401 o 403) y nunca llega al despachador. OAuth 2.1 se deja fuera de esta versión y no
queda bloqueado: el día que entre, sustituye a esta comprobación sin tocar `dispatch()`.
Detalle: la ruta `/mcp` **no** debe añadirse a `isFrontendServiceRequest` (`index.js:47`), porque es
superficie de agente y no del panel de control.

**#6 — Ruta, tope de peticiones y tamaño de mensaje.** Tres piezas:

- **Ruta `/mcp`**, no `/api/mcp`. El manifiesto público cuelga de `/api/public/…` y la API de
  `/api/…`; `/mcp` deja claro que es otra superficie, no una ruta más de la API.
- **Tope de peticiones: se sube el global a 600 por minuto** (`apiLimiter`, `index.js:157`, hoy en
  100). *Elección del operador, distinta de la recomendación.* El problema es real: en remoto cada
  operación es **una** petición HTTP —por el camino actual muchas viajaban dentro de un solo
  proceso— y `initialize` más `tools/list` añaden tráfico al arrancar. En F5-4 ya se agotó el tope.
  **Costo asumido**: agente y panel de control comparten cuota, así que una ráfaga de uno puede
  dejar sin servicio al otro. Se recomendaba un contador aparte para `/mcp` precisamente por eso; si
  durante F6 aparecen agotamientos cruzados, separarlos es un cambio pequeño.
  `trust proxy` ya está puesto (`index.js:35`), así que contar por dirección de origen funciona
  detrás del proxy.
- **Tamaño de mensaje**: `express.json()` está sin configurar (`index.js:109`), lo que deja el tope
  en **100 kb**. Se monta `express.json({ limit: '4mb' })` **solo en `/mcp`**, sin tocar el tope
  general: el panel de control no manda documentos y no necesita ese margen.

**#7 — Convivencia sí; recorte de la prosa, fuera de alcance.** `mcp_server`, `js_client`,
`contract_check` y `package_manifest` se marcan como obsoletos en el manifiesto **pero se siguen
sirviendo**: retirarlos rompería a los clientes que usan la versión 3.1.0, y la convivencia con el
camino actual es una restricción dura del PLAN §2. `contract-check` pasa además a ser una prueba
interna del backend (F6-2-T3), sin dejar de publicarse. El recorte de los ~6.800 del manifiesto
**no entra en F6**: es trabajo aparte, y mezclarlo enturbiaría el criterio de F6-3.

> **Lo que F6-3 tendrá que corregir:** la sección gestionada de `CLAUDE.md`
> (`runtime-adapters/claude/CLAUDE.md`) explica la resolución automática de identidad, y su
> **regla 9 dice literalmente "Never invent `project_url`, `agent_name`, or `branch`; let autofill
> resolve them"**. Para el cliente remoto esa regla es **falsa**: no hay resolución automática
> local, y la identidad la pone la cabecera del registro. Los adaptadores generados y esa prosa hay
> que regenerarlos en F6-3, como dato del manifiesto, no editándolos a mano.

### Registro de decisiones — CERRADO Y FIRMADO (2026-08-01)

Las 7 decisiones quedaron resueltas por el operador el 2026-08-01. Cinco se decidieron una por una
en sesión; las otras dos (#3 y #4) las fijaron directamente las verificaciones de T1.

| # | Decisión | Resolución | Estado |
|---|---|---|---|
| 1 | Modelo de identidad | **La identidad va en la configuración del cliente.** Cabeceras `X-APTS-Project-Url`, `-Agent-Name`, `-Agent-Email` en el bloque de registro; lo que traiga la llamada gana a la cabecera; si faltan las dos, error claro. `task_id` y `branch` se escriben en la llamada. **Replantea el registro: las otras dos opciones se descartaron con evidencia.** | ✅ firmada |
| 2 | Estado de sesión | **Sin estado.** Ni `Mcp-Session-Id` ni sesión; `GET /mcp` → 405. Es viable porque la identidad viaja en cada petición. | ✅ firmada |
| 3 | Ejecución dentro del proceso | **Invocación directa de las funciones de negocio.** Confirmado viable: **18 de 21 operaciones ya son ruta delgada**; las 3 con lógica incrustada son de solo lectura. La ruta `/mcp` vive en `index.js`, así que tiene a mano las 11 funciones de ámbito de módulo sin extraer nada. El salto HTTP interno se mantiene **solo en F6-1**, como manda el PLAN. | ✅ firmada |
| 4 | Igualdad de validación | **Se endurece el servidor**, no se relaja el cliente. De los 6 huecos se cierran los **5 que guardan datos**, ampliando los esquemas ya existentes y añadiendo la comprobación de `track`, `phase` y `spec_artifact.content` en la ruta de `create_initiative`; así lo heredan **las dos superficies**. `heartbeat` queda como **diferencia aceptada y declarada** (el servidor descarta esos campos, `index.js:3058`): se registra como tal en la tabla de comparación de F6-2, no se disimula. | ✅ firmada |
| 5 | Autenticación | **Clave de acceso fija**, `authenticateAgent` reutilizado sin cambios, aplicado **antes** de interpretar el mensaje. OAuth 2.1 fuera de esta versión, no bloqueado. | ✅ firmada |
| 6 | Ruta y límites | Ruta **`/mcp`**. **Tope global de peticiones a 600 por minuto** (un solo contador; costo asumido: agente y panel comparten cuota). **Tamaño de mensaje a 4 MB solo en `/mcp`**, dejando el resto en 100 kb. | ✅ firmada |
| 7 | Destino de los archivos descargables | **Convivencia**: los 4 se marcan obsoletos y **se siguen sirviendo**. `contract-check` pasa además a prueba interna sin dejar de publicarse. **El recorte de la prosa del manifiesto queda fuera de F6.** | ✅ firmada |

**Añadido a F6 fuera del registro original**, decidido en la misma sesión:

| Tema | Resolución |
|---|---|
| Llamada externa que puede colgarse | **Se le pone un plazo de 10 segundos** a la llamada a OpenRouter (`semantic_embeddings.js:173`, hoy sin `AbortSignal`). Si vence, se abandona el cálculo del índice, la escritura se guarda igual y queda el aviso en el registro. Entra en F6. La solución de fondo —sacar el cálculo del pedido y ponerlo en una cola— queda como trabajo aparte. |

---

## F6-1 — Prueba del transporte Streamable HTTP sin estado

> **La ejecución sigue pasando por `apts-client.js` contra el propio servidor.** El salto HTTP
> interno se mantiene a propósito en esta fase, para aislar el *transporte* de la *ejecución*.
> Cambiarlo es F6-2.

- [x] **F6-1-T1** `dispatch()` devuelve el objeto respuesta (o `null` en las notificaciones) en vez
  de escribirlo en la salida estándar. El bucle de entrada/salida serializa lo que devuelve, así que
  el camino actual no cambia. Añadido además un **arranque condicional**: `main()` solo corre si el
  archivo se ejecuta directamente, para que el backend pueda importar el módulo sin que se ponga a
  leer la entrada estándar. Nuevos exportes: `dispatch`, `listTools`, `buildResult`, `buildError`,
  `buildToolErrorPayload`, `PROTOCOL_VERSION`, `SERVER_NAME`, `SERVER_VERSION`.
  - *Aceptación:* ✅ `initialize` + notificación + `tools/list` (21) + `ping` + `apts_status` real
    contra `APTS_test` por entrada/salida estándar; `contract-check` en verde con las 21 operaciones.
- [x] **F6-1-T2** `POST /mcp` + `GET /mcp` → 405 en `backend/index.js`. Sin estado, clave de acceso
  comprobada **antes** del cuerpo, `Origin` validado solo cuando viene, notificaciones → 202 vacío.
  Con lo decidido en F6-0: identidad resuelta (llamada → cabecera) e **inyectada antes** de invocar
  a `apts-client.js`, `express.json({ limit: '4mb' })` solo en `/mcp`, y `apiLimiter` a 600/min.
  - *Aceptación:* ✅ `node --check` en verde; cero dependencias nuevas; cero migraciones.
- [x] **F6-1-T3** Programa de prueba desechable hablando JSON-RPC sobre HTTP contra `APTS_test`, con
  la identidad **solo en cabeceras**: transporte, autenticación, `Origin`, tamaño de mensaje,
  resolución de identidad y un ciclo corto real (crear item → registrar tarea → latido → avance →
  cambio de estado → cuatro lecturas).
  - *Aceptación:* ✅ **27 de 27 comprobaciones en verde**; 21 operaciones listadas; `APTS_test`
    restaurado; programa de prueba borrado.
- [x] **F6-1-T4** **Informe sobre la identidad** → [Informe de identidad F6-1-T4](#informe-de-identidad-f6-1-t4).
  - *Aceptación:* ✅ (1) confirmado con **dos programas cliente reales**; ✅ (3) **cero fugas**;
    ⏸️ (2) aplazado a F6-4 por decisión del operador, con el motivo escrito en el informe.
- [x] **F6-1-GATE** ✅ **Firmado por el operador el 2026-08-01.** Transporte funcionando e informe de
  identidad entregado. La cabecera **sí llega** desde Claude Code y desde opencode, así que la
  decisión #1 **no se replantea**. Queda verificado y no se reabre: transporte MCP sobre HTTP sin
  estado en `POST /mcp`; cabecera de identidad confirmada desde dos programas cliente reales; cero
  identidad del servidor filtrada a `APTS_test`.

### Informe de identidad F6-1-T4

> Medido el 2026-08-01 contra `APTS_test` (`environment:test`, puerto 47301).

**(1) ¿Llega la cabecera de verdad desde el programa cliente? — Sí, en los dos que existen hoy.**

No basta con el programa de prueba propio: demuestra que el servidor *lee* la cabecera, no que un
cliente real la *envíe*. Así que se registró el servidor en dos programas cliente reales, cada uno
con su propio formato de bloque de registro y su propio `project_url`, y se les pidió llamar a
`apts_status` **sin argumentos**. Si la cabecera no llegara, la llamada se habría rechazado con
`MISSING_IDENTITY`.

| Programa cliente | Versión | Formato del registro | Resultado |
|---|---|---|---|
| Claude Code | 2.1.220 | `.mcp.json`, `"type": "http"` + `headers` | ✅ devolvió `apts://f61/cliente-claude` |
| opencode | 1.18.10 | `opencode.json`, `"type": "remote"` + `headers` | ✅ devolvió `apts://f61/cliente-opencode` |

Evidencia del lado del servidor: las **tres** cabeceras de identidad llegaron en **todas** las
peticiones de ambos clientes, incluido el `initialize`, que además identifica al programa.

```
{"method":"initialize","client":"claude-code","identity_headers":["project_url","agent_name","agent_email"]}
{"method":"tools/call","client":null,   "identity_headers":["project_url","agent_name","agent_email"]}
{"method":"initialize","client":"opencode",  "identity_headers":["project_url","agent_name","agent_email"]}
{"method":"tools/call","client":null,   "identity_headers":["project_url","agent_name","agent_email"]}
```

**La decisión #1 queda confirmada empíricamente y no se replantea.** Queda fuera de esta medición
`vscode`, el tercer programa que declara el manifiesto: se comprueba en F6-3, que es donde se
publica su bloque de registro.

**(2) Errores del agente con `task_id` — aplazado a F6-4, por decisión del operador.**

Motivo: el programa de prueba es determinista y no se equivoca nunca, así que medir sobre él daría
un cero sin valor. Y el riesgo ya está cerrado por construcción: con el rechazo total, un `task_id`
ausente da error claro (`MISSING_IDENTITY`) y **no hay fallo silencioso posible**, que era lo que
importaba. El contador ya queda registrado en el log del servidor (`mcp_identity.missing`), así que
el número real sale solo del ciclo largo conducido por un agente, que es F6-4. Si allí resulta alto,
la salida de emergencia de la decisión #1 —deducir `task_id` en el servidor— sigue disponible.

**(3) ¿Se dispara alguna vez la resolución automática del cliente? — No. Cero fugas.**

Es el criterio de bloqueo, y se atacó por tres vías a la vez:

- **Rechazo total.** `/mcp` exige que **todos** los campos que `apts-client.js` autorellenaría vengan
  ya puestos —de la llamada primero, de la cabecera después— y rechaza si falta alguno. Como el
  cliente solo resuelve campos vacíos (`hasNonEmptyString`, `apts-client.js:719`), nunca llega a
  actuar. Alcanza también a `task_id` y `branch`, que no tienen cabecera.
- **Archivo de contexto fuera del repositorio.** `APTS_CONTEXT_FILE` se apunta a `TEMP`, así que el
  cliente no escribe `.apts/execution-context.json` en el árbol de APTS.
- **Comprobación en la base de datos.** Ninguna fila escrita por el camino remoto lleva identidad del
  servidor.

| Medición | Número |
|---|---|
| `tools/call` registradas | 31 |
| Campos de identidad resueltos **por cabecera** | 39 |
| Campos de identidad resueltos **por la llamada** (ganan a la cabecera) | 12 |
| Rechazos por campo ausente | `project_url` 2 · `task_id` 2 · `branch` 2 |
| Identidad del servidor filtrada a `APTS_test` | **0** |

La identidad del servidor —lo que el cliente habría resuelto solo— es
`https://github.com/LITAT-AGC/agentic-tracker.git`, `Javier Ntaca`, `japedev@gmail.com`,
`feat/mcp-remoto`. **Ninguno de los cuatro valores aparece** en nada de lo escrito por el camino
remoto (`tasks`, `agent_logs`, `backlog_items` de la ventana de la prueba). El archivo de contexto
que quedó en `TEMP` contenía identidad **del cliente** (`f61-tester`, `feature/f61-cliente`), nunca
del servidor.

Las dos pruebas más duras son estas, y las dos pasan:

- Tras un `register_task` —que persiste el `task_id` en el archivo de contexto—, un `heartbeat`
  **sin** `task_id` se **rechaza**. Si la resolución automática actuara, habría cogido el
  identificador del archivo y habría dado un latido correcto contra la tarea equivocada.
- Un `log_agent_progress` **sin** `branch` se **rechaza**, en vez de grabar `feat/mcp-remoto`, que
  es la rama del servidor.

### Decisiones tomadas dentro de F6-1

Tres cosas que la decisión #1 no cubría y salieron al escribir el código:

| Tema | Resolución | Quién |
|---|---|---|
| **`branch` en `log_agent_progress`** | **Rechazar si falta.** En F6-1 el cliente la exige, y si no viene la saca de `git branch --show-current` **del servidor**. Coherente con "la rama se escribe en la llamada". En F6-2, sin cliente por medio, pasa a opcional de verdad. | Operador |
| **Archivo de contexto del cliente dentro del servidor** | **`APTS_CONTEXT_FILE` fuera del repositorio + rechazo total** de los campos de autorelleno, incluidos `task_id` y `branch`. Corta el canal por el que la identidad de un proyecto podría colarse en la llamada de otro. | Operador |
| **Cabecera `Accept`** | El PLAN §5 pedía exigir `application/json, text/event-stream`. Se implementó **más permisivo**: solo se rechaza (406) si `Accept` viene y excluye `application/json`. Exigir `text/event-stream` en una ruta que **nunca** emite eventos es el mismo falso positivo que ya se evita con `Origin`. **Resuelto al abrir F6-2: se queda permisiva**, como desviación declarada del PLAN §5. | Asistente → Operador |

---

## F6-2 — Ejecución dentro del proceso + igualdad de validación

### Decisiones tomadas al abrir F6-2 (2026-08-01)

| Tema | Resolución | Quién |
|---|---|---|
| **Cabecera `Accept`** (punto que quedó abierto en F6-1) | **Se queda permisiva**: solo se rechaza con 406 si `Accept` viene y excluye `application/json`. Exigir además `text/event-stream` en una ruta que nunca emite eventos es el mismo falso positivo que ya se evita con `Origin`. **Es una desviación consciente del PLAN §5 y queda declarada como tal**; si algún día `/mcp` emite eventos, se revisa. | Operador |
| **Forma de la ejecución en proceso (T1)** | **Híbrido**: se extrae solo lo que el inventario de F6-0-T1a marcaba como no reutilizable y lo comparten las dos superficies. Descartadas: el ejecutor paralelo que rehace la lógica de ruta por su cuenta (divergencia solo detectable por prueba) y la capa compartida completa que adelgaza las 21 rutas (toca todo el camino actual y el panel; más de lo que pide T1). | Operador |
| **Qué cuenta como "mismo resultado" (T5)** | **Mismo veredicto y misma causa.** Aciertos: cuerpo idéntico campo a campo. Rechazos: ambos rechazan, por el mismo campo y el mismo motivo. El envoltorio (código y texto) es idéntico **cuando ambos caminos rechazan en el servidor**, y puede diferir solo donde el camino actual rechaza en el cliente, que es una diferencia física: ahí la llamada nunca llega al servidor. La tabla de 21 filas anota en cuáles difiere y por qué. Descartado exigir envoltorio idéntico siempre: obligaría a trasladar al backend los textos literales y el código `INVALID_ARGUMENT` de un archivo que se está dejando obsoleto. | Operador |

- [x] **F6-2-T1** Sustituir el salto HTTP interno por llamada directa a las funciones de negocio
  (decisión #3, sobre el inventario de F6-0-T1a). Las 3 operaciones de solo lectura que hoy tienen
  la lógica dentro de la ruta hay que extraerlas; también el parseo de parámetros y la orquestación
  de lotes, que hoy viven en la ruta y no en la función.
  - **Forma elegida (operador):** *híbrido*. Se extrae solo lo que el inventario marcaba como no
    reutilizable, y **las rutas express y la superficie remota llaman a las mismas funciones**; las
    18 rutas finas no se tocan. `dispatch()` sigue recibiendo un objeto con las 21 funciones del
    contrato: antes era el módulo cliente, ahora es `mcpLocalExecutor`. **`apts-mcp.js` no se tocó.**
  - Extraído y compartido: `parseReadProjectContextOptions` + `readProjectContextInternal`,
    `parseListBacklogItemsOptions`, `parseGetBacklogItemOptions` + `getBacklogItemInternal`,
    `parseGetTaskOptions` + `getTaskInternal`, `searchSimilarBugReportsOperation`,
    `parseBatchItems`, `buildBatchOperationResponse`, `buildApiErrorPayload`.
  - **Andamio de F6-1 retirado:** fuera `APTS_BASE_URL`/`APTS_CONTEXT_FILE` forzados, fuera el
    `import()` de `apts-client.js` y fuera el `require('node:os')` que solo servía para eso.
  - **Igualdad de rechazos:** `buildMcpExecutionError` reconstruye el mismo error que armaba el
    cliente leyendo la respuesta HTTP (`apts-client.js:631`) — mismo `name`, `message`, `code`,
    `statusCode`, `retriable` y `details`. Sin eso, un mismo rechazo se vería distinto por cada
    camino aunque la causa fuera la misma.
  - **Tabla de identidad:** `AUTO_FILL_FIELDS_BY_OPERATION` vivía en el cliente; ahora es
    `MCP_IDENTITY_FIELDS_BY_OPERATION` en el backend, con `branch` fuera de
    `log_agent_progress` (decisión #1: pasa a opcional de verdad). Que no se separe de la del
    cliente mientras el archivo se siga publicando lo comprueba T3.
  - *Aceptación:* ✅ 18/18 comprobaciones del programa de humo (transporte, 21 operaciones, 7
    lecturas por identidad de cabecera, 7 rechazos). ✅ Camino actual intacto: las 4 rutas GET
    refactorizadas y las 7 rutas de lote devuelven el mismo cuerpo y el mismo texto de error que
    antes, incluido el formato `Invalid payload at index N:`. Sin escrituras en `APTS_test`.
- [x] **F6-2-T2** Endurecer la validación del lado del servidor (decisión #4): los **5 huecos que
  guardan datos** listados en F6-0-T1b, más `track`, `phase` y `spec_artifact.content` en
  `create_initiative`. `heartbeat` **no** se toca: queda como diferencia declarada.
  - Esquemas endurecidos (`backend/index.js`): `register_task` → `agent_name` y `agent_email`
    obligatorios; `update_task_status` → `project_url` y `agent_name` obligatorios y `agent_email`
    **añadido** al esquema (antes ni existía, así que se descartaba en silencio);
    `log_agent_progress` → `agent_name` obligatorio y **`branch` deliberadamente opcional**;
    `report_blocker` → `agent_name` obligatorio.
  - `create_initiative`: la validación pasa a `parseCreateInitiativeInput`, compartida por la ruta y
    la superficie remota, y añade `track` ∈ enum, `phase` ∈ enum y `spec_artifact.content` texto no
    vacío. Antes `phase:'banana'` llegaba a la base y salía como **500 con el detalle interno
    filtrado**, y un `content` no textual reventaba en `crypto.createHash()`.
  - **Dos cosas fuera de la lista de los 5, decididas por el operador al aparecer:**
    - **`top_k`** (era la 🟡 divergencia de F6-0-T1b): el esquema ya acota 1..20 y **se quitó el
      recorte de la ruta**, que quedaba muerto. Antes el cliente rechazaba `top_k:99` y el servidor
      lo recortaba a 20 en silencio: era la única diferencia de **veredicto** que quedaba fuera de
      las declaradas.
    - **Mensajes de error que no nombraban el campo.** Defecto previo: los 9 helpers de esquema
      usaban `invalid_type_error`, que zod 4 ignora (la clave es `error`), así que un campo ausente
      daba `Invalid input: expected string, received undefined`. Corregido en los 9, con función
      que distingue "falta el campo" de "el tipo es otro". Ningún veredicto cambia, solo el texto:
      ahora sale `Agent name is required`. Afecta a las dos superficies.
  - *Aceptación:* ✅ los 9 rechazos nuevos comprobados uno a uno contra `APTS_test`. ✅ **Camino
    actual intacto**: `scripts/test_agent_api_batch.js` (lotes, modo estricto con vuelta atrás,
    lecturas y regresiones de blocker/log/resume) y `scripts/test_agent_api.js` pasan enteros contra
    el servidor de pruebas.
- [x] **F6-2-T3** `contract-check` pasa a prueba interna del backend, sin dejar de publicarse como
  archivo descargable mientras dure la convivencia (decisión #7).
  - **Dónde corre:** en el arranque del backend, **antes de escuchar**, con el mismo criterio
    estricto que ya aplica `apts-mcp.js` (`checkRemoteMcpContract`, salida 3 y el servidor no
    levanta). No hace falta plomería nueva: un desvío solo lo puede introducir quien edita el
    código, y salta en el primer arranque.
  - **Qué comprueba**, tres cosas que no comprobaba nadie: (1) el ejecutor en proceso expone
    exactamente una función por operación del contrato, sin sobrantes; (2) la tabla de identidad no
    nombra operaciones inexistentes; (3) **esa tabla no se ha separado de la del cliente
    descargable**, salvo la diferencia declarada (`branch` fuera de `log_agent_progress`). La
    comparación (3) es tolerante a que el archivo del cliente desaparezca: está marcado para
    retirarse y su ausencia no debe tumbar el backend, así que se registra un aviso y se salta.
  - *Aceptación:* ✅ arranque en verde, `operations: 21`. ✅ **Prueba negativa**: al añadir una
    función de más al ejecutor, aborta con `mcp_local_executor / unexpected`; al quitar
    `agent_email` de la tabla de identidad, aborta con `mcp_identity_table_vs_client / drifted`.
    En los dos casos el servidor **no llega a escuchar**. `index.js` restaurado tras cada prueba.
- [x] **F6-2-T4** Ponerle **plazo de espera de 10 segundos** a la llamada a OpenRouter
  (`semantic_embeddings.js:173`, hoy sin `AbortSignal`). Si vence, se abandona el cálculo del índice
  y la escritura se guarda igual, con el aviso en el registro.
  - *Aceptación:* una escritura de backlog termina bien aunque la llamada externa no responda.
  - ⚠️ **El inventario de F6-0 se quedó corto y hubo que replantear el alcance.** La llamada de
    `semantic_embeddings.js` no era la única sin plazo alcanzable desde las 21 operaciones:
    - **`index.js:1456`** es una **segunda implementación del embedding**, duplicada de la de
      `scripts/lib/`, y es la que alcanzan `search_similar_bug_reports` —la única operación donde el
      cliente espera de verdad por una llamada externa— y el embedding de bug de
      `create_backlog_item` / `update_backlog_item`. Era la más expuesta de las dos.
    - **`index.js:2721`**, `notifyWebhook`, hacía `await fetch(webhook_url)` sin plazo dentro del
      camino de escritura de `update_task_status`: un webhook del cliente que no responde colgaba
      la operación.
    - `index.js:1369` (modelos) y `:1769` (chat) son rutas del panel, fuera de las 21: **no se
      tocan**, y quedan anotadas como deuda.
  - **Resuelto por el operador: plazo en todo lo alcanzable desde las 21.** Embeddings 10 s
    (`OPENROUTER_EMBEDDING_TIMEOUT_MS`), webhook 5 s (`WEBHOOK_DELIVERY_TIMEOUT_MS`), los dos
    configurables. Unificar las dos copias del embedding queda como trabajo aparte.
  - *Comprobado* con un servidor de pruebas con los plazos en 1 ms y 1,5 s, y un webhook que acepta
    la conexión y nunca responde: `create_backlog_item` de un bug → **201 en 119 ms**, la escritura
    se guarda y el índice se abandona; `search_similar_bug_reports` → **503 limpio en 10 ms** con
    `SEMANTIC_BUG_SEARCH_UNAVAILABLE` en vez de quedarse esperando; `update_task_status` con el
    webhook mudo → **200 en 1573 ms**, o sea corta en el plazo en vez de colgarse.
- [x] **F6-2-T5** **Prueba de igualdad**: para las 21 operaciones, la misma llamada da el mismo
  resultado por el camino actual y por el remoto, **incluidos los rechazos**.
  - *Aceptación:* tabla de 21 filas con el veredicto de cada una. Cualquier diferencia es un
    bloqueo, salvo la de `heartbeat`, que ya está declarada de antemano.
  - → [Tabla de igualdad F6-2-T5](#tabla-de-igualdad-f6-2-t5). **21 de 21 en verde, cero bloqueos.**
- [x] **F6-2-GATE** ✅ **Firmado por el operador el 2026-08-01.** Igualdad demostrada (21/21, cero
  bloqueos); auto-chequeo de contrato en verde con prueba negativa; el camino actual intacto (las dos
  suites de regresión del repo pasan enteras); `APTS_test` restaurado a `2 / 2 / 361 / 263`.
  Queda verificado y **no se reabre**: el camino remoto ya no da el salto HTTP interno ni pasa por
  `apts-client.js`; la igualdad está demostrada en las 21 operaciones, incluidos los rechazos y el
  modo lote; el camino actual por entrada/salida estándar no cambió ni una línea.
  **Deuda escrita que NO es de F6-3:** las dos llamadas a OpenRouter del panel sin plazo de espera
  (`index.js:1369` modelos, `:1769` chat) y las dos implementaciones duplicadas del embedding.

### Tabla de igualdad F6-2-T5

> Medida el 2026-08-01 contra `APTS_test` (`environment:test`, puerto 47301). Cada camino corre la
> **misma secuencia** contra **su propio proyecto**, y se comparan las respuestas tras neutralizar lo
> que por fuerza cambia entre dos ejecuciones: identificadores, marcas de tiempo, contadores
> autoincrementales y el nombre del proyecto.
>
> - **Camino actual**: `apts-mcp.js` como proceso aparte, por entrada/salida estándar → `apts-client.js`
>   → HTTP → backend. Identidad resuelta por el cliente desde el entorno, como en producción.
> - **Camino remoto**: `POST /mcp` con la identidad **solo en cabeceras** → ejecución en proceso.
>
> `tools/list` devuelve **las mismas 21 operaciones** por los dos caminos.

Leyenda de las celdas:
- **idéntico** — cuerpo igual campo a campo.
- **envoltorio** — los dos rechazan, por el mismo campo y el mismo motivo, pero el texto y el código
  difieren porque **el camino actual rechaza en el cliente** (`statusCode: null`: la llamada nunca
  llega al servidor). Aceptado por el criterio firmado.
- **—** — la operación no admite modo lote, o el caso no aplica.

| # | Operación | Éxito | Rechazo | Lote | Rechazo en lote | Veredicto |
|---|---|---|---|---|---|---|
| 1 | `create_initiative` | idéntico | envoltorio | — | — | ✅ |
| 2 | `set_agent_role` | idéntico | envoltorio | — | — | ✅ |
| 3 | `apts_status` | idéntico | idéntico | — | — | ✅ |
| 4 | `apts_next` | idéntico | idéntico | — | — | ✅ |
| 5 | `apts_workflow_step` | idéntico | envoltorio | — | — | ✅ |
| 6 | `apts_submit_step` | idéntico | envoltorio | — | — | ✅ |
| 7 | `create_backlog_item` | idéntico | envoltorio | idéntico | envoltorio | ✅ |
| 8 | `list_backlog_items` | idéntico | envoltorio | — | — | ✅ |
| 9 | `get_backlog_item` | idéntico | envoltorio | — | — | ✅ |
| 10 | `update_backlog_item` | idéntico | envoltorio | idéntico | — | ✅ |
| 11 | `apts_set_status` | idéntico | envoltorio | — | — | ✅ |
| 12 | `search_similar_bug_reports` | idéntico | envoltorio | — | — | ✅ |
| 13 | `register_task` | idéntico | idéntico | idéntico | idéntico | ✅ |
| 14 | `heartbeat` | idéntico | idéntico | idéntico | — | ✅ |
| 15 | `log_agent_progress` | idéntico | envoltorio | idéntico | — | ✅ |
| 16 | `update_task_status` | idéntico | envoltorio | idéntico | envoltorio | ✅ |
| 17 | `get_task` | idéntico | idéntico | — | — | ✅ |
| 18 | `read_project_context` | idéntico | envoltorio | — | — | ✅ |
| 19 | `get_project_constraints` | idéntico | idéntico | — | — | ✅ |
| 20 | `report_blocker` | idéntico | envoltorio | idéntico | — | ✅ |
| 21 | `delete_backlog_item` | idéntico | envoltorio | idéntico | envoltorio | ✅ |

**Los 21 casos de éxito son idénticos campo a campo. Cero bloqueos.** Seis rechazos coinciden también
en el envoltorio, porque en esas seis operaciones ya rechazaba el servidor por los dos caminos.

**Lo que la prueba encontró y hubo que corregir.** Sin ella no se habrían visto:

1. **`apts_set_status` devolvía un envoltorio distinto.** Esa ruta tiene un atajo propio: cuando el
   error trae `statusCode` numérico responde `{ error, error_code }` **sin pasar por `sendApiError`**,
   o sea sin `code`. El ejecutor añadía `code` de más. Corregido con un mapeo de error propio para
   esa operación.
2. **`create_backlog_item` en lote escribía a medias.** Era la única de las siete operaciones de
   lote que validaba **dentro** del bucle, es decir después de haber escrito los elementos
   anteriores: un lote con un elemento malo dejaba escritos los buenos y devolvía un resultado
   parcial, mientras el camino actual rechazaba el lote entero. **Es un fallo previo de la ruta
   HTTP**, no algo que introdujera F6-2; lo que cambió es que la superficie MCP llega ahí sin el
   filtro previo del cliente. Resuelto por el operador: **validar por adelantado en la ruta y en el
   ejecutor**, como ya hacían las otras seis. Descartado declararlo como diferencia (escribe datos,
   no solo texto) y descartado arreglarlo solo en el ejecutor (reintroduce la divergencia que el
   diseño híbrido evita).

**Los 15 rechazos con envoltorio distinto**, todos con la misma forma: el camino actual da
`INVALID_ARGUMENT` con el texto del cliente y `statusCode: null`; el remoto da `400 BAD_REQUEST` con
el texto del servidor. Mismo campo, mismo motivo:

| Operación | Caso | Texto por el camino actual | Texto por el remoto |
|---|---|---|---|
| `create_initiative` | `phase` fuera del enum | `create_initiative has invalid 'phase' value` | `phase must be one of: analysis, planning, solutioning, implementation, done` |
| `set_agent_role` | sin `entity_key` | `set_agent_role requires non-empty string field 'entity_key'` | `entity_key is required` |
| `apts_workflow_step` | `answers` no es objeto | `apts_workflow_step 'answers' must be an object` | `answers must be an object` |
| `apts_submit_step` | `output` no es objeto | `apts_submit_step 'output' must be an object` | `output must be an object` |
| `create_backlog_item` | `item_type` fuera del enum | `create_backlog_item has invalid 'item_type' value` | `Invalid backlog item type` |
| `create_backlog_item` | lote con elemento inválido | `create_backlog_item has invalid 'item_type' value` | `Invalid payload at index 1: Invalid backlog item type` |
| `list_backlog_items` | `status` inexistente | `list_backlog_items has invalid 'status' value` | `Invalid backlog status` |
| `get_backlog_item` | identificador no uuid | `get_backlog_item expects 'backlog_item_id' to be a valid UUID` | `Backlog item id must be a valid UUID` |
| `update_backlog_item` | sin ningún campo que actualizar | `update_backlog_item requires at least one field to update` | `No backlog fields to update` |
| `apts_set_status` | estado fuera del enum | `apts_set_status has invalid 'status' value` | `status must be one of: ready_for_dev, in_progress, review, done` |
| `search_similar_bug_reports` | `top_k` fuera de rango | `search_similar_bug_reports expects 'top_k' between 1 and 20` | `top_k must be an integer between 1 and 20` |
| `log_agent_progress` | sin `message` | `log_agent_progress requires non-empty string field 'message'` | `Message is required` |
| `update_task_status` | estado fuera del enum | `update_task_status has invalid 'status' value` | `Invalid task status` |
| `update_task_status` | lote, estado inválido en el índice 1 | `update_task_status has invalid 'status' value` | `Invalid payload at index 1: Invalid task status` |
| `read_project_context` | `view` inexistente | `read_project_context has invalid 'view' value` | `Invalid view. Supported values: full, compact` |
| `report_blocker` | sin `error_message` | `report_blocker requires non-empty string field 'error_message'` | `Invalid payload at index 0: Error message is required` |
| `delete_backlog_item` | identificador no uuid | `delete_backlog_item expects 'backlog_item_id' to be a valid UUID` | `Backlog item id must be a valid UUID` |

**Diferencias declaradas de antemano**, medidas explícitamente:

| Operación | Diferencia | Medido |
|---|---|---|
| `log_agent_progress` sin `branch` | La decisión #1 la hace opcional de verdad en el camino remoto. | Los dos **aceptan**. El camino actual graba `branch: "feature/f62"`, resuelto por el cliente desde el entorno; el remoto graba `branch: null`. Se pierde un dato de rastro, no de integridad: es lo que la decisión #1 asumía. |
| `heartbeat` | El servidor descarta `agent_name` y `project_url` (`heartbeatInternal`). | **No es observable en la respuesta**: los dos caminos devuelven exactamente `{success:true, task_id}`. La diferencia es que esos campos no se guardan, y no se guardaban ya por ninguno de los dos caminos. |

---

## F6-3 — Registro remoto en el manifiesto

### Comprobación bloqueante: ¿envía `vscode` las cabeceras? — ✅ SÍ (2026-08-01)

F6-1 midió Claude Code y opencode y aplazó `vscode` a esta fase a propósito. Medido con VS Code
1.131.0, un espacio de trabajo desechable fuera del repositorio y `.vscode/mcp.json`
(`"type": "http"` + `headers`) apuntando al servidor de pruebas:

| Mensaje | Cliente declarado | Cabeceras de identidad recibidas |
|---|---|---|
| `initialize` | `Visual Studio Code` | `project_url`, `agent_name`, `agent_email` |
| `tools/list` | — | las tres |
| `notifications/initialized` | — | las tres |
| `tools/call` (`apts_status`) | — | las tres, `project_url` resuelto **por cabecera** |

**La decisión #1 no se replantea para ningún runtime: los tres envían las tres cabeceras.**

Dos hallazgos del mismo paso, que importan para T1:

1. **Hoy el generador no emite ningún registro MCP para `vscode`**, ni siquiera local: `emitVscode`
   (`generate-adapters.js:205`) solo escribe agentes y `copilot-instructions.md`. Para `vscode` el
   bloque de registro no es una migración de local a remoto: es **superficie nueva**.
2. **VS Code prueba `GET /mcp` antes de hablar**, recibe el `405` y **sigue adelante** por `POST`
   sin romperse. El 405 de la decisión #2 queda validado contra un cliente real.

### Decisiones tomadas al abrir F6-3 (2026-08-01)

| Tema | Resolución | Quién |
|---|---|---|
| **Cómo se publica la dirección del endpoint** | **Campo nuevo `mcp_endpoint`, hermano de `api_base_url`, con la URL derivada del host de la petición** (opción A1). La ruta `/mcp` vive fuera del árbol `/api` y no puede componerse a partir de `api_base_url`, así que se publica como dato y no como regla de aritmética de cadenas. Descartadas: publicar solo la regla (es prosa, justo lo que la fase evita, y se rompe si el backend se monta bajo un prefijo) y mover la ruta a `/api/mcp` (reabre la decisión #6 y toca la selección del analizador de 4 MB y la exclusión del panel, que comparan `req.path === '/mcp'`). | Operador |
| **Qué dice la prosa gestionada para los dos caminos** | **Una sola prosa, neutra respecto del origen de la identidad** (opción B1): dice que la pone la capa de integración y que no se resuelve a mano, sin decir de dónde la saca. Descartadas: dos bloques condicionados en el mismo archivo (el agente lee las dos ramas y no siempre puede saber en cuál está) y ramificar el generador por modo (obliga a decidir qué juego de adaptadores se materializa en el repositorio). Motivo de peso: la prosa gestionada es lo que más caro sale en tokens, y ramificarla la infla sin que el agente gane nada. | Operador |
| **Qué NO se publica en `mcp_endpoint`** | **La tabla `MCP_IDENTITY_FIELDS_BY_OPERATION` no se publica.** Son 16 entradas, ~450 unidades de texto, y no aporta nada accionable: con las cabeceras puestas todo se resuelve, y si falta algo el servidor ya responde nombrando el campo. Se publica solo lo que el cliente necesita: las tres cabeceras, la regla de precedencia y los dos campos que van en la llamada (`task_id`, `branch`). | Asistente |
| **Sustitución de valores en el bloque de `vscode`** | La clave de acceso se pide una vez con `inputs[]` (`${input:apts-api-key}`, `password: true`) y la guarda el editor; los tres valores de identidad, que no son secretos y son estables por proyecto, van como marcadores a sustituir. Se eligió así porque `inputs[]` es el mecanismo nativo y documentado de VS Code para secretos, mientras que la expansión de variables de entorno **no está verificada** en ese runtime. En Claude Code (`${VAR}`) y opencode (`{env:VAR}`) sí se usa la sintaxis nativa. **Verificado en el gate: la expansión `${VAR}` funciona en Claude Code.** | Asistente |

- [x] **F6-3-T1** El manifiesto publica el bloque de registro remoto por programa cliente **como
  dato** (Claude Code / opencode / vscode), no como prosa en `instructions[]`. **Debe incluir las
  cabeceras de identidad** de la decisión #1, no solo la de la clave de acceso.
  - Campo nuevo `mcp_endpoint` (`backend/index.js`), hermano de `api_base_url`: URL derivada del
    host, transporte, versión de protocolo, modo sin estado, comportamiento de `POST` y `GET`,
    tamaño máximo de mensaje, las **cuatro** cabeceras con su variable de entorno, la regla de
    precedencia (la llamada gana a la cabecera; si faltan las dos, rechazo nombrando el campo), los
    dos campos que viajan en la llamada y `registration_by_runtime` con los tres bloques listos.
  - *Aceptación:* ✅ los tres bloques se publican con las tres cabeceras de identidad más la de la
    clave. ✅ Nada de esto entra en `instructions[]`. **Coste medido: 785 unidades de texto**
    (3.141 bytes) sobre un manifiesto que pasa de ~10.250 a ~11.035.
- [x] **F6-3-T2** Los archivos `mcp_server` / `js_client` / `contract_check` / `package_manifest`
  quedan marcados como obsoletos pero se siguen sirviendo (decisión #7).
  - Campos nuevos por artefacto: `deprecated`, `deprecated_in_schema_version`, `deprecation_reason`,
    `replaced_by: mcp_endpoint`, `still_served`.
  - **`recommended` se deja intacto a propósito**, incluido el `recommended: true` de `mcp_server`.
    Bajarlo dejaría a un cliente en 3.1.0 —que no conoce `mcp_endpoint`— sin ninguna superficie que
    instalar: eso rompería la convivencia, que es restricción dura del PLAN §2.
  - *Aceptación:* ✅ los 4 responden `200` en su ruta de descarga; siguen siendo 13 artefactos.
- [x] **F6-3-T3** Subir `integrationManifestSchemaVersion` de 3.1.0 a 3.2.0, con la nota añadida al
  final del histórico, sin reescribir las anteriores.
  - *Aceptación:* ✅ nota añadida al final; las de 3.0.0 y 3.1.0 no se tocaron.
- [x] **F6-3-T4** Regenerar la prosa gestionada de los adaptadores: **la regla 9 de
  `runtime-adapters/claude/CLAUDE.md` era falsa para el cliente remoto** ("let autofill resolve
  them"), porque ahí no hay resolución automática local. Se regeneró desde la spec, sin editar a
  mano ningún archivo generado.
  - Editado `runtime-adapters/spec/apts-surface.json` y ejecutado `scripts/generate-adapters.js`
    (28 archivos, idempotente comprobado por huella antes y después).
  - **La regla 9 no era el único sitio que mentía.** El mismo repaso encontró la misma afirmación en
    la sección "Identity autofill", en el bloque de credenciales, en tres cuerpos de agente y en dos
    comandos: todos decían que la identidad se resuelve sola desde el entorno, el archivo de contexto
    o Git. La peor era la del agente ejecutor, que mandaba **inspeccionar
    `.apts/execution-context.json`** cuando una llamada fallara: por el camino remoto ese archivo no
    existe. Todas reescritas en términos neutros (B1).
  - `mcp.command` / `argsRelative` de la spec **no se tocaron**: el registro local que emite el
    generador sigue siendo el mismo, y el camino actual no cambia.
  - *Aceptación:* ✅ cero apariciones de `autofill`, `auto-fill`, `execution-context.json`,
    `git config user`, `git remote get-url` o `git branch --show-current` en los tres adaptadores.
- [x] **F6-3-GATE** ✅ **Firmado por el operador el 2026-08-01.** Evidencia en
  [Evidencia del gate F6-3](#evidencia-del-gate-f6-3). Queda verificado y **no se reabre**: un
  cliente registra el servidor leyendo solo el manifiesto, con cero descargas; el bump a 3.2.0 es
  aditivo comprobado contra el manifiesto de `HEAD`; los tres programas cliente envían las tres
  cabeceras de identidad; el camino actual por entrada/salida estándar sigue intacto. **F6-4
  queda habilitada.**

### Evidencia del gate F6-3

> Medida el 2026-08-01 contra `APTS_test` (`environment:test`, puerto 47301).

**(1) Un cliente registra el servidor leyendo solo el manifiesto, con cero descargas.**

Un programa desechable pide `GET /api/public/integrar`, saca
`mcp_endpoint.registration_by_runtime.claudecode.config` y lo escribe **tal cual** como `.mcp.json`
en una carpeta vacía fuera del repositorio. Ningún artefacto descargado. Después, Claude Code real
arranca contra ese archivo y llama a `apts_status` sin argumentos:

```json
{"ok":true,"data":{"project_url":"apts://f63/cliente-claude","initiative":null,…,
 "recommendation":{"next":"blocked","why":"sin iniciativa activa en apts://f63/cliente-claude"}}}
```

Del lado del servidor: `client: "claude-code"`, las tres cabeceras presentes y
`sources: { project_url: "header" }`, `missing: []`. Queda verificado de paso que **Claude Code
expande `${VAR}`** dentro del archivo de registro: en el archivo escrito no hay ningún valor
literal, solo `${APTS_API_KEY}`, `${APTS_PROJECT_URL}`, `${APTS_AGENT_NAME}` y `${APTS_AGENT_EMAIL}`.

**(2) El manifiesto sigue valiendo para un cliente en 3.1.0 — comprobado, no supuesto.**

Se levantó el backend de `HEAD` (que publica 3.1.0), se capturó su manifiesto y se comparó contra el
de 3.2.0 recorriendo el árbol de claves entero:

| Medición | Número |
|---|---|
| Claves que desaparecen | **0** |
| Valores o tipos que cambian (fuera de los dos de versión) | **0** |
| Claves añadidas | 66 (`mcp_endpoint` + 5 campos × 13 artefactos) |
| Artefactos publicados | 13 → 13 |

**Veredicto: aditivo.** Un cliente en 3.1.0 ignora los campos nuevos y encuentra intacto todo lo que
ya leía, incluidos los `recommended` y las rutas de descarga de los cuatro artefactos obsoletos.

**(3) El camino actual por entrada/salida estándar, intacto.** `apts-mcp.js` y `apts-client.js` no
se tocaron en esta fase. Humo por entrada/salida estándar contra `APTS_test`, solo lecturas:
**5 de 5 en verde** — `initialize` con protocolo `2025-06-18`, `tools/list` con **21** operaciones,
`apts_status` respondiendo, identidad resuelta por el cliente desde el entorno y la notificación sin
respuesta. El auto-chequeo de contrato del arranque (F6-2-T3) sigue en verde.

**(4) `APTS_test` sin tocar.** `initiatives:2`, `epics:2`, `backlog_items:361`, `tasks:263`, cero
restos de `apts://f63/%`. Todas las operaciones de la fase fueron de solo lectura.

---

## F6-4 — Validación end-to-end desde cliente fresco

### Decisiones tomadas al abrir F6-4 (2026-08-01)

| Tema | Resolución | Quién |
|---|---|---|
| **Especificación del cliente desechable** | **Paridad con F5-4: 1 epic, 2 historias**, spec de ~1 página. Recorre las 4 fases y la `dev-story` iterable dos veces. Estimación: ~140 llamadas MCP. Motivo: los números salen comparables uno a uno con los de F5-4, así que cualquier desvío se atribuye al **transporte remoto** y no al tamaño del ciclo. Descartadas: 1 sola historia (se pierde la segunda pasada por `dev-story`, que en F5-4 fue donde apareció la reanudación idempotente) y 2 epics con 4 historias (coste ×3 sin ganar nada que mida esta fase). | Operador |
| **Hasta dónde llega la implementación de las historias** | **Bucle de tarea real, sin escribir código.** El ejecutor llama `register_task`, `heartbeat`, `log_agent_progress` y `update_task_status` de verdad contra `APTS_test`, y cierra cada historia con `code_ref` simbólico sin tocar archivos. **Motivo determinante:** las tres operaciones del ciclo del método (`apts_next`, `apts_workflow_step`, `apts_submit_step`) **no llevan `task_id`**; el identificador solo aparece en esas cuatro. Sin el bucle de tarea, el recuento de errores con `task_id` que F6-1 aplazó a esta fase saldría **cero por construcción**, igual que en F6-1 y por el mismo motivo. Descartado escribir código real: multiplica el coste y mete variabilidad de generación en una fase cuyo objetivo es el transporte; F5 ya demostró el motor. | Operador |
| **Qué programa cliente conduce el ciclo** | **Claude Code conduce el ciclo entero + opencode ejecuta un tramo.** Claude Code es el único probado de punta a punta contra el endpoint remoto y su bloque del manifiesto expande `${VAR}` tal cual. opencode se registra desde **su** bloque del manifiesto y ejecuta un tramo corto, para dejar evidencia de que **dos programas distintos comparten el mismo proyecto por la ruta remota**. Descartado añadir `vscode`: su bloque es superficie nueva de F6-3 y usa `inputs[]` con sustitución manual, lo que añade riesgo de arranque sin medir nada que F6-3 no dejara ya verificado. | Operador |

- [x] **F6-4-T1** Cliente desechable fuera del repositorio, con solo la especificación, registrado
  contra la ruta remota con **cero descargas del núcleo ejecutable**: el bloque de registro (clave de
  acceso **y cabeceras de identidad**) más la prosa de conducción, por la decisión de arriba.
  - **Hallazgo que obligó a replantear el criterio del gate.** El manifiesto **no publica la
    conducción del método**: `apts_next`, `apts_workflow_step` y `apts_submit_step` tienen **0
    menciones** en todo el manifiesto, y el bucle vive en el artefacto `method_orchestrator_agent`,
    que **no** está entre los 4 marcados obsoletos en F6-3 —esos son solo el núcleo ejecutable—. Lo
    que sí llega sin descargar nada es `tools/list`: **3.607 tokens** de descripciones que explican
    el bucle básico, pero no las tres formas finas que F5 tuvo que corregir a mano (cierre de
    `dev-story` vía `apts_submit_step`, `wait` bicéfalo, `ok:false`/`await_input`).
  - **Corrección del contrato, previa a conducir.** **16 de 21** descripciones de `tools/list`
    afirmaban que la identidad *"auto-resuelve desde el entorno / el contexto gestionado local / Git
    cuando se omite"*. Es la misma afirmación que F6-3 eliminó de los adaptadores, pero esta vivía en
    `apts_skills.json` —el contrato—, que F6-3 no tocó. Con las cabeceras puestas el efecto es
    benigno; el daño está en `task_id` y `branch`, que **no tienen cabecera**: un agente que se crea
    la frase los omite y se lleva un rechazo, contaminando la medición de T2. Reescritas las 16 en
    términos neutros (misma convención B1 que F6-3: *"the integration layer supplies…"*), con
    programa determinista que aborta si algún patrón no aparece el número exacto de veces.
    **Cero residuos.** Los adaptadores generados **no** repetían la frase, así que no hubo que
    regenerarlos.
  - *Aceptación:* ✅ **Cero artefactos del núcleo ejecutable descargados** (0 de 4), 1 sola descarga
    de prosa (`method_orchestrator_agent`, 11.316 bytes) y 2 peticiones HTTP en total. El `.mcp.json`
    y el `opencode.json` se escriben **tal cual** los publica `mcp_endpoint.registration_by_runtime`.
    ✅ **Claude Code 2.1.220 real** arrancó contra el endpoint remoto desde la carpeta del cliente y
    `apts_status` sin argumentos resolvió la identidad **por cabecera**
    (`project_url: apts://f64/cliente-remoto`). ✅ **Camino actual intacto:** 6/6 en el humo por
    entrada/salida estándar, incluida la comprobación de que ya no queda ninguna afirmación de
    resolución automática en las descripciones que ve `tools/list`. ✅ Auto-chequeo de contrato del
    arranque en verde (`operations: 21`) con el contrato reescrito.
- [ ] **F6-4-T2** Llevarlo de `analysis` a `phase=done` contra `APTS_test` por la ruta remota,
  cambiando de rol por el camino. Como la identidad de proyecto va en la cabecera, **el cambio de rol
  se hace mandando `agent_name` en la llamada**, que gana a la cabecera.
  - **Conducción por tramos** (decisión del operador), una invocación no interactiva de Claude Code
    2.1.220 por tramo, con contexto limpio en cada uno y reanudación por idempotencia del motor.
    Permisos limitados a `mcp__apts` y `Read`: **sin `Write` ni `Edit`**, que es lo que materializa
    el nivel de implementación elegido (bucle de tarea real, sin escribir código).
  - **Defecto previo encontrado y corregido en el tramo 1** (ver
    [Hallazgos de F6-4](#hallazgos-de-f6-4)): `set_agent_role` devolvía **500** ante un `entity_key`
    inexistente —error del llamante degradado a fallo de servidor, el mismo patrón que F6-2-T2 cerró
    en `create_initiative`— y **el roster no era descubrible** desde un cliente sin descargas.
    Corregido en `method_bootstrap.js`: rechazo **400 `UNKNOWN_ENTITY_KEY`** cuyo mensaje **enumera
    las claves válidas**. Lo heredan las dos superficies. Efecto medido: el agente falló una vez,
    leyó las claves del propio error y registró los 6 roles al segundo intento.
  - Avance por tramos (llamadas MCP y rechazos, según reporte del conductor):

    | Tramo | Fase | Resultado | Llamadas | Rechazos |
    |---|---|---|---|---|
    | 1 | arranque | iniciativa + epic + spec; roster 6/6; `apts_next` → `run_step` | 12 | 1 (`entity_key` inválido, corregido leyendo el error) |
    | 2 | `analysis` | `bmad-product-brief` (6 pasos) → artefacto `brief` | 16 | 0 |
    | 3 | `planning` | `bmad-prd` (6 pasos) → artefacto `prd` | 16 | 0 |
    | 4 | `solutioning` | `bmad-create-architecture` + `bmad-create-epics-and-stories` (**2 historias**) + `bmad-check-implementation-readiness` | 22 | 0 |
    | 5 | `implementation` (Claude Code) | `bmad-dev-story` 10/10 sobre «Anotar un riego» + bucle de tarea completo → historia y tarea `done` | 65 | 1 (transición inválida desde `blocked`) |
    | 6 | `implementation` (**opencode 1.18.10**) | `bmad-dev-story` 10/10 sobre «Registrar una planta», **reanudando** la tarea que había quedado huérfana → `phase=done` | 33 | 1 (transición ya consumida, no bloqueante) |

  - *Aceptación:* ✅ **`phase=done` alcanzado**, comprobado en la base y no solo en el reporte del
    agente: iniciativa en `done`, **2/2 historias `done`**, 2/2 tareas `done`, y 8 artefactos tipados
    (`spec`, `brief`, `prd`, `architecture`, `epics`, `readiness`, `sprint_plan`, `story_spec`).
    ✅ **Los dos programas cliente condujeron el mismo proyecto por la ruta remota**: 5 sesiones de
    Claude Code y 2 de opencode contra el mismo `project_url`. ✅ Cero descargas del núcleo
    ejecutable en todo el ciclo.

### Informe de identidad F6-4-T2

> Medido sobre el registro del servidor durante el ciclo completo, contra `APTS_test`
> (`environment:test`, puerto 47301). 176 llamadas con identidad resuelta.

| Medición | Número |
|---|---|
| Llamadas con identidad registrada | **176** |
| `project_url` resuelto **por cabecera** | 161 |
| `project_url` traído **por la llamada** | 6 |
| `agent_name` traído **por la llamada** (cambio de rol) | **145** |
| `agent_name` por cabecera | 0 |
| `agent_email` por cabecera | 10 |
| `task_id` traído por la llamada | 16 |
| **Errores del agente con `task_id`** | **0** |
| Rechazos por identidad ausente (`MISSING_IDENTITY`) | **0** |
| Rechazos 500 | **0** |
| Identidad del servidor filtrada a `APTS_test` | **0** |

**(1) El recuento de `task_id`, que F6-1 aplazó a esta fase: cero errores en 16 llamadas.** Las
cuatro operaciones que lo llevan (`register_task`, `heartbeat`, `log_agent_progress`,
`update_task_status`) se usaron 21 veces entre los dos programas cliente y **ninguna llegó sin
`task_id`**.

**Ese 0 hay que leerlo con lo que la prueba no cubrió.** El riesgo que F6-1 quería medir era que el
agente tuviera que **arrastrar** un identificador largo a lo largo de decenas de llamadas sin ningún
archivo local contra el que contrastarlo. Al conducir por tramos, eso no llegó a ocurrir: cada agente
hizo `register_task` y consumió el `task_id` **dentro del mismo tramo**, con el valor a pocos minutos
de vista en su propio contexto, sin ningún corte por medio. El caso que más se acercó fue el de
opencode, que retomó la tarea que Claude Code había dejado una hora antes: **no la recordó**, volvió
a llamar a `register_task` con el `backlog_item_id` y **el servidor le devolvió el `task_id`**, por la
regla de reanudación que ya existía (`register_task_resume_rule`, `index.js:2695`).

Lectura honesta: *cuando el `task_id` está en el contexto reciente, no se pierde*; y cuando se
pierde, hay una vía barata de recuperarlo **preguntando**, que no obliga al servidor a adivinar nada.
**Conclusión: la salida de emergencia de la decisión #1 —deducir `task_id` en el servidor— sigue sin
hacer falta**, pero por esa razón y no por el 0 pelado. **Queda sin medir** un agente conduciendo
horas seguidas sin cortes y sin volver a preguntar.

**(2) El cambio de rol del modelo A funciona, y a escala.** 145 de 145 resoluciones de `agent_name`
vinieron **de la llamada**, ninguna de la cabecera: con la identidad de proyecto fija en la cabecera,
mandar `agent_name` es la única forma de conmutar y es la que usaron los dos programas cliente.
Claude Code conmutó de rol 3 veces sólo en `solutioning` (architect → pm → architect).
**La decisión #1 no se replantea por este lado.**

**(3) Pero la otra mitad de la misma regla sí necesitó ajuste** — ver hallazgo 3 abajo.
### Hallazgos de F6-4

> Cuatro cosas que el diseño previo no había previsto. Las cuatro se replantearon con el operador
> antes de tocar nada, ninguna se improvisó. **Ninguna es del transporte remoto**: el endpoint hizo
> su trabajo las 176 veces.

**1. El manifiesto no publica la conducción del método.** `apts_next`, `apts_workflow_step` y
`apts_submit_step` tienen 0 menciones en el manifiesto; el bucle vive en `method_orchestrator_agent`,
artefacto descargable que **no** está entre los 4 marcados obsoletos en F6-3 (esos son sólo el núcleo
ejecutable). **Decisión del operador: el criterio del gate pasa de "cero descargas" literal a "cero
descargas del núcleo ejecutable"**, que es lo que el PLAN §1 prometía. El cliente descargó 1
artefacto de prosa (11.316 bytes) y 0 de los 4 ejecutables. Publicar el drive loop como dato queda
**fuera de F6**, anotado como trabajo aparte.

**2. El contrato afirmaba resolución automática de identidad en 16 de 21 descripciones.** Detalle y
corrección en F6-4-T1. Bump `skills_json` 3.0.0 → 3.3.0 y manifiesto 3.2.0 → 3.3.0 con nota al final
del histórico, para que la corrección llegue a los clientes ya integrados por la política de
sincronización que ya existe. **Comprobado aditivo**: 0 claves desaparecidas, 0 añadidas, 13 → 13
artefactos, y sólo los 4 valores de versión esperados cambian.

**3. Un cliente real pisó la identidad de proyecto con una ruta inventada.** opencode mandó
`project_url: "C:\Users\...\cliente-f64"` y luego `"C:\Users\jntac\Documents\prj\AGC-agentic-tracker"`
en `register_task`, sobrescribiendo la cabecera correcta. Las dos llamadas se rechazaron, pero por
una **defensa colateral** —el `backlog_item_id` no pertenecía a ese proyecto—, no por el modelo de
identidad: con `create_backlog_item`, que no tiene comprobación cruzada, habría escrito bajo un
`project_url` con forma de ruta de Windows. La regla "la llamada gana a la cabecera" existe para el
cambio de rol, que va por `agent_name`; aplicada a `project_url` abre esta puerta.
**Resuelto por el operador: si la llamada trae un `project_url` que contradice el de la cabecera, se
rechaza** con `IDENTITY_CONFLICT` nombrando los dos valores. `agent_name` **no** cambia: la llamada
sigue ganando, que es lo que sostiene el modelo A. Descartado ignorar el valor en silencio (es
justamente lo que la decisión #1 quiso evitar: nunca adivinar, nunca callar). Comprobado en los
cuatro casos: contradictorio → rechazo; coincidente → pasa; omitido → cabecera; `agent_name` en la
llamada → sigue conmutando.

**4. Una historia puede caer en `blocked` y quedarse sin salida visible.** Causa exacta, y es
comportamiento **documentado** del producto (`stale_heartbeat_rule`, `index.js:2698`): el agente
registró la tarea de una historia y estuvo un cuarto de hora trabajando en la otra sin mandarle
latido, así que la monitorización de fondo marcó la tarea `stalled` y la historia `blocked`. Desde
`blocked`, `apts_set_status` no tiene ninguna transición —la máquina del método es lineal hacia
adelante a propósito— y el agente **paró y pidió intervención del operador teniendo la salida a
mano**: `update_backlog_item` (edición libre) repone la historia sin problema, comprobado.
**Resuelto por el operador: el rechazo 409 dice dónde está la salida** cuando el estado no tiene
transiciones. No se toca la máquina de estados. Descartado añadir `blocked → ready_for_dev`: es
cambio de comportamiento del motor que F5 dio por cerrado, y más riesgo del que esta fase necesita.

> **Intervención manual declarada:** la historia bloqueada se repuso a `ready` con una llamada
> `update_backlog_item` hecha por el asistente como diagnóstico, antes de que existiera el mensaje
> corregido. Es la única llamada del ciclo que no hizo un programa cliente, y por eso aparece en el
> recuento de operaciones.

- [x] **F6-4-T3** Restaurar `APTS_test` a su estado de partida (`initiatives:2`, `epics:2`,
  `backlog_items:361`, `tasks:263`, sin restos — medido el 2026-08-01; el `358` que decía antes este
  documento era incorrecto); borrar el cliente desechable y los programas de prueba; apagar el
  servidor de pruebas.
  - **Camino actual comprobado antes de restaurar**, porque esta fase tocó tres archivos del backend:
    ✅ humo por entrada/salida estándar **6/6**; ✅ `scripts/test_agent_api.js` completo; ✅
    `scripts/test_agent_api_batch.js` completo (lotes, vuelta atrás estricta, lecturas dirigidas y
    regresiones de blocker/log/resume); ✅ auto-chequeo de contrato del arranque en verde.
  - *Aceptación:* ✅ `APTS_test` en **`2 / 2 / 361 / 263`**, cero restos de `apts://f64/%`. Se borró
    todo lo creado en la sesión, incluidos los residuos de las dos suites de regresión (proyectos
    `apts-batch-…` y `test-project`): 1 iniciativa, 1 epic, 7 items, 7 tareas, 6 punteros de roster,
    13 documentos y 16 registros de avance. ✅ Servidor de pruebas apagado.
  - **Los programas de comprobación y el cliente desechable quedan fuera del repositorio hasta la
    firma del gate**, igual que se hizo en F6-3, por si hay que repetir alguna medición. Son seis:
    montaje del cliente desde el manifiesto, reescritura del contrato, comparación de manifiestos,
    humo por entrada/salida estándar, conteo de la base y medición de identidad. **Se borran al
    firmar.**
- [ ] **F6-4-GATE** 🛑 Ciclo completo desde un cliente nuevo sin ningún archivo descargado; informe
  de cierre de F6 escrito en este documento. **Evidencia lista; espera firma del operador.**

---

## Informe de cierre F6 — MCP remoto

**Objetivo (PLAN §2):** que el backend exponga sus 21 operaciones como servidor MCP remoto sobre
HTTP, de modo que conectar un proyecto cliente sea registrar una URL con unas cabeceras. **Logrado.**

**Qué se entregó, fase por fase:**

- **F6-0** — Las 7 decisiones cerradas sobre el código, sin prueba de concepto y sin tocar la base.
  La #1 replanteó el registro entero: la identidad no viaja en la llamada ni en una sesión, sino en
  **la cabecera del registro**, que es donde ya viajaba la clave de acceso.
- **F6-1** — Transporte Streamable HTTP sin estado en `POST /mcp`, `GET /mcp` → 405. La cabecera de
  identidad **llega de verdad** desde programas cliente reales, y la resolución automática del
  cliente no se dispara nunca dentro del servidor: cero identidad del servidor filtrada.
- **F6-2** — Ejecución en proceso, sin salto HTTP interno ni `apts-client.js`. **Igualdad demostrada
  en las 21 operaciones**, incluidos los rechazos y el modo lote, con una sola diferencia declarada
  de antemano (`heartbeat`). De paso se cerraron 6 huecos de validación, la divergencia de `top_k`,
  un lote que escribía a medias y los plazos de espera de tres llamadas externas.
- **F6-3** — El manifiesto publica `mcp_endpoint` y el bloque de registro por programa cliente **como
  dato**. Bump aditivo 3.1.0 → 3.2.0 comprobado contra el manifiesto anterior. Los tres programas
  cliente envían las tres cabeceras.
- **F6-4** — **Un cliente nuevo, sin descargar ningún archivo ejecutable, condujo un proyecto de
  `analysis` a `phase=done`** contra `APTS_test` por la ruta remota.

**Lo que demuestra la validación de punta a punta:**

- **Ciclo completo, verificado en la base y no en el reporte del agente**: iniciativa en `done`,
  2/2 historias `done`, 2/2 tareas `done`, 8 artefactos tipados.
- **Cero descargas del núcleo ejecutable**: 0 de los 4 artefactos ejecutables, 2 peticiones HTTP de
  integración y 1 sola descarga de prosa. El `.mcp.json` y el `opencode.json` se escribieron **tal
  cual** los publica el manifiesto.
- **Dos programas cliente distintos condujeron el mismo proyecto** por la misma ruta remota, y el
  segundo **reanudó** trabajo que había dejado el primero.
- **176 llamadas** con identidad resuelta: 161 `project_url` por cabecera, **145 `agent_name` por la
  llamada** (el cambio de rol del modelo A, a escala), **0 rechazos por identidad ausente**, **0
  errores del agente con `task_id`** y **0 identidad del servidor filtrada**.
- **El camino actual sigue intacto**: `apts-mcp.js` y `apts-client.js` no se tocaron desde F6-1, el
  humo por entrada/salida estándar da 6/6 y las dos suites de regresión del repositorio pasan.

**Lo que F6 no hizo, y conviene tener a la vista:**

- **El recorte de la prosa del manifiesto queda fuera** (decisión #7). El manifiesto **creció**: de
  ~10.250 a ~11.035 unidades de texto por integración, por las 785 de `mcp_endpoint`.
- **Los 4 artefactos del núcleo ejecutable siguen sirviéndose** y `mcp_server` mantiene su
  `recommended: true`, a propósito: bajarlo dejaría sin superficie a los clientes en 3.1.0.
- **La conducción del método no se publica como dato.** Un cliente que no descargue nada tiene el
  transporte y las 21 operaciones, pero no el bucle de conducción; hoy sigue siendo un artefacto de
  prosa descargable. Es el hueco más claro que deja F6.

**Deuda escrita, que no es de F6:**

- Las dos llamadas a OpenRouter del panel sin plazo de espera (`index.js:1369` modelos, `:1769` chat).
- Las **dos implementaciones duplicadas del embedding** (`semantic_embeddings.js` e `index.js:1456`).
- El recorte de la prosa del manifiesto.
- Publicar el bucle de conducción del método como dato del manifiesto.
- Que el roster del método (`entity_key`) sea descubrible sin fallar primero: hoy sólo se aprende
  leyendo el rechazo.

**Estado del árbol:** todo F6 sigue **sin commitear** en `feat/mcp-remoto`, igual que el acarreo de
F5. `APTS_test` restaurado a `2 / 2 / 361 / 263`.

---

## Log de cambios

*(Entradas nuevas arriba. Anotar archivos tocados, migraciones, y estado de `APTS_test`.)*

- 2026-08-01 — **F6-4 completa (T1..T3); en GATE, esperando firma. Con ella se cierra F6.** Un cliente
  nuevo, sin ningún artefacto ejecutable descargado, condujo un proyecto de `analysis` a `phase=done`
  contra `APTS_test` por la ruta remota. **Sin dependencias nuevas, sin migraciones.**
  Archivos tocados:
  - `integracion/paquete-apts/apts_skills.json` — **16 descripciones reescritas** en términos
    neutros: ya no afirman que la identidad se resuelva sola desde el entorno, el contexto local o
    Git. Ninguna operación, esquema ni veredicto cambia; sólo texto.
  - `backend/index.js` — `skills_json.artifactVersion` 3.0.0 → 3.3.0 y
    `integrationManifestSchemaVersion` 3.2.0 → 3.3.0 con nota al final del histórico; **rechazo por
    contradicción de identidad** (`IDENTITY_CONFLICT`) en la resolución de `/mcp`, con `agent_name`
    deliberadamente exento para no romper el cambio de rol.
  - `backend/scripts/lib/method_bootstrap.js` — `set_agent_role` deja de degradar un error del
    llamante a **500**: rechaza con **400 `UNKNOWN_ENTITY_KEY`** y el mensaje **enumera las claves
    válidas** de la librería.
  - `backend/scripts/lib/method_resolver.js` — cuando un estado no tiene transiciones de método, el
    409 dice dónde está la salida (`update_backlog_item`), en vez de dejar al agente parado.
  - `integracion/TRACKING-mcp-remoto.md`, `integracion/PLAN-mcp-remoto.md`.
  - **`apts-mcp.js`, `apts-client.js` y los adaptadores generados no se tocaron.** El camino actual
    no cambió ni una línea, y la prosa gestionada de F6-3 no repetía la afirmación falsa, así que no
    hubo que regenerar nada.

  **Resultado:** `phase=done` verificado en la base (2/2 historias, 2/2 tareas, 8 artefactos
  tipados); **0 de 4 artefactos del núcleo ejecutable descargados**; **dos programas cliente
  distintos** (Claude Code 2.1.220 y opencode 1.18.10) condujeron el mismo proyecto por la ruta
  remota, y el segundo reanudó trabajo del primero. **176 llamadas** con identidad resuelta, **0
  errores del agente con `task_id`** —la medición que F6-1 aplazó a esta fase—, 0 rechazos por
  identidad ausente y 0 identidad del servidor filtrada.

  **Cuatro cosas que el diseño previo no había previsto y se replantearon con el operador** en vez de
  improvisarlas: que el manifiesto **no publica la conducción del método** (el criterio del gate pasa
  a "cero descargas del núcleo ejecutable"); que **el contrato afirmaba resolución automática** en 16
  de 21 descripciones; que un cliente real **pisó la identidad de proyecto con una ruta de disco
  inventada**; y que una historia puede caer en `blocked` **sin salida visible**. Las cuatro están
  documentadas en [Hallazgos de F6-4](#hallazgos-de-f6-4).

  **`APTS_test` restaurado** al estado de partida exacto: `initiatives:2`, `epics:2`,
  `backlog_items:361`, `tasks:263`, cero restos. Servidor de pruebas apagado. El cliente desechable y
  los seis programas de comprobación quedan **fuera del repositorio** hasta la firma del gate.

- 2026-08-01 — **F6-3 completa (T1..T4); en GATE, esperando firma.** El manifiesto publica el
  registro remoto como dato: un cliente puede registrar el servidor sin descargar ningún archivo.
  **Sin dependencias nuevas, sin migraciones, sin escrituras en `APTS_test`.**
  Archivos tocados:
  - `backend/index.js` — `mcp_endpoint` (constructor `buildMcpEndpoint` + `MCP_IDENTITY_HEADER_SPEC`
    + `buildMcpRuntimeRegistrations`), publicado junto a `api_base_url`; 4 artefactos marcados
    obsoletos con `recommended` intacto; 5 campos nuevos en el mapeo de `artifacts[]`;
    `integrationManifestSchemaVersion` 3.1.0 → 3.2.0 con nota al final del histórico.
  - `integracion/paquete-apts/runtime-adapters/spec/apts-surface.json` — prosa gestionada reescrita
    en términos neutros (opción B1): sección de identidad, regla 9, bloque de credenciales, tres
    cuerpos de agente y dos comandos.
  - `integracion/paquete-apts/runtime-adapters/{claude,opencode,vscode}/**` — **regenerados** con
    `scripts/generate-adapters.js` (28 archivos, idempotente). No se editó ninguno a mano.
  - `integracion/TRACKING-mcp-remoto.md`, `integracion/PLAN-mcp-remoto.md`.
  - **`apts-mcp.js`, `apts-client.js` y `generate-adapters.js` no se tocaron.** El camino actual no
    cambió ni una línea.

  **Comprobación bloqueante resuelta:** `vscode` **sí** envía las tres cabeceras de identidad (VS
  Code 1.131.0). Con eso, los tres programas cliente quedan confirmados y la decisión #1 no se
  replantea para ninguno. De regalo: VS Code prueba `GET /mcp`, recibe el `405` y sigue por `POST`.

  **Dos cosas que el diseño previo no había previsto** y se anotaron en vez de improvisarlas: el
  generador **no emitía ningún registro MCP para `vscode`**, así que ahí el bloque es superficie
  nueva y no una migración; y **la regla 9 no era el único punto falso** de la prosa gestionada —la
  misma afirmación estaba en otros seis sitios, incluido un agente que mandaba inspeccionar
  `.apts/execution-context.json`, archivo que por el camino remoto no existe.

  **`APTS_test` sin tocar**, en su estado de partida exacto: `initiatives:2`, `epics:2`,
  `backlog_items:361`, `tasks:263`. Servidor de pruebas apagado. Los espacios de trabajo desechables
  se borraron; los cuatro programas de comprobación (registro desde el manifiesto, comparación de
  manifiestos, humo por entrada/salida estándar y conteo de la base) quedan **fuera del repositorio**
  hasta que se firme el gate, por si hay que repetir alguna medición, y se borran al cerrar F6-4.

- 2026-08-01 — **F6-2 completa (T1..T5); en GATE, esperando firma.** El salto HTTP interno
  desapareció: `POST /mcp` ejecuta en proceso llamando directamente a las funciones de negocio.
  **Sin dependencias nuevas, sin migraciones.**
  Archivos tocados:
  - `backend/index.js` — ejecutor en proceso `mcpLocalExecutor` (21 funciones) + traducción de error
    equivalente a la del cliente; piezas extraídas y compartidas con las rutas
    (`parseReadProjectContextOptions`/`readProjectContextInternal`, `parseListBacklogItemsOptions`,
    `parseGetBacklogItemOptions`/`getBacklogItemInternal`, `parseGetTaskOptions`/`getTaskInternal`,
    `searchSimilarBugReportsOperation`, `parseCreateInitiativeInput`, `parseBatchItems`,
    `buildBatchOperationResponse`, `buildApiErrorPayload`, `assertBacklogCreateBatchItems`);
    endurecimiento de 4 esquemas + `top_k`; corrección de los 9 helpers de mensaje de zod;
    auto-chequeo de contrato en el arranque; plazos de espera de embeddings y webhook;
    **andamio de F6-1 retirado** (`APTS_BASE_URL`/`APTS_CONTEXT_FILE` forzados, `import()` de
    `apts-client.js`, `require('node:os')`).
  - `backend/scripts/lib/semantic_embeddings.js` — plazo de espera en la llamada a OpenRouter.
  - `integracion/TRACKING-mcp-remoto.md`, `integracion/PLAN-mcp-remoto.md`.
  - **`integracion/paquete-apts/` no se tocó en esta fase**: `apts-mcp.js` y `apts-client.js` quedan
    como los dejó F6-1. El camino actual no cambió ni una línea.

  **Resultado:** igualdad demostrada, **21 de 21 operaciones en verde y cero bloqueos**, incluidos
  los rechazos y el modo lote. Las dos suites de regresión del repo (`test_agent_api_batch.js` y
  `test_agent_api.js`) pasan enteras contra el servidor de pruebas.

  **Tres cosas que el diseño previo no había previsto y se replantearon con el operador**, en vez de
  improvisar: el alcance de los plazos de espera (el inventario de F6-0 señalaba una sola llamada y
  eran tres), la divergencia de `top_k`, y el lote parcial de `create_backlog_item`. Las tres están
  documentadas en su tarea.

  **`APTS_test` restaurado** al estado de partida exacto: `initiatives:2`, `epics:2`,
  `backlog_items:361`, `tasks:263`. Programas de prueba desechables borrados; servidor de pruebas
  apagado.

- 2026-08-01 — **F6-1 completa (T1+T2+T3+T4); en GATE, esperando firma.** El transporte MCP sobre
  HTTP funciona sin estado en `POST /mcp`, con la ejecución todavía por `apts-client.js` contra el
  propio servidor, como manda el PLAN. **Sin dependencias nuevas, sin migraciones.**
  Archivos tocados:
  - `integracion/paquete-apts/apts-mcp.js` — `dispatch()` devuelve la respuesta; arranque
    condicional (`main()` solo al ejecutarlo directamente); exportes nuevos.
  - `integracion/paquete-apts/apts-client.js` — **un solo cambio**: exportar
    `AUTO_FILL_FIELDS_BY_OPERATION`, para que `/mcp` sepa qué campos inyectar sin mantener una lista
    paralela. Ninguna función tocada.
  - `backend/index.js` — ruta `POST /mcp` + `GET /mcp` → 405; resolución e inyección de identidad;
    `express.json` de 4 MB solo en `/mcp` (el resto sigue en 100 kb, verificado con un 413);
    `apiLimiter` de 100 → 600/min; registro de `mcp_request` y `mcp_identity`.
  - `integracion/TRACKING-mcp-remoto.md`, `integracion/PLAN-mcp-remoto.md`.

  **Corrección del estado de partida de `APTS_test`:** el documento decía `backlog_items:358`; el
  estado real medido antes de tocar nada es **`backlog_items:361`**, con `initiatives:2`, `epics:2`
  y `tasks:263`. Es a **ese** estado al que hay que restaurar, y así se hizo: la base quedó en
  `2 / 2 / 361 / 263`, sin restos de `apts://f61/%`.

  **Resultado:** 27/27 comprobaciones del programa de prueba en verde; cabecera de identidad
  confirmada en Claude Code 2.1.220 y opencode 1.18.10; **cero** identidad del servidor filtrada.
  Programas de prueba y cliente desechable borrados; servidor de pruebas apagado.
  Tres decisiones nuevas quedaron registradas en
  [Decisiones tomadas dentro de F6-1](#decisiones-tomadas-dentro-de-f6-1); la de `Accept` es la única
  que sigue abierta para el gate.

- 2026-08-01 — **Repaso de coherencia de los dos documentos.** Se eliminaron los restos de lo ya
  resuelto y las contradicciones: el PLAN §3 seguía con las 7 decisiones marcadas como abiertas y
  con recomendaciones que no son las aprobadas; §5 mostraba un bloque de registro **sin las
  cabeceras de identidad**; §6 describía F6-0 como pendiente y pedía en F6-1 un informe que ya no
  aplica; §7 seguía señalando `analyze` y el indexado como riesgo de plazo de espera, que es
  justamente lo que F6-0 descartó. En el TRACKING: la base de la rama decía `52e68dc` en vez de
  `6fd94ac`; F6-1 seguía diciendo que mide "el coste de la identidad explícita"; F6-2/3/4 no
  recogían lo decidido (endurecer 5 huecos, plazo de espera, cabeceras en el manifiesto y en el
  cliente de prueba). Se añadieron las tareas que faltaban: **F6-2-T4** (plazo de espera) y
  **F6-3-T4** (regenerar la prosa de los adaptadores, cuya regla 9 es falsa para el cliente remoto).
  Se unificó el vocabulario en español y se renombró la fase F6-1, que se llamaba "Espolón".
  Archivos tocados: `integracion/PLAN-mcp-remoto.md`, `integracion/TRACKING-mcp-remoto.md`.
  Sin código. `APTS_test` sin tocar.

- 2026-08-01 — **Punto de parada de F6-0 FIRMADO.** Las decisiones se tomaron una por una con el
  operador. Resultado: identidad **en la configuración del cliente** (cabeceras), no escrita por el
  agente; se endurecen los **5 huecos que guardan datos** y `heartbeat` queda como diferencia
  declarada; se le pone **plazo de 10 s** a la llamada externa a OpenRouter, dentro de F6; tamaño de
  mensaje a **4 MB solo en `/mcp`**; y **tope global de peticiones a 600/min**, un solo contador
  —elección del operador frente a la recomendación de usar contadores separados, con el costo
  asumido de que agente y panel compartan cuota—. Archivo tocado: `integracion/TRACKING-mcp-remoto.md`.
  Sin código todavía. **F6-1 habilitada.**

- 2026-08-01 — **F6-0 completa (T1+T2+T3); en GATE, esperando firma.** Rama `feat/mcp-remoto` creada
  desde `main` @ `6fd94ac` (**no** desde `52e68dc` como decía este doc: ese SHA es anterior al commit
  que introduce el PLAN y el TRACKING, así que branchar ahí los habría dejado fuera; `6fd94ac`
  contiene `52e68dc`). **Sin código, sin migraciones; `APTS_test` no se tocó** — la decisión #1 se
  cerró en papel y no hizo falta PoC, así que el servidor de test ni se levantó.
  Archivos tocados: **solo `integracion/TRACKING-mcp-remoto.md`** (este).
  Verificado por inspección: `backend/index.js` (rutas `:3084-4027`, zod `:836-988`, `*Internal`
  `:2699-3065`, `authenticateAgent` `:159`, limitadores `:156-157`, `express.json()` `:109`),
  `backend/scripts/lib/method_bootstrap.js`, `…/method_resolver.js`, `…/method_outputs.js`,
  `…/semantic_documents.js`, `…/semantic_embeddings.js`,
  `integracion/paquete-apts/apts-client.js`, `…/apts-mcp.js`, `…/apts_skills.json` (21 ops
  confirmadas), `…/runtime-adapters/{claude,opencode}/*`,
  `backend/migrations/20260620000010_bmad_hierarchy.js`.
  Resultados: **18/21 ops ya son ruta fina** (las 3 inline son de solo lectura) · **6 huecos de
  validación** en el camino remoto, 5 de identidad y 1 (`create_initiative`) que llega a la DB y
  degrada un 400 a 500 · **el riesgo de timeout no es `analyze`** (ruta de dashboard, fuera de las
  21) sino el embedding síncrono a OpenRouter **sin `AbortSignal`** en toda escritura de backlog
  (`semantic_embeddings.js:173`), multiplicado por N en modo batch · `express.json()` sin límite
  configurado = **100 kb**, por debajo de lo que ya mandan `spec_artifact` y `output`.

- 2026-08-01 — Creados PLAN y TRACKING F6 tras verificar el problema: la superficie MCP es un script
  stdio distribuido, lo que obliga a 4 artefactos ejecutables descargables, `artifact_sync_policy`
  con `updater_contract`, y ~9k tokens de manifiesto por integración (medido). `dispatch()`
  (`apts-mcp.js:133`) ya es transporte-agnóstico salvo el `send()` a stdout, y `authenticateAgent`
  (`backend/index.js:159`) ya valida el Bearer que usaría el endpoint remoto. Sin cambios de código.
