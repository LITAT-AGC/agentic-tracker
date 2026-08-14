# Plan: ideas de `anotaciones.md`

## Contexto

`anotaciones.md`/`.txt` juntan siete ideas sueltas sobre el panel APTS y el conductor
(`integracion/conductor/apts-loop.js`). Van de un ajuste de CSS a un cambio de arquitectura
del conductor. Se agrupan en 5 fases, de menor a mayor riesgo, para poder entregar y verificar
cada una por separado.

Durante el diálogo se resolvieron estas ambigüedades:

- **Idea #1** ("editar agentes y reglas por proyecto") son en realidad dos features
  independientes: exponer en el panel algo que el backend ya tiene (`set_project_constraints`,
  sin UI), y construir un editor nuevo para el roster BMAD (`entities`/reglas de conducción),
  que hoy es 100% global y de solo lectura desde cualquier superficie (ni HTTP ni MCP lo
  escriben).
- **Idea #4** (orden de logs) — el backend ya devuelve `agent_logs` en `created_at desc`
  (`backend/index.js:5295`); no hay ningún `sortable`/`sortField` en la tabla que lo pise. Se
  verifica en runtime como primer paso de la Fase 0; si el bug es real está en otro lado de lo
  que se sospechaba.
- **Ideas #5/#6** (conductor por WebSocket / modo daemon) — se investigó por qué el conductor
  usa `spawnSync` (bloqueante) para lanzar al agente: no hay una razón defendida en el código,
  es simplemente el estado actual, y el comentario en `apts-loop.js:590-595` describe un
  síntoma (la tarea se marca `stalled` porque el conductor no puede latir mientras el agente
  corre) y lo parcha con reanimación en vez de atacar la causa. Se corrigió el diseño: pasar a
  `spawn` asíncrono no es una reescritura grande, resuelve el síntoma de raíz (el conductor
  puede mandar `heartbeat` — operación MCP que ya existe, `backend/index.js:3432` — mientras el
  agente trabaja) y de paso habilita interrupción real a mitad de historia. Con eso resuelto, la
  elección de transporte para las órdenes (start/stop/pausa) vuelve a ser una decisión ordinaria:
  se recomienda seguir con polling sobre el mismo canal MCP en vez de levantar un servidor
  WebSocket nuevo, porque para un comando que dispara una persona desde el panel, ~10s de
  latencia es indistinguible de instantáneo, y evita sumar una pieza de infraestructura
  (conexión, reconexión, auth) para una ganancia que nadie va a notar. Si más adelante hace
  falta latencia sub-segundo, cambiar polling por WS es un paso chico porque la parte difícil
  (spawn asíncrono + manejo de señales) ya está resuelta.

## Fase 0 — Ajustes de UI en `ProjectDetails.vue`

1. **Botón "Cerrar" explícito** en el diálogo de edición/creación de backlog item
   (`frontend/src/views/ProjectDetails.vue:535-612`): agregarlo al footer, junto a
   "Guardar cambios" (llama a `cancelBacklogEdit`, ya existe).
2. **Separar la pestaña "Ejecución"** en tres: **Backlog**, **Conductor**, **Logs** (hoy
   `tabOptions` en `ProjectDetails.vue:625-628` solo tiene `execution`/`semantic`, y
   `execution` mezcla las tres tablas). La pestaña **Conductor** queda con un placeholder
   ("aún no disponible") hasta la Fase 4, que la completa.
3. **Verificar el orden de logs**: correr el panel contra el backend de prueba, abrir la
   pestaña Logs de un proyecto con actividad reciente y confirmar visualmente el orden. Si
   está mal, la causa más probable es un re-render tras una acción (crear/editar backlog)
   que no reordena — el fix sería forzar orden client-side antes de asignar `projectLogs.value`,
   no tocar el backend.

No toca backend. Verificación: cargar el panel, abrir un proyecto, confirmar visualmente los
tres puntos.

## Fase 1 — Restricciones del proyecto en el panel

`get_project_constraints`/`set_project_constraints` ya existen
(`backend/index.js` ~2038-2119 lógica, rutas `GET/PUT /api/projects/:url/constraints`
~4550-4589) pero ninguna vista los consume. Agregar una sección "Restricciones del proyecto"
(test/lint/typecheck command, framework, language, conventions) en la nueva pestaña
**Backlog** o en una pestaña **Configuración** de `ProjectDetails.vue`, con el mismo patrón de
formulario que ya usa el editor de backlog item: campos de texto, guardar con `PUT`, mostrar lo
efectivo que devuelve la respuesta (no lo enviado, tal como ya lo documenta `ESTADO.md`).

