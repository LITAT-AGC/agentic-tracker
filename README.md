# APTS - Agentic Project Tracking Service

APTS es un servicio de seguimiento de proyectos orientado a agentes de IA. En lugar de depender solo del contexto del chat o de comentarios dispersos en el codigo, APTS centraliza backlog, tareas de ejecucion, estados, heartbeats, bloqueos y logs tecnicos detras de un endpoint MCP remoto (con una API REST equivalente por debajo), con un dashboard web para supervision humana.

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

Ademas, el backend publica un punto de entrada publico para agentes en `/api/public/integrar`. Ese endpoint devuelve un manifiesto JSON con el bloque de registro del MCP remoto por runtime, el bucle de conduccion del metodo como dato (`method_conduction`), los artefactos opcionales (contrato de skills, guia operativa, plantillas de agentes, spec de superficie y generador de adaptadores) y un bloque `bootstrap` que explica el proposito de APTS, la migracion desde tracking local y como solicitar y alojar `APTS_API_KEY`. No requiere token.

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

## Agentes recomendados

El generador emite cuatro agentes de integracion para cada runtime soportado, desde `integracion/paquete-apts/runtime-adapters/spec/apts-surface.json`:

- `APTS Bugfix Intake` (`apts-bugfix-intake`): triaje de bugs reportados por chat, en solo lectura hasta confirmacion, y registro trazado del bug en APTS.
- `APTS Backlog Orchestrator` (`apts-backlog-orchestrator`): toma items `ready` del backlog en APTS, crea la task de ejecucion y delega el trabajo atomico.
- `Backlog Item Executor Dev Test Commit` (`backlog-item-executor-dev-test-commit`): implementa un solo item del backlog, registra progreso en APTS, ejecuta validaciones relevantes del repositorio y solo committea si pasan.
- `APTS Method Orchestrator` (`apts-method-orchestrator`): arranca una iniciativa BMAD desde una spec de cliente y conduce el ciclo analisis → planificacion → solucion → implementacion → done.

Las cuatro plantillas son artefactos publicados del manifiesto y **las escribe el generador** (`integracion/paquete-apts/scripts/generate-adapters.js`) desde `runtime-adapters/spec/apts-surface.json`: no se editan a mano; el arranque del backend aborta si divergen del spec.

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

### Paso 1: registrar el MCP remoto en el proyecto integrador

1. Lee el manifiesto publico: `GET /api/public/integrar` (sin token).
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

### Paso 2b (opcional): el bucle de implementacion

Con la iniciativa ya en `implementation`, `integracion/conductor/apts-loop.js` mastica las stories solo: un proceso de agente por story con contexto limpio, hasta que el motor dice `done` o salta un freno. Lee antes su README (`integracion/conductor/README.md`), que tambien se publica como artefacto: `--agent-cmd` es obligatorio y su forma depende del runtime. No conduce las fases generativas, que son interactivas.

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

### Paso 3: instalar el prompt en el proyecto integrador

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

### Paso 4: estructura recomendada para un proyecto cliente

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

### Paso 5: validacion de la integracion

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