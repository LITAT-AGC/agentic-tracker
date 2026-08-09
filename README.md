# APTS - Agentic Project Tracking Service

APTS es un servicio de seguimiento de proyectos orientado a agentes de IA. En lugar de depender solo del contexto del chat o de comentarios dispersos en el codigo, APTS centraliza backlog, tareas de ejecucion, estados, heartbeats, bloqueos y logs tecnicos detras de un endpoint MCP remoto (con una API REST equivalente por debajo), con un dashboard web para supervision humana.

Y hace una cosa mas, que es la que lo separa de un tablero: lleva dentro un **motor del
metodo BMAD**. El servidor decide en que fase esta una iniciativa, que paso toca, que rol
lo tiene que ejecutar y que artefacto hace falta para cerrarlo. El cliente pregunta y
obedece.

Por donde empezar, segun a que vengas:

| Quiero… | Ir a |
| --- | --- |
| entender que hace y con que esta hecho | [Arquitectura](#arquitectura) |
| entender el metodo y como esta implementado | [El metodo BMAD y como esta implementado](#el-metodo-bmad-y-como-esta-implementado) |
| levantar el servicio en mi maquina | [Instalacion local](#instalacion-local) |
| conectar OTRO repositorio a APTS | [Como integrar otros proyectos con APTS](#como-integrar-otros-proyectos-con-apts) |
| dejar corriendo la implementacion sola | [El bucle de implementacion](#paso-3-el-bucle-de-implementacion-opcional) |
| saber que hay hoy en produccion | `integracion/ESTADO.md` |

## Que incluye

- Backend en Node.js + Express + Knex.
- Base de datos PostgreSQL en todos los entornos operativos.
- Perfil SQLite legacy solo para una migracion one-shot de datos historicos.
- Dashboard web en Vue 3 + Vite + Pinia + PrimeVue + Tailwind CSS + ECharts.
- Material de integracion para proyectos cliente en `integracion/`.
- Script de prueba de API para validar el flujo de agentes.
- Reglas operativas para agentes y pruebas E2E en `AGENTS.md`.

## Problema que resuelve

APTS esta pensado para equipos que usan agentes de desarrollo y necesitan:

- Ver que esta haciendo cada agente en tiempo casi real.
- Gestionar backlog por proyecto como fuente de verdad del trabajo planificado.
- Tener trazabilidad por proyecto, rama, tarea y log tecnico.
- Detectar tareas bloqueadas o agentes sin actividad reciente.
- Permitir supervision humana desde un dashboard separado.
- Estandarizar como un agente lee contexto, reporta progreso y cierra trabajo.

## Arquitectura

### Backend

- Endpoint MCP remoto (`POST /mcp`) como superficie de integracion para agentes, API REST equivalente y API de dashboard.
- Persistencia con Knex.
- PostgreSQL en desarrollo, test y produccion mediante `PG_CONNECTION_STRING` o `DATABASE_URL`.
- Perfil `sqlite_legacy` reservado para migrar una base SQLite historica una sola vez.
- Autenticacion por API key para agentes.
- Sesion por cookie para dashboard humano.

### Frontend

- Login para supervisores.
- Vista Overview con metricas, tareas y feed.
- Vista Projects con drill-down por repositorio.
- Resolucion manual de bloqueos desde la UI.

### Capa de integracion de agentes

El paquete `integracion/paquete-apts/` describe las herramientas que un runtime de agentes puede exponer. Cada skill se corresponde con un endpoint REST del backend.

El backend expone ademas el endpoint MCP remoto en `POST /mcp`: un runtime lo registra con una URL y cuatro cabeceras, y recibe una tool nativa por operacion del contrato.

## Skills disponibles

El repositorio incluye material de integracion en `integracion/paquete-apts/`: el contrato JSON, la guia de instrucciones para agentes, la spec de superficie y el generador de adaptadores por runtime.

Como este repositorio es publico, esos archivos se consumen directamente desde `integracion/paquete-apts/`.

Ademas, el backend publica un punto de entrada publico para agentes en `/api/public/integrar`. Ese endpoint devuelve un manifiesto JSON con el bloque de registro del MCP remoto por runtime, el bucle de conduccion del metodo como dato (`method_conduction`), los artefactos opcionales (contrato de skills, guia operativa, guia de empaquetado, spec de superficie, generador de adaptadores, y el conductor del bucle con su manual y su plantilla de prompt) y un bloque `bootstrap` que explica el proposito de APTS, la migracion desde tracking local y como solicitar y alojar `APTS_API_KEY`. No requiere token.

Politica de mantenimiento del manifiesto: cada cambio funcional, estructural o semantico en `/api/public/integrar` debe subir `schema_version`, y cada artefacto cuyo contenido cambie debe subir su `artifact_version`.


Superficie recomendada: registrar el servidor MCP remoto copiando el bloque de `mcp_endpoint.registration_by_runtime` que corresponda al runtime. No hace falta descargar ningun archivo para llamar a las operaciones.

Todas las llamadas de agentes deben incluir la cabecera:

```http
Authorization: Bearer <APTS_API_KEY>
```

Las operaciones del contrato, con su endpoint REST equivalente (la fuente formal de parametros y tipos es `apts_skills.json`):

| Operacion | Metodo | Endpoint | Uso |
| --- | --- | --- | --- |
| `register_task` | POST | `/api/projects/tasks` | Crear (o reanudar via `backlog_item_id`) una tarea y obtener `task_id`. |
| `read_project_context` | GET | `/api/projects/context` | Leer backlog, tareas y logs recientes del proyecto. |
| `list_backlog_items` | GET | `/api/projects/backlog` | Listar backlog por proyecto, ordenado por prioridad y orden manual. |
| `get_backlog_item` | GET | `/api/backlog/:id` | Leer un backlog item concreto. |
| `get_task` | GET | `/api/tasks/:id` | Leer una tarea concreta. |
| `get_project_constraints` | GET | `/api/projects/:url/constraints` | Leer las restricciones operativas del proyecto. |
| `set_project_constraints` | PUT | `/api/projects/:url/constraints` | Registrar comandos de test/lint/typecheck, lenguaje y convenciones. |
| `search_similar_bug_reports` | POST | `/api/projects/backlog/semantic-search` | Buscar bugs similares semanticamente para intake sin duplicados. |
| `create_backlog_item` | POST | `/api/projects/backlog` | Crear un backlog item gestionado en APTS. |
| `update_backlog_item` | PATCH | `/api/backlog/:id` (batch: `/api/backlog`) | Editar estado, prioridad o contenido de un backlog item. |
| `delete_backlog_item` | DELETE | `/api/backlog/:id` (batch: `/api/backlog`) | Eliminar (soft-delete) un backlog item. |
| `update_task_status` | PATCH | `/api/tasks/:id/status` (batch: `/api/tasks/status`) | Cambiar estado de una tarea. |
| `log_agent_progress` | POST | `/api/tasks/:id/logs` (batch: `/api/tasks/logs`) | Registrar progreso, decisiones o cambios tecnicos. |
| `report_blocker` | POST | `/api/projects/blockers` | Reportar bloqueo y marcar proyecto como bloqueado. |
| `heartbeat` | POST | `/api/tasks/:id/heartbeat` (batch: `/api/tasks/heartbeat`) | Marcar actividad reciente del agente. |
| `create_initiative` | POST | `/api/projects/initiatives` | Arrancar una iniciativa del metodo BMAD. |
| `set_agent_role` | POST | `/api/projects/agent-roles` | Registrar o conmutar el rol de un agente en la iniciativa. |
| `apts_next` | POST | `/api/projects/next` | Pedir al motor del metodo el siguiente paso para este agente. |
| `apts_status` | GET | `/api/projects/method-status` | Leer el estado del metodo (fase, roles, pendientes). |
| `apts_set_status` | PATCH | `/api/backlog/:id/method-status` | Cambiar el estado de metodo de un item. |
| `apts_workflow_step` | POST | `/api/projects/workflow-step` | Obtener la definicion del paso de workflow en curso. |
| `apts_submit_step` | POST | `/api/projects/submit-step` | Entregar la salida de un paso de workflow. |

## Flujo esperado de un agente

1. Registrar el MCP remoto: la identidad del proyecto y del agente viaja en las cabeceras del registro.
2. Consultar backlog (`list_backlog_items`) y seleccionar un item pendiente o crear uno nuevo si corresponde.
3. Crear la tarea de ejecucion con `register_task` y asociarla al `backlog_item_id`.
4. Leer el contexto del proyecto antes de trabajar (`read_project_context`).
5. Registrar progreso y enviar heartbeat mientras ejecuta la tarea.
6. Reportar blocker si no puede continuar.
7. Marcar la tarea como `review` primero y `done` solo tras revision y actividad reciente; APTS sincroniza el estado del backlog vinculado.

Valores que la integracion referencia (el bloque del manifiesto trae la URL embebida; `APTS_MCP_URL` solo lo usan los adaptadores estaticos generados):

```env
APTS_MCP_URL=https://apts.example.com/mcp
APTS_API_KEY=...
APTS_PROJECT_URL=https://github.com/org/repo
APTS_AGENT_NAME=tu-agente
APTS_AGENT_EMAIL=tu-agente@example.com
```

El servidor no inspecciona el entorno, el sistema de archivos ni el Git del cliente: esos valores llegan en las cabeceras del registro. Un valor enviado en los argumentos de la llamada gana a la cabecera —asi conmuta de rol un agente— y un `project_url` que contradiga la cabecera se rechaza. `task_id` lo devuelve `register_task` y viaja en la llamada; `branch` es opcional y no puede ir en cabecera porque cambia durante la sesion.

El backend normaliza la URL del repositorio para que valores como `git@github.com:org/repo.git` y `https://github.com/org/repo` se traten como el mismo proyecto.

## Modelo operativo backlog -> task

APTS separa la planificacion del trabajo de su ejecucion:

- `backlog_items`: trabajo planificado y priorizado por proyecto.
- `tasks`: ejecuciones concretas de agentes (una sesion de trabajo sobre un item).
- `agent_logs`: evidencia tecnica de la ejecucion.

Un backlog item puede enlazarse con una `active_task_id` mientras esta en ejecucion.

## El metodo BMAD y como esta implementado

APTS no es solo un tablero: lleva dentro un **motor de metodo**. BMAD (v6.8.0) es un metodo
de desarrollo asistido por agentes que parte el trabajo en fases, le pone un rol distinto a
cada una y exige documentos concretos antes de dejar pasar a la siguiente. APTS no lo
reimplementa ni lo interpreta: **importa el corpus de BMAD a la base y lo ejecuta**.

La consecuencia practica, y es la regla que gobierna todo lo demas: **el metodo vive en el
servidor**. Un cliente no elige la fase, ni el paso, ni el rol, ni cuando algo esta
terminado. Pregunta `apts_next` y hace exactamente lo que se le contesta. Cuando el cliente
aporta algo, es contenido —la prosa de un documento, el codigo de una story—, nunca
estructura.

### Las cuatro fases, y que cierra cada una

El ciclo de vida es `analysis -> planning -> solutioning -> implementation -> done`. Cada
fase tiene una **espina**: la lista ordenada de workflows que la gatean. `apts_next` la
recorre en orden y activa el primero que no este completo; la fase avanza cuando no queda
ninguno.

| Fase | Workflows de la espina | Producen | Rol |
| --- | --- | --- | --- |
| `analysis` | `bmad-product-brief` | `brief` | `bmad-agent-analyst` (Mary) |
| `planning` | `bmad-prd` | `prd` | `bmad-agent-pm` (John) |
| `solutioning` | `bmad-create-architecture` -> `bmad-create-epics-and-stories` -> `bmad-check-implementation-readiness` | `architecture`, `epics` (y **crea los backlog items**), `readiness` | `bmad-agent-architect` (Winston) |
| `implementation` | `bmad-sprint-planning` -> `bmad-create-story` -> `bmad-dev-story` | `sprint_plan`, `story_spec` (una por story), y por cada story `status: done` + `code_review` | `bmad-agent-dev` (Amelia) |

"Completo" no es una opinion: es que **exista el artefacto que el workflow declara
producir**. Esa correspondencia workflow → output vive en un solo sitio,
`backend/scripts/lib/method_outputs.js`, y de ahi se derivan tanto los `outputs[]` que el
paso terminal le pide al agente como el predicado de completitud que gatea la fase. No
pueden contradecirse porque son la misma fuente.

El corpus trae muchos mas workflows por fase —`bmad-market-research`, `bmad-ux`,
`bmad-retrospective`, `bmad-code-review`…— pero solo los marcados `routing.required`
forman la espina. El resto existe y es invocable, y no gatea nada.

Dos consecuencias que conviene saber de antemano:

- **Una spec del cliente no salta ninguna fase.** `create_initiative` la guarda con
  `doc_type: 'spec'` precisamente para que no cierre nada: es la ENTRADA del analyst y del
  PM, no un sustituto de sus artefactos. Arrancar en una fase adelantada se rechaza con
  `PHASE_NOT_REACHABLE` salvo que los artefactos de las fases salteadas ya existan en el
  proyecto.
- **La fase de implementacion no termina hasta que TODAS las stories estan `done`.**
  `bmad-dev-story` es *iterable*: no se completa por producir un documento, sino cuando no
  le queda ninguna unidad pendiente.

### Los tres bucles anidados

Es lo que mas cuesta ver desde fuera, porque en la salida del conductor los tres se
parecen. Van de fuera hacia dentro y **los tres son secuenciales**; el unico paralelismo de
todo el sistema esta en el nivel mas interno.

**1. El bucle de la iniciativa.** Fase por fase, y dentro de cada fase workflow por
workflow, siguiendo la espina. Lo conduce quien llame a `apts_next`: una persona, el agente
`APTS Method Orchestrator`, o el conductor del bucle en la fase de implementacion.

**2. El bucle de las unidades.** En `bmad-dev-story`, cada story es una **unidad de
trabajo** que se reclama, se trabaja y se cierra por separado. El motor reparte la
siguiente por `priority, sort_order` —el plan del backlog— y no por identificador. Para el
conductor, una vuelta = una story = un proceso de agente con contexto limpio. Nunca hay dos
a la vez.

**3. Los pasos del workflow, y el salto hacia atras.** Una story no es un paso: es el
workflow `bmad-dev-story` entero, que tiene **diez pasos** y los recorre el agente dentro de
su unica sesion.

```
1  Find next ready story and load it
2  Load project context and story information
3  Detect review continuation and extract review context
4  Mark story in-progress
5  Implement task following red-green-refactor cycle      <--+
6  Author comprehensive tests                                |
7  Run validations and tests                                 | goto:step:5
8  Validate and mark task complete ONLY when fully done   ---+
9  Story completion and mark for review
10 Completion communication and user support
```

El paso 8 es la compuerta. Si la validacion encuentra algo, el agente **no parchea y
sigue**: declara la rama que el propio metodo define, `{"goto": "step:5"}`, y vuelve al paso
5 a implementar. Cada ida y vuelta es una **ronda**. El conductor no ve nada de esto: para
el, la vuelta sigue en curso.

Y dentro del paso 8 hay un cuarto nivel, que es el unico paralelo: la revision adversaria
lanza **tres subagentes a la vez**, cada uno con una lente distinta y ciego a los otros
—Blind Hunter (solo el diff, sin story ni criterios), Edge Case Hunter (limites, vacios,
nulos, rutas de error) y Acceptance Auditor (la story y sus criterios contra el codigo
real)—. Un hallazgo solo cuenta si trae `archivo:linea` y un escenario de fallo concreto.

#### El tope de saltos

Los saltos **hacia atras** estan topados en 3 por unidad (`METHOD_MAX_STEP_REVISITS`). Solo
se cobran los retrogrados: todo ciclo contiene al menos una arista hacia atras, asi que
acotarlas acota el grafo entero y los saltos hacia adelante no gastan presupuesto.

Existe porque ese bucle es invisible para cualquier freno del cliente: pasa dentro de una
sesion de agente, entre dos `apts_submit_step`, por debajo del muestreo de cualquier
vigilancia externa. Sin tope, un agente que no consigue arreglar algo puede quedarse
8->5->8->5 hasta agotar su contexto sin producir nada. Por eso el contador vive en el
servidor, en `project_state.cursor.visits`.

Cuatro pasadas por el paso 8 gastan tres saltos. La quinta se degrada a `HALT`, y entonces
el agente debe reportar bloqueo: cerrar la story a la fuerza, o corregir en silencio para
esquivar el tope, esta explicitamente prohibido.

El presupuesto **se limpia al soltar el claim**, no solo al cerrar el workflow. Ese es el
camino de desatasco cuando el tope se agota con rondas productivas:

```bash
# 1. devolver la unidad (limpia cursor.visits) — ruta de panel, con sesion
curl -X POST https://APTS/api/method/pointers/<agent_name>/release \
  -H 'Content-Type: application/json' -b cookie.txt \
  -d '{"project_url":"https://github.com/org/repo","instruction":"por que se suelta"}'

# 2. devolver la story al reparto
#    update_backlog_item { backlog_item_id, status: "ready_for_dev" }
```

### La compuerta de revision

El paso terminal de `bmad-dev-story` declara **dos** outputs y los dos viajan en el mismo
`apts_submit_step`:

```json
{ "status": "done", "code_ref": "<hash del commit>",
  "title": "<titulo de la revision>", "content": "<la revision adversaria entera>" }
```

`code_review` esta marcado `required_for_close`: un submit terminal sin `output.content` se
rechaza con `ok: false` y **la story no cierra**. Eso es lo que la hace compuerta y no
adorno. Se comprueba antes de capturar y sin excepcion para `HALT`, porque la captura corre
antes que el control y un `HALT` declarado sobre el paso terminal cerraria la story igual.

El artefacto se guarda con el alcance de la **unidad** (`scope: 'story'`), no de la
iniciativa: si no, habria una sola fila de revision para todas las stories.

### Los roles

El corpus define seis roles. Cada uno se registra con `set_agent_role` ligando un
`agent_name` estable a su `entity_key`:

| `entity_key` | Persona | Donde actua |
| --- | --- | --- |
| `bmad-agent-analyst` | Mary | `analysis` |
| `bmad-agent-pm` | John | `planning` |
| `bmad-agent-architect` | Winston | `solutioning` |
| `bmad-agent-dev` | Amelia | `implementation` |
| `bmad-agent-ux-designer` | Sally | workflows opcionales de `planning` |
| `bmad-agent-tech-writer` | Paige | workflows opcionales, cualquier fase |

Un cliente solo-spec es **varios roles a la vez** y va conmutando: `apts_next` devuelve en
`role` la entidad que el paso REQUIERE, no la de quien pregunta. Si `next` es `wait` y el
`role` no coincide con la identidad que llamo, hay que volver a llamar como ese rol —el
`agent_name` que viaja en los argumentos gana a la cabecera del registro, y ese es el
mecanismo sobre el que cabalga la conmutacion—. Sin roster no hay nada que hacer: un
`entity_id` sin resolver deja a `apts_next` esperando para siempre.

### Donde vive cada pieza

| Pieza | Archivo |
| --- | --- |
| Corpus de BMAD importado | `backend/importer/corpus/*.json` |
| Siembra (upsert por clave natural, conserva UUID) | `npm run seed:method` |
| Motor: espina, reparto, saltos, completitud | `backend/scripts/lib/method_resolver.js` |
| Alta de iniciativa, roster y guardia de fase de partida | `backend/scripts/lib/method_bootstrap.js` |
| Fuente unica de "que produce cada workflow" | `backend/scripts/lib/method_outputs.js` |
| Estado por agente: fase, cursor, `visits` | tabla `project_state` |
| Definiciones y pasos sembrados | tablas `workflow_definitions`, `workflow_steps` |
| Artefactos producidos | tabla `semantic_documents` |
| Reglas de conduccion, publicadas como dato | `method_conduction` en `GET /api/public/integrar` |

`method_conduction` es la fuente autoritativa para un cliente: trae `bootstrap_rule`,
`identity_switching_rule`, `drive_loop`, `generative_step_rule` y
`dev_story_completion_rule`. Los agentes generados apuntan a el en vez de repetirlo, para
que no haya una segunda copia que se desincronice.

**Fuera de alcance, declarado:** editar `workflow_steps` desde el panel. Las instrucciones
paso a paso del metodo se cambian sembrando el corpus.

## Agentes recomendados

El generador emite cuatro agentes de integracion para cada runtime soportado, desde `integracion/paquete-apts/runtime-adapters/spec/apts-surface.json`:

- `APTS Bugfix Intake` (`apts-bugfix-intake`): triaje de bugs reportados por chat, en solo lectura hasta confirmacion, y registro trazado del bug en APTS.
- `APTS Backlog Orchestrator` (`apts-backlog-orchestrator`): toma items `ready` del backlog en APTS, crea la task de ejecucion y delega el trabajo atomico.
- `Backlog Item Executor Dev Test Commit` (`backlog-item-executor-dev-test-commit`): implementa un solo item del backlog, registra progreso en APTS, ejecuta validaciones relevantes del repositorio y solo committea si pasan.
- `APTS Method Orchestrator` (`apts-method-orchestrator`): arranca una iniciativa BMAD desde una spec de cliente y conduce el ciclo analisis → planificacion → solucion → implementacion → done.

Los cuatro agentes **los escribe el generador** (`integracion/paquete-apts/scripts/generate-adapters.js`) desde `runtime-adapters/spec/apts-surface.json`, junto con los cinco comandos, el registro MCP, los permisos y el archivo de instrucciones: no se editan a mano, se edita el spec y se regenera.

Ya no se publican como artefactos sueltos del manifiesto. Hasta el 2026-08-08 existian cuatro `agent_template` descargables, que eran una segunda copia del mismo texto y se habian separado del spec sin que nadie lo notara; se retiraron con el runtime de VS Code, que era el unico que los necesitaba. Ahora el spec tiene **un solo consumidor**, el generador, y lo que emite se comprueba regenerando y comparando. El auto-chequeo que vigilaba esas copias desaparecio con ellas: queda uno, el del contrato contra `apts_skills.json`, que aborta el arranque con `exit 3` si se han separado.

## Requisitos

- Node.js 20 o superior recomendado.
- npm.
- Google Chrome instalado localmente si se van a correr pruebas E2E con Playwright.

## Instalacion local

### 1. Instalar dependencias

Desde la raiz del repositorio:

```bash
npm run install:all
```

### 2. Configurar variables de entorno del backend

Crear o ajustar `backend/.env` con valores equivalentes a estos:

```env
PORT=47301
CORS_ORIGIN=http://localhost:47302,http://localhost:5173
SESSION_SECRET=replace-with-a-secure-secret
APTS_API_KEY=replace-with-a-secure-api-key
DASHBOARD_PASSWORD=replace-with-a-strong-password
PG_CONNECTION_STRING=postgresql://user:password@host:5432/apts
PG_TEST_CONNECTION_STRING=postgresql://user:password@host:5432/apts_test
OPENROUTER_API_KEY=replace-with-your-openrouter-key
EMBEDDING_DEFAULT_MODEL=openai/text-embedding-3-small

# Opcional: embeddings por Cloudflare Workers AI (modelos `@cf/...`)
CLOUDFLARE_API_TOKEN=replace-with-your-cloudflare-token
CLOUDFLARE_ACCOUNT_ID=replace-with-your-cloudflare-account-id
CLOUDFLARE_AI_GATEWAY_ID=default

# Opcional: alias compatible para despliegues existentes
DATABASE_URL=postgresql://user:password@host:5432/apts
```

Notas:

- APTS usa PostgreSQL por defecto en desarrollo, test y produccion.
- `backend/knexfile.js` mantiene `sqlite_legacy` solo para migrar datos historicos una vez.
- El proveedor de embeddings lo decide el identificador del modelo, no una clave aparte: los
  `@cf/...` salen por Cloudflare Workers AI y el resto por OpenRouter. `EMBEDDING_DEFAULT_MODEL`
  sustituye a `OPENROUTER_DEFAULT_EMBEDDING_MODEL`, que se sigue leyendo si ya estaba puesta.
- El token de Cloudflare necesita permiso **Workers AI: Read** sobre esa cuenta; uno valido pero sin
  ese permiso responde `401 Authentication error` a cada embedding.
- Cambiar de modelo cambia la dimension del vector: los que ya estan guardados dejan de ser
  comparables y hay que rehacerlos (`npm run reembed:bugs`, `npm run reindex:semantic`).

### Migracion one-shot desde SQLite legacy

Si tienes datos historicos en `backend/apts.db` y ya configuraste PostgreSQL:

```bash
cd backend
npx knex migrate:latest
npm run migrate:sqlite-legacy-to-pg -- --truncate-target
```

`--truncate-target` es opcional y se recomienda solo para una primera carga limpia.

Ademas, al iniciar el backend en PostgreSQL, APTS ejecuta un bootstrap automatico:

- detecta `backend/apts.db` (perfil `sqlite_legacy`),
- copia registros a PostgreSQL con upsert,
- elimina el archivo SQLite solo si la copia fue correcta,
- y realiza backfill de embeddings para bugs abiertos que aun no tengan embedding.

### 3. Ejecutar migraciones y sembrar el metodo

```bash
cd backend
npx knex migrate:latest
npm run seed:method
```

`seed:method` siembra la biblioteca del metodo BMAD (entities, workflow definitions y steps) por upsert contra la clave natural, asi que re-sembrar el mismo corpus no mueve los UUID. Para el destino de prueba existe `npm run seed:method:test`.

### 4. Levantar el proyecto

Desde la raiz:

```bash
npm run dev
```

Servicios por defecto:

- Backend: `http://localhost:47301`
- Frontend: `http://localhost:47302`

## Ejecucion por partes

### Backend solamente

```bash
cd backend
node index.js
```

### Frontend solamente

```bash
cd frontend
npm run dev
```

## Dashboard humano

El login del dashboard usa `DASHBOARD_PASSWORD` y crea una sesion HTTP con cookie. El frontend consume endpoints protegidos como:

- `GET /api/dashboard/overview`
- `GET /api/dashboard/projects`
- `GET /api/dashboard/projects/:url`
- `GET /api/dashboard/projects/:url/backlog`
- `POST /api/dashboard/projects/:url/backlog`
- `PATCH /api/dashboard/backlog/:id`
- `POST /api/tasks/:id/resolve`

## Scripts utiles

- `npm run dev`: backend y frontend en paralelo.
- `npm run install:all`: instala dependencias en raiz, backend y frontend.
- `node scripts/test_agent_api.js`: prueba el flujo de skills contra el backend local.
- `node scripts/test_agent_api_batch.js`: valida operaciones batch (status, logs, heartbeat, backlog) y modo estricto all-or-nothing.
- `npm run test:api:batch`: alias para ejecutar el smoke batch de API.
- `node simulate_apts_data.js`: genera trafico de ejemplo para poblar el dashboard.

## Testing

### Smoke test de API

Con el backend corriendo:

```bash
node scripts/test_agent_api.js
```

### Smoke test de API batch

Con el backend corriendo:

```bash
node scripts/test_agent_api_batch.js
```

Este test cubre operaciones batch mutantes y valida rollback completo cuando se usa `strict=true`.

### E2E del frontend

Seguir las reglas de `AGENTS.md`:

- No ejecutar `npx playwright install`.
- Usar el Chrome local del sistema.
- Ejecutar el backend en modo `test` con `PG_TEST_CONNECTION_STRING` para no tocar la base de desarrollo.

En PowerShell:

```powershell
npm run test:e2e:prepare
npm run test:e2e:backend
```

Estos scripts fuerzan el modo test automaticamente:

- `test:e2e:prepare`: ejecuta migraciones en entorno `test` con `knex --env test`.
- `test:e2e:backend`: arranca backend con `NODE_ENV=test`.

En otra terminal:

```bash
cd frontend
npx playwright test
```

## Como integrar otros proyectos con APTS

Esta es la parte importante si quieres que otros repositorios reporten actividad a este servicio.

> **Si prefieres leerlo en el navegador:** el propio servicio publica esta misma guia en HTML,
> renderizada desde el manifiesto en vivo, en `GET /api/public/integrar/guia`. Es el sitio al que
> mandar a alguien que quiere integrarse y no va a clonar este repositorio.

### Paso 1: registrar el MCP remoto en el proyecto integrador

1. Lee el manifiesto publico: `GET /api/public/integrar` (sin token). Su campo `human_guide`
   apunta a la version en HTML.
2. Copia el bloque de tu runtime desde `mcp_endpoint.registration_by_runtime` al archivo de configuracion correspondiente (`.mcp.json` para Claude Code, `opencode.json` para opencode). La URL del endpoint ya viene embebida en el bloque.
3. Define en el `.env` del proyecto cliente (o en tu gestor de secretos) los valores que ese bloque referencia:

```env
APTS_API_KEY=replace-with-the-shared-api-key
APTS_PROJECT_URL=https://github.com/org/repo
APTS_AGENT_NAME=tu-agente
APTS_AGENT_EMAIL=tu-agente@example.com
```

Con eso el runtime recibe las operaciones por `tools/list`. No hay nada mas que instalar para llamarlas.

### Paso 2: agentes y comandos

Genera los adaptadores con `node integracion/paquete-apts/scripts/generate-adapters.js` y copia el directorio de tu runtime —`runtime-adapters/claude/` o `runtime-adapters/opencode/`— a la raiz del proyecto cliente, conservando las rutas relativas. Esa copia trae el registro MCP, el archivo de instrucciones, los permisos, los cuatro agentes y los cinco comandos (`apts-next`, `apts-method`, `apts-bug`, `apts-status`, `apts-resume`). Los archivos generados son gestionados: no se editan a mano.

Saltarse este paso deja el proyecto sin orquestador de metodo y sin ningun comando, y obliga a conducir el ciclo entero a mano.

Si quieres los assets sin clonar el repo, todos se sirven como artefactos del manifiesto publico (`/api/public/integrar`).

### Paso 3: el bucle de implementacion (opcional)

Con la iniciativa ya en `implementation` y las stories creadas, `apts-loop.js` mastica el
backlog solo: pregunta al motor que toca, lanza **un proceso de agente por story con
contexto limpio**, espera, y vuelve a preguntar. Para cuando el motor dice `done` o salta un
freno. No conduce las fases generativas —analysis, planning, solutioning—, que son
interactivas y paran por otros motivos; si el motor recomienda algo fuera de alcance, para y
lo dice.

El script es autocontenido (CommonJS, solo builtins de Node), asi que basta con bajar ese
archivo. Va con su manual a proposito: `--agent-cmd` es obligatorio y su forma depende del
runtime, de modo que el script sin el README no se puede usar.

```bash
curl -O https://APTS/api/public/integrar/conductor/apts-loop.js
curl -O https://APTS/api/public/integrar/conductor/README.md
```

Empieza siempre con `--dry-run`, que resuelve la primera decision e informa que lanzaria sin
ejecutar nada:

```bash
node apts-loop.js --agent-name mi-dev --dry-run \
  --agent-cmd 'claude -p "$(cat {prompt_file})" --model {model} --permission-mode acceptEdits'
```

Y despues, la corrida real:

```bash
node apts-loop.js \
  --agent-name mi-dev \
  --agent-cmd 'claude -p "$(cat {prompt_file})" --model {model} --permission-mode acceptEdits' \
  --model-escalation 'claude-sonnet-5,claude-opus-5' \
  --max-iterations 20
```

**En Windows** el `$(cat ...)` no existe —`shell: true` resuelve a `cmd.exe`—, asi que la
forma equivalente es `type {prompt_file} | claude -p --model {model}`. Para opencode:
`opencode run -m {model} -f {prompt_file} "Implementa la unidad descrita en el archivo
adjunto"`, que ni siquiera mete el prompt en la linea de shell.

Lo que hay que saber antes de lanzarlo:

- **`--agent-name` debe ser la identidad registrada como rol dev en el roster**
  (`set_agent_role`) y tiene que ser la misma entre vueltas: es el puntero que sostiene el
  claim de la story. Si no lo es, el motor devuelve `wait` nombrando el rol que falta y el
  conductor para con codigo 11.
- **La identidad cae al entorno** (`APTS_MCP_URL`, `APTS_API_KEY`, `APTS_PROJECT_URL`,
  `APTS_AGENT_NAME`, `APTS_AGENT_EMAIL`) y el entorno cae a un `.env` (`--dotenv`, por
  defecto el del directorio actual). El agente hereda ese entorno, asi que de ahi saca su
  propia configuracion MCP sin repetirla en el comando.
- **El conductor no reclama stories**: `apts_status` es de solo lectura. El claim lo hace el
  agente al arrancar, que es quien va a sostenerlo.
- **No guarda estado propio** —lo tiene el motor—, asi que matarlo y relanzarlo es seguro y
  retoma donde estaba.
- La plantilla de prompt por defecto viene dentro; `--prompt-file` permite otra. La que
  exige la revision adversaria en tres subagentes paralelos se publica como artefacto
  (`conductor/prompts/dev-story-revision-adversaria.md`). La compuerta del motor aplica se
  use o no.

Frenos y codigos de salida, resumidos (el detalle esta en el README del conductor):

| Freno | Por defecto | Que detecta |
| --- | --- | --- |
| `--max-iterations` | 50 | tope duro contra un bucle desbocado |
| `--max-stalls` | 2 | vueltas seguidas sin que cambie nada del estado del metodo |
| guarda de alcance | `bmad-dev-story` | el motor pide un paso que este conductor no conduce |
| escalera de modelo | 1 intento | el proceso del agente termino distinto de 0 |

`0` done · `1` configuracion · `2` red · `10` blocked · `11` wait · `12` fuera de alcance ·
`13` estancado · `14` tope de iteraciones · `15` detenido desde el panel · `20` el agente
fallo · `21` la CLI del agente agoto su limite de uso · `22` el `--agent-cmd` no existe ·
`23` la CLI del agente no tiene credenciales.

Del 21 al 23 el que fallo no es el agente sino su entorno, y por eso no se gasta la escalera
de modelos: un limite de uso es de la CUENTA y no del modelo, asi que reintentar con otro no
puede salir distinto.

Ademas late cada cinco minutos mientras el agente trabaja, copia su diario a `agent_logs`, y
sondea un buzon de ordenes cada diez segundos para que el panel pueda pausarlo, reanudarlo o
detenerlo. Sin `--project-url` ni `--agent-cmd` no falla: se queda esperando ordenes
(`--daemon`).

Importante: si APTS cambia endpoints, payloads o manejo de errores, el ajuste debe reflejarse primero en `integracion/paquete-apts/apts_skills.json`. El auto-chequeo del arranque aborta si la superficie remota se separa del contrato.

### Contrato operativo minimo

La fuente formal para parametros y tipos vive en `integracion/paquete-apts/apts_skills.json`, y es la unica: no hay una segunda referencia en prosa que pueda contradecirla.

Campos obligatorios mas comunes:

| Campo | Lo usan |
| --- | --- |
| `project_url` | `register_task`, `create_backlog_item`, `heartbeat`, `log_agent_progress`, `report_blocker`, `update_task_status` |
| `url` | `read_project_context`, `list_backlog_items`, `search_similar_bug_reports` |
| `agent_name` | `register_task`, `heartbeat`, `log_agent_progress`, `report_blocker`, `update_task_status` |
| `agent_email` | `register_task`, `update_task_status` |
| `branch` | `log_agent_progress` |
| `task_id` | `heartbeat`, `log_agent_progress`, `report_blocker`, `update_task_status` |
| `backlog_item_id` | `register_task` cuando ejecuta un item trazado, `update_backlog_item`, `delete_backlog_item` |

Regla de backlog:

- Si no existe un backlog item activo que describa exactamente el cambio a realizar, crear uno nuevo.
- Si existe uno activo que ya cubre exactamente ese alcance, reutilizarlo.
- Para bugs, errores o regresiones reportadas por chat, buscar primero un `bug` no eliminado y crear uno solo si no hay coincidencia.
- Para chores pequenos, aplicar la misma regla exacta en lugar de decidir solo por tamano.

Happy path operativo:

1. Registrar el MCP remoto copiando el bloque del manifiesto y configurar los valores que referencia (`APTS_API_KEY` y las tres de identidad); luego usar las tools con payloads minimos.
2. Llamar `list_backlog_items` y decidir si reutilizas o creas item.
3. Llamar `register_task` y conservar `task_id`.
4. Llamar `read_project_context` antes de editar.
5. Mientras trabajas, alternar `heartbeat` y `log_agent_progress`.
6. Si quedas bloqueado, usar `report_blocker` y detenerte.
7. Cerrar con `update_task_status` a `review` primero y a `done` solo despues de review y actividad reciente.

Payloads minimos listos para copiar:

```json
{
  "create_backlog_item": {
    "title": "Documentar payloads minimos de APTS"
  },
  "register_task": {
    "title": "Documentar payloads minimos de APTS"
  },
  "read_project_context": {
    "limit": 5
  },
  "heartbeat": {
    "task_id": "22222222-2222-2222-2222-222222222222"
  },
  "log_agent_progress": {
    "message": "Se documentaron ejemplos listos para copiar."
  },
  "update_task_status": {
    "status": "review"
  }
}
```

Seguridad en mutaciones:

- En `update_backlog_item` / `delete_backlog_item` usar siempre `backlog_item_id` (nunca `id`).
- Para texto largo o de alto riesgo, aplicar updates por etapas: primero un campo minimo (por ejemplo `status`), luego el contenido completo tras confirmar la primera llamada.
- Volver a leer el backlog item o la tarea tras cada llamada mutante y verificar que los campos persistidos coinciden con lo esperado.

Errores frecuentes:

| Error | Que suele significar | Que revisar primero | Reintentar |
| --- | --- | --- | --- |
| `INVALID_ARGUMENT` | Falta un campo obligatorio, UUID invalido, enum invalido o JSON mal formado. | Payload contra `apts_skills.json`. | No. |
| `401` / `403` | API key ausente o invalida. | `APTS_API_KEY` y cabecera bearer. | No. |
| `404` | Ruta o recurso incorrecto. | `task_id`, `backlog_item_id` y la URL del registro MCP. | No, salvo stale id verificable. |
| `429` | Rate limit. | Politica de reintentos y frecuencia. | Si, maximo 2 veces. |
| Error de red / `5xx` | Falla temporal del servicio o conectividad. | Reachability y salud de APTS. | Si, maximo 2 veces. |

#### Si tu runtime no puede registrar un servidor MCP

Es un problema de configuracion que se resuelve con el operador; no hay superficie alternativa recomendada. Los endpoints REST existen y mapean 1:1 con las operaciones (ver la tabla de **Skills disponibles**), pero no construyas wrappers paralelos por runtime: si falta una capacidad, se agrega primero a `apts_skills.json` y se regeneran los adaptadores.

### Paso 4: instalar el prompt en el proyecto integrador

Ademas de las skills, el agente necesita una instruccion de trabajo consistente. La forma mas simple es agregar un archivo `AGENTS.md` en la raiz del proyecto integrador; los dos runtimes soportados lo leen, y en Claude Code el `CLAUDE.md` generado no hace mas que importarlo.

Nota importante: APTS no instala por defecto estas piezas como customizacion activa del propio repositorio; publica el material como artefactos del manifiesto y en `integracion/paquete-apts/`. En el proyecto cliente, las instrucciones y prompts obligan el flujo de trabajo del agente, y las llamadas las ejecutan las tools del servidor MCP remoto registrado (nada de wrappers HTTP propios).

Prompt recomendado para proyectos integrados con APTS:

```md
Eres un agente de desarrollo integrado con APTS a traves del servidor MCP remoto registrado.

La identidad (project_url, agent_name, agent_email) viaja en las cabeceras del registro:
no ejecutes comandos de pre-vuelo para resolverla ni la inventes en los payloads. Si a una
llamada le falta algo, el servidor la rechaza nombrando el campo: es un problema de
configuracion del operador, no un valor a adivinar.

Reglas obligatorias:
1. Lee backlog del proyecto (`list_backlog_items`) y toma un item apto para ejecucion.
2. Si no tienes task_id, usa `register_task` (incluyendo `backlog_item_id` cuando exista;
   si ese item ya tiene una tarea activa, APTS la reanuda en vez de duplicarla).
3. Antes de modificar codigo, usa `read_project_context`.
4. Mientras trabajas, envia `heartbeat` periodicamente.
5. Cada hito importante debe registrarse con `log_agent_progress`, incluyendo `branch`.
6. Si no puedes continuar, usa `report_blocker` y deten el trabajo.
7. Al terminar, usa `update_task_status` con `review` primero; `done` solo tras revision
   y con actividad reciente.
```

### Paso 5: estructura recomendada para un proyecto cliente

```text
mi-proyecto/
  AGENTS.md
  .github/
    prompts/
      apts-operacion.prompt.md
  .mcp.json
  .env
```

### Troubleshooting: el runtime no reconoce los agentes

Si copiaste el directorio de tu runtime y los agentes no aparecen:

1. Comprueba que copiaste el directorio ENTERO conservando rutas relativas: los agentes van en `.claude/agents/` o `.opencode/agent/`, y los comandos en `.claude/commands/` o `.opencode/command/`.
2. El frontmatter YAML de cada archivo debe ser valido (bloque `---`, con `description`).
3. `apts_skills.json` solo define las operaciones; no instala agentes.
4. Regenera con `node integracion/paquete-apts/scripts/generate-adapters.js` si editaste el spec: los adaptadores no se editan a mano.

### Paso 6: validacion de la integracion

1. Levanta APTS localmente o usa una instancia compartida.
2. Desde el proyecto cliente, ejecuta `register_task`.
3. Ejecuta `log_agent_progress` para un hito simple.
4. Abre el dashboard y confirma que el proyecto y la tarea aparecen.
5. Simula un `heartbeat` y luego un `update_task_status`.

## Recomendaciones de despliegue

- Mantener `APTS_API_KEY` fuera del repositorio y gestionarla por secretos del entorno.
- Usar PostgreSQL en produccion.
- Definir `CORS_ORIGIN` de forma explicita.
- Cambiar `SESSION_SECRET` y `DASHBOARD_PASSWORD` por valores fuertes.
- Exponer el backend detras de un proxy o gateway si se va a usar en equipo.

## Limites actuales

- Si un runtime no puede registrar servidores MCP remotos, no hay superficie alternativa recomendada: se resuelve la configuracion del runtime con el operador.
- Los adaptadores generados cubren los dos runtimes soportados: Claude Code y opencode.

El estado al dia de la superficie de integracion, con lo verificado y lo abierto, vive en `integracion/ESTADO.md`.