Verificación: escribir un subconjunto de campos, confirmar que persiste tras recargar, escribir
`null` explícito en uno y confirmar que solo borra ese.

## Fase 2 — Editor de agentes y reglas del método BMAD

Hoy `entities` (agentes/personas), `workflow_definitions` y `workflow_steps` son globales,
sembrados por `backend/seeds/bmad_seed.js` con upsert-por-`key`, y **ningún** endpoint HTTP o
MCP los escribe. `METHOD_CONDUCTION` (las reglas de conducción) es un objeto JS hardcodeado en
`backend/index.js` (~2539-2583), también de solo lectura.

Diseño (aditivo, no toca las tablas globales para no chocar con el reseed):

- **Edición global de agentes**: nueva ruta `PATCH /api/dashboard/roster/entities/:key` que
  escribe directo en `entities` (afecta a todos los proyectos) — campos editables: `name`,
  `persona`, `principles`, `communication_style`, `instruction`. `GET
  /api/dashboard/roster` lista entities + workflow_definitions con su fase, para que el panel
  "sugiera todo lo editable".
- **Overrides por proyecto**: tabla nueva `entity_overrides(project_url, entity_key, name?,
  persona?, principles?, communication_style?, instruction?)`, incompleta a propósito — un
  campo `null` significa "heredar el global". `method_resolver.js` necesita un punto único de
  lectura de entity (`resolveEntity(projectUrl, key)`) que mergee override sobre global; hay
  que ubicar cada sitio que hoy lee `entities` directo para las cargas al agente y pasarlo por
  ahí (no hay una función central hoy — se identifica durante la implementación).
- **Reglas de conducción por proyecto**: mismo patrón que `project_constraints` — guardar el
  override en la tabla `config` bajo una clave `method_conduction:<project_url>`, y que el
  builder del manifiesto (`method_conduction` en la respuesta MCP) prefiera el override sobre
  la constante `METHOD_CONDUCTION` cuando exista.
- **Frontend**: una vista nueva (o sección dentro de Settings.vue, que ya es "configuración
  operativa" global) con dos partes: listado global editable, y — entrando desde
  `ProjectDetails.vue` — un panel de overrides que muestra el valor global en gris y un campo
  vacío al lado para pisarlo.

Fuera de alcance explícito: editar `workflow_steps` (instrucciones paso a paso) — más
profundo, mayor riesgo de romper el flujo generativo, y no es lo que pidieron las anotaciones.

Verificación: editar un agente global y confirmar que `aptsWorkflowStep` sirve la instrucción
nueva a un proyecto sin override; crear un override en otro proyecto y confirmar que solo ese
proyecto la ve; re-sembrar (`seed:method:test`) y confirmar que los overrides sobreviven (no
están en las tablas que el seed toca).

## Fase 3 — Diario del conductor visible en el panel

El conductor ya escribe un diario local JSONL (`registrar`/`escribirDiario`,
`apts-loop.js:492-495`) con cada evento (reintentos de red, paradas, decisiones). Hoy vive solo
en disco.

- **Backend**: nueva operación ligera (MCP + REST, mismo patrón que el insert de
  `agent_logs` que ya usa `report_blocker`) para que el conductor mande un evento del diario
  como fila de `agent_logs` (`action_type` distinto, ej. `'journal'`; `technical_details`
  jsonb con el payload del evento). Atada a la tarea que el conductor ya abre por unidad
  (`abrirTarea`/`tareaActual` en `apts-loop.js`), así aparece sola en la tabla de logs que ya
  existe — sin tabla nueva.
- **Conductor**: `registrar()` gana un segundo sink además del `appendFileSync` local: un
  intento best-effort de mandar el evento al servidor. Nunca bloquea ni hace fallar el bucle —
  mismo espíritu que el resto del conductor (el diario local sigue siendo la fuente de verdad
  si el envío falla).
- **Frontend**: nada nuevo que construir más allá de lo que la Fase 0 ya deja listo — estos
  eventos aparecen en la pestaña **Logs** junto a los demás, filtrables por `action_type`
  (el filtro ya es dinámico, `logActionOptions` en `ProjectDetails.vue:696-698`).

Verificación: correr el conductor con `--dry-run` contra el servidor de prueba, confirmar que
los eventos aparecen en `GET /api/dashboard/projects/:url` → `logs`, y que si se apaga el
servidor a mitad de corrida el conductor sigue (el diario local no se interrumpe).

## Fase 4 — Conductor: interrupción real y control desde el panel

1. **`spawn` asíncrono** en `lanzarAgente` (`apts-loop.js:750-783`), reemplazando `spawnSync`:
   se envuelve en una `Promise` que resuelve en el evento `close` del hijo, preservando
   `stdio: 'inherit'` (la salida del agente se sigue viendo en vivo en la terminal).
2. **Heartbeat durante la ejecución**: con el event loop libre, el conductor manda `heartbeat`
   (operación MCP existente, `heartbeatInternal` en `backend/index.js:3432`) cada pocos minutos
   mientras el agente corre. Esto elimina la necesidad del parche de reanimación en
   `moverTarea` (`apts-loop.js:590-608`) — la tarea ya no se marca `stalled` por falta de señal
   durante una historia larga, así que ese bloque de manejo de error se puede simplificar o
   retirar.
3. **Interrupción real**: nueva tabla `conductor_orders(id, agent_name, command, payload
   jsonb, status, created_at, acked_at)`. El conductor pollea un endpoint nuevo (mismo estilo
   que `apts_status`, cada ~10s, en paralelo a la ejecución del agente gracias al punto 1) y al
   recibir `detener`/`pausar` manda señal al proceso hijo: `SIGTERM` con plazo de gracia y
   recién si sigue vivo, forzar. **Cuidado Windows**: `shell: true` interpone `cmd.exe`, así
   que matar el PID del hijo Node no mata al proceso real (claude/opencode); hace falta matar
   el árbol completo. Sin dependencias nuevas (el conductor es autocontenido, solo builtins de
   Node): en Windows vía `taskkill /pid <pid> /t /f`, en POSIX vía `detached: true` + matar el
   grupo de proceso. Se implementa y se prueba explícitamente en Windows, que es donde corre
   hoy.
4. **Seguridad del corte**: una historia interrumpida a mitad de un paso (sin submit) se
   comporta exactamente como un crash — el sistema ya está diseñado para esto (claim
   idempotente, `aptsWorkflowStep` re-sirve el paso donde el puntero sigue `running`, según
   `ESTADO.md`). No hay riesgo nuevo que cubrir aparte de probarlo.
5. **Modo daemon** (`apts-loop.js` sin `--project-url`/`--agent-cmd`): en vez de fallar con
   `SALIDA.config`, entra en espera — pollea el mismo endpoint de órdenes esperando un
   `{command: 'start', project_url, agent_cmd, workflows, model_escalation}`. Al recibirlo,
   arranca el bucle normal (que a su vez sigue pollendo el mismo canal para `detener`/`pausar`
   durante la ejecución).
6. **Frontend**: la pestaña **Conductor** (placeholder de la Fase 0) muestra estado (`idle` /
   corriendo tal historia / pausado), el último evento del diario (Fase 3) y botones **Iniciar**
   (elige workflow/modelo/comando de agente), **Detener**, **Pausar/Reanudar** — cada uno
   inserta una fila en `conductor_orders` vía REST.

Verificación: `--dry-run` primero (como ya recomienda el README); luego una corrida real en
`APTS_test` con una historia sintética, confirmando: heartbeat visible en `last_heartbeat`
mientras el agente "corre" (usar un `--agent-cmd` que duerma unos minutos para simular), orden
de `detener` a mitad de esa espera corta el proceso e interrumpe el bucle, y la siguiente
corrida retoma la misma historia sin duplicar trabajo. Probar específicamente en Windows que
`taskkill` efectivamente termina el proceso del agente y no deja huérfanos (`Get-Process` antes
y después).

## Orden de entrega

Fase 0 → 1 → 2 → 3 → 4, cada una commiteable y verificable por separado. La Fase 3 depende de
la pestaña **Logs** de la Fase 0; la Fase 4 depende de la pestaña **Conductor** (Fase 0) y se
apoya en el canal de diario (Fase 3) para mostrar estado en el panel.
