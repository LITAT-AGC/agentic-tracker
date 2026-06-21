# Contrato de Integracion con APTS

## Variables de entorno requeridas

```env
APTS_BASE_URL=http://localhost:47301/api
APTS_API_KEY=replace-with-the-shared-api-key
```

Todas las llamadas de agentes deben incluir:

```http
Authorization: Bearer <APTS_API_KEY>
```

## Uso recomendado para Agentes de IA

Superficie unica:

1. MCP oficial (`apts-mcp.js`): unica superficie soportada, con una tool nativa por operacion (Claude Code y opencode).
2. Cliente crudo (`apts-client.js`) solo dentro del entrypoint MCP empaquetado.

Si el runtime no puede registrar un servidor MCP, es un problema de configuracion del runtime que se resuelve con el operador; APTS ya no publica un CLI ni ninguna superficie de script alternativa.

Reglas obligatorias:

- Usar las tools MCP en cualquier runtime soportado.
- Nunca generar codigo nuevo por interaccion que importe o bootstrapee el cliente crudo desde cero.
- Nunca construir JSON a mano con concatenacion cuando puedes pasar objetos.
- Dejar que el servidor MCP oficial resuelva identidad y contexto local antes de intentar rellenar campos manualmente.

## Resolucion de identidad

Regla anti-friccion: cuando uses el servidor MCP oficial, no hagas pre-pasos manuales para obtener identidad Git en cada llamada. Envia payload minimo y deja que la capa oficial autocomplemente.

En el servidor MCP oficial APTS, los campos de identidad se autocompletan cuando faltan en el payload usando este orden: variables de entorno -> contexto local gestionado -> Git local.

```env
APTS_PROJECT_URL=https://github.com/org/repo
APTS_AGENT_NAME=Copilot
APTS_AGENT_EMAIL=copilot@example.com
APTS_BRANCH=main
APTS_TASK_ID=22222222-2222-2222-2222-222222222222
APTS_CONTEXT_FILE=.apts/execution-context.json
```

`APTS_TASK_ID` lets the official client omit `task_id` in repeated execution calls such as `heartbeat`, `log_agent_progress`, `report_blocker`, and `update_task_status`.
`APTS_CONTEXT_FILE` can override where the official client stores managed execution context used for automatic field resolution.
`APTS_ENV_FILE` can point the official client to a specific env file when the runtime does not execute from the project root.

By default, the official client persists execution context in `.apts/execution-context.json` and uses it as an additional fallback source after env variables. Inspect or edit that file directly to review or reset the managed identity state.

Fallback Git cuando no existen esas variables:

```bash
project_url=$(git remote get-url origin)
agent_name=$(git config user.name)
agent_email=$(git config user.email)
branch=$(git branch --show-current)
```

Si llamas la API HTTP sin pasar por el servidor MCP oficial, debes enviar explicitamente todos los campos requeridos por endpoint.

## Campos comunes obligatorios

La tabla refleja campos obligatorios a nivel de API. El servidor MCP oficial puede completar los campos de identidad automaticamente.

| Campo | Operaciones |
| --- | --- |
| `project_url` | `register_task`, `create_backlog_item`, `heartbeat`, `log_agent_progress`, `report_blocker`, `update_task_status` |
| `url` | `read_project_context`, `list_backlog_items`, `search_similar_bug_reports`, `get_project_constraints` |
| `agent_name` | `register_task`, `heartbeat`, `log_agent_progress`, `report_blocker`, `update_task_status` |
| `agent_email` | `register_task`, `update_task_status` |
| `branch` | `log_agent_progress` |
| `task_id` | `heartbeat`, `log_agent_progress`, `report_blocker`, `update_task_status` |
| `backlog_item_id` | `register_task` cuando se enlaza ejecucion a backlog, `get_backlog_item`, `update_backlog_item`, `delete_backlog_item` |

## Regla explicita para crear o reutilizar backlog

- Si no hay un backlog item activo que describa exactamente el cambio actual, crear uno nuevo.
- Si ya existe un item activo que cubre exactamente el mismo alcance, reutilizarlo.
- Para bugs, errores o regresiones reportadas por chat, primero ejecutar triage en modo lectura para validar que sea un defecto real y buscar un item `bug` no eliminado equivalente.
- Si el mensaje podria ser solo una pregunta, aclaracion o diagnostico, no asumir que es un bug reportable: pedir confirmacion antes de registrarlo en APTS.
- Si no hay confirmacion explicita del usuario para registrar o tratar ese caso como bug, no crear ni actualizar el item `bug` ni registrar trabajo todavia; devolver confirmacion pendiente.
- Crear/actualizar el item `bug` y registrar tarea de ejecucion solo despues de la confirmacion explicita del usuario.
- Para chores pequenos, reutilizar solo cuando el item activo ya cubra exactamente ese ajuste documental o de mantenimiento.

## Endpoints

### Modo batch (nuevo)

- En operaciones mutantes, APTS acepta un objeto JSON unico o un array JSON no vacio de objetos.
- Cuando se envia un array, la respuesta devuelve resultados por item.
- Si hay mezcla de exitos y errores en batch, el servidor puede responder `207 Multi-Status` con detalle por indice.
- Modo estricto opcional: agregar `?strict=true` en la ruta batch para ejecutar all-or-nothing con rollback total ante el primer fallo.

### 1. register_task

- Metodo: `POST`
- Ruta: `/projects/tasks`
- Body: objeto unico o array de objetos `register_task`
- Comportamiento de reanudacion: cuando se envia `backlog_item_id` y ese backlog item ya tiene una `active_task_id` en estado `todo`, `in_progress` o `stalled`, APTS reanuda esa tarea en lugar de crear una duplicada.
- Respuesta incluye: `task_id`, `status`, `resumed`, `previous_task_id`, `previous_status`, `backlog_item_id`.
- Payload obligatorio: `project_url`, `title`, `agent_name`, `agent_email`
- Payload minimo recomendado con cliente/MCP oficial: solo `title` (los campos de identidad se autocompletan).
- Body minimo:

```json
{
  "title": "Implementar autenticacion"
}
```

### 2. read_project_context

- Metodo: `GET`
- Ruta: `/projects/context?url=<project_url>&limit=5`
- Query minima: `url`
- Query minima recomendada con cliente/MCP oficial: `{}` (url autocompletada).
- Query params opcionales:
  - `backlog_status=<draft|needs_details|ready|in_progress|review|blocked|done|archived>`
  - `include=<tasks|backlog|logs>` o lista separada por comas (`include=tasks,backlog`) para devolver solo secciones necesarias
  - `view=<full|compact>` para devolver resumenes compactos y omitir textos largos, contexto completo de tareas y `technical_details` completos de logs
- Default actual para agentes e integraciones oficiales: `compact`.
- Recomendacion para agentes: usar el default compacto y volver a leer en `view=full` solo cuando haga falta detalle bruto.

Ejemplo:

```json
{
  "url": "https://github.com/org/repo",
  "limit": 5,
  "backlog_status": "in_progress",
  "view": "compact"
}
```

### 2b. list_backlog_items

- Metodo: `GET`
- Ruta base: `/projects/backlog?url=<project_url>`
- Query minima: `url`
- Query params opcionales:
  - `id=<uuid>` para filtrar un backlog item especifico
  - `ids=<uuid,uuid,...>` para filtrar multiples backlog items
  - `status=<draft|needs_details|ready|in_progress|review|blocked|done|archived>`
  - `include_deleted=true` para incluir items eliminados por soft-delete
  - `limit=<int>` y `offset=<int>` para paginacion basica
  - `view=<full|compact>` para listar solo campos resumen cuando todavia no necesitas descripciones completas ni criterios de aceptacion
- Default actual para agentes e integraciones oficiales: `compact`.
- Recomendacion para agentes: usar el default compacto durante loops de seleccion o deduplicacion y escalar a `full` solo para el item elegido o cuando falte contexto.

Ejemplo:

```json
{
  "url": "https://github.com/org/repo",
  "status": "ready",
  "limit": 20,
  "offset": 0,
  "view": "compact"
}
```

### 2g. get_backlog_item

- Metodo: `GET`
- Ruta: `/backlog/:id`
- Query params opcionales:
  - `view=<full|compact>` (default `full`)
  - `include_deleted=true`
- Objetivo: obtener un unico backlog item completo sin listar todo el backlog.

Ejemplo:

```json
{
  "backlog_item_id": "11111111-1111-1111-1111-111111111111",
  "view": "full"
}
```

### 2h. get_task

- Metodo: `GET`
- Ruta: `/tasks/:id`
- Query params opcionales:
  - `view=<full|compact>` (default `full`)
  - `limit=<int>` para limitar logs asociados (default 20)
- Objetivo: obtener una tarea individual con estado/contexto, heartbeats recientes y logs asociados.

Ejemplo:

```json
{
  "task_id": "22222222-2222-2222-2222-222222222222",
  "view": "full",
  "limit": 20
}
```

### 2i. get_project_constraints

- Metodo: `GET`
- Ruta: `/projects/:url/constraints`
- Payload minimo en cliente/MCP oficial: `{}` (url auto-resuelta) o `{ "url": "https://github.com/org/repo" }`
- Respuesta sugerida:

```json
{
  "project_url": "https://github.com/org/repo",
  "test_command": "npm test",
  "lint_command": "npm run lint",
  "typecheck_command": "npm run typecheck",
  "framework": "express",
  "language": "javascript",
  "conventions": "..."
}
```

### 2c. create_backlog_item

- Metodo: `POST`
- Ruta: `/projects/backlog`
- Body: objeto unico o array de objetos `create_backlog_item`
- Intake recomendado para bugs desde chat: si la solicitud actual describe un bug, error o regresion nueva, primero listar backlog para buscar un item `bug` existente; si no existe, crear uno con `item_type: "bug"`, documentar sintoma, comportamiento esperado, comportamiento observado y evidencia disponible, y usar `source_kind: "chat_request"` con `source_ref` cuando el runtime exponga un identificador estable.
- Si la solicitud es "reporta esto como BUG en APTS", crear o reutilizar directamente el item `bug` sin depender de agentes de intake dedicados.
- Si la solicitud es "reporta esto que has solucionado como bug resuelto en APTS", actualizar el item `bug` con `update_backlog_item`, moverlo a `review` o `done`, y adjuntar resumen de resolucion y evidencia de validacion.
- Payload obligatorio: `project_url`, `title`
- Body minimo:

```json
{
  "project_url": "https://github.com/org/repo",
  "title": "Definir onboarding inicial"
}
```

### 2f. search_similar_bug_reports

- Metodo: `POST`
- Ruta: `/projects/backlog/semantic-search`
- Body: objeto `search_similar_bug_reports`
- Objetivo: encontrar bugs similares semanticamente para evitar duplicados en intake.
- Payload minimo: `url`, `query_text`
- Campos opcionales:
  - `top_k` (1..20, default 5)
  - `threshold` (0..1, default 0.78)
  - `include_closed` (default false)
  - `exclude_backlog_item_id` (UUID)

Ejemplo:

```json
{
  "url": "https://github.com/org/repo",
  "query_text": "Error 500 al guardar backlog desde dashboard",
  "top_k": 5,
  "threshold": 0.78,
  "include_closed": false
}
```

### 2d. update_backlog_item

- Metodo: `PATCH`
- Ruta single: `/backlog/:id`
- Ruta batch: `/backlog`
- Body batch: objetos con `backlog_item_id` y campos a actualizar.
- Payload obligatorio: `backlog_item_id`

Ejemplo:

```json
{
  "backlog_item_id": "11111111-1111-1111-1111-111111111111",
  "status": "review"
}
```

### 2e. delete_backlog_item (soft-delete)

- Metodo: `DELETE`
- Ruta single: `/backlog/:id`
- Ruta batch: `/backlog`
- Body batch: objetos con `backlog_item_id`.
- Comportamiento: marca el item como eliminado logicamente. Por defecto no aparece en listados salvo que se pida `include_deleted=true`.
- Payload obligatorio: `backlog_item_id`

### 3. update_task_status

- Metodo: `PATCH`
- Ruta single: `/tasks/:id/status`
- Ruta batch: `/tasks/status`
- Estados soportados: `todo`, `in_progress`, `review`, `done`, `stalled`
- Regla de transicion: `done` solo se acepta desde `review`.
- Regla de cierre robusto: para pasar a `done` debe existir actividad reciente de ejecucion (heartbeat o log de progreso reciente).
- Payload obligatorio: `task_id`, `status`, `project_url`, `agent_name`, `agent_email`

Ejemplo:

```json
{
  "task_id": "22222222-2222-2222-2222-222222222222",
  "status": "review",
  "project_url": "https://github.com/org/repo",
  "agent_name": "Copilot",
  "agent_email": "copilot@example.com"
}
```

### 4. log_agent_progress

- Metodo: `POST`
- Ruta single: `/tasks/:id/logs`
- Ruta batch: `/tasks/logs`
- `technical_details` puede incluir `files_modified`, `commands_run` y `outcome`
- Payload obligatorio: `task_id`, `project_url`, `agent_name`, `branch`, `message`

Ejemplo:

```json
{
  "task_id": "22222222-2222-2222-2222-222222222222",
  "project_url": "https://github.com/org/repo",
  "agent_name": "Copilot",
  "branch": "main",
  "message": "Se agregaron ejemplos listos para copiar.",
  "technical_details": {
    "files_modified": [
      "README.md"
    ],
    "commands_run": [
      "npm test"
    ],
    "outcome": "success"
  }
}
```

### 5. report_blocker

- Metodo: `POST`
- Ruta: `/projects/blockers`
- Body: objeto unico o array de objetos `report_blocker`
- Payload obligatorio: `project_url`, `task_id`, `error_message`, `agent_name`

Ejemplo:

```json
{
  "project_url": "https://github.com/org/repo",
  "task_id": "22222222-2222-2222-2222-222222222222",
  "error_message": "No puedo continuar hasta recibir APTS_API_KEY.",
  "agent_name": "Copilot"
}
```

### 6. heartbeat

- Metodo: `POST`
- Ruta single: `/tasks/:id/heartbeat`
- Ruta batch: `/tasks/heartbeat`
- Payload obligatorio: `task_id`, `agent_name`, `project_url`

Ejemplo:

```json
{
  "task_id": "22222222-2222-2222-2222-222222222222",
  "agent_name": "Copilot",
  "project_url": "https://github.com/org/repo"
}
```

## Flujo operativo recomendado

1. Registrar el servidor MCP (`apts-mcp.js`) en el runtime y usar sus tools nativas como unica via.
2. Si el runtime no puede registrar un servidor MCP, resolver la configuracion del runtime con el operador; no hay superficie alternativa.
3. Empezar con payload minimo y dejar que el MCP resuelva identidad automaticamente.
4. Listar backlog y decidir si reutilizar item existente o crear uno nuevo usando la regla de alcance exacto.
5. Si la solicitud actual es un bugfix, error o regresion reportada por chat, verificar si ya existe un backlog item `bug` equivalente y reutilizarlo cuando corresponda; si no existe, crearlo.
6. Si la solicitud es reportar un bug ya solucionado, actualizar ese item `bug` a `review` o `done` con evidencia de resolucion y validacion.
7. Crear o reanudar tarea con `register_task` usando `backlog_item_id` cuando aplique.
8. Leer `read_project_context` antes de editar.
9. Reportar progreso en cada hito importante.
10. Enviar heartbeat mientras la tarea siga activa.
11. Reportar blocker si el agente queda detenido.
12. Cerrar primero en `review`; pasar a `done` solo desde `review` y con actividad reciente de ejecucion.

## Ejemplos via MCP

Las operaciones se invocan como tools nativas del servidor MCP (`register_task`, `read_project_context`, `heartbeat`, `log_agent_progress`, `update_task_status`, `report_blocker`, ...), tomando el `inputSchema` del contrato. Llama cada tool con un objeto JSON minimo y deja que el cliente autocomplete identidad y contexto:

- `register_task` -> `{"title":"Documentar payloads minimos de APTS"}`
- `read_project_context` -> `{}`
- `heartbeat` -> `{}`
- `log_agent_progress` -> `{"message":"Se actualizaron las guias de integracion."}`
- `update_task_status` -> `{"status":"review"}`
- `report_blocker` -> `{"error_message":"Falta APTS_API_KEY"}`

## opencode.ai: MCP y Skills

- Registra el servidor MCP en `opencode.json` (`mcp`) apuntando a `node .ia/apts/apts-mcp.js`; es la unica superficie soportada.
- opencode soporta MCP, asi que esta es la via correcta; si no puede registrarse, resuelve la configuracion del runtime con el operador.
- Expon `SKILL.md` y `apts_skills.json` bajo `.agents/skills/apts` para discovery.

## Seguridad en mutaciones

1. Campo correcto en update/delete de backlog: usar siempre `backlog_item_id` y nunca `id`.
2. Para texto largo o de alto riesgo, aplicar update por etapas: primero un campo minimo (por ejemplo `status`), luego el contenido completo tras confirmar la primera llamada.
3. Validacion final obligatoria: volver a leer el backlog item o la tarea y verificar que los campos persistidos coinciden con lo esperado, en lugar de confiar solo en que la llamada devolvio exito.

## Politica anti-loop de reintentos

- No reintentar en `400`, `401`, `403` o `404`.
- Reintentar solo ante errores de red, `429` y `5xx`.
- Limitar a 2 reintentos por operacion.
- Si tras los reintentos sigue fallando, reportar blocker y detener ejecucion.

## Errores frecuentes

| Error | Significado | Revisar primero | Reintentar |
| --- | --- | --- | --- |
| `INVALID_ARGUMENT` | Falta campo obligatorio, enum invalido, UUID invalido o JSON mal formado. | Comparar payload contra `apts_skills.json`. | No. |
| `401` / `403` | API key ausente o invalida. | `APTS_API_KEY` y cabecera bearer. | No. |
| `404` | Ruta o recurso no encontrado. | `task_id`, `backlog_item_id` y base URL. | No, salvo referencia stale verificable. |
| `429` | Rate limit. | Frecuencia y politica de backoff. | Si, hasta 2 veces. |
| Error de red / `5xx` | Falla temporal de servicio o conectividad. | Reachability y estado de APTS. | Si, hasta 2 veces. |

## Regla de invocacion del cliente oficial

- Usar payload JSON con forma de contrato para cada operacion (contract-first).
- Para compatibilidad hacia atras, el cliente oficial puede aceptar firmas posicionales legadas en algunas funciones, pero la forma recomendada y estable es siempre objeto JSON.
- Para agentes, la unica superficie es el servidor MCP (`apts-mcp.js`), que vive en `.ia/apts/` junto al cliente unico (`apts-client.js`, ESM).
- El cliente crudo solo debe quedar dentro del entrypoint MCP empaquetado; nunca generar codigo nuevo que lo bootstrapee en cada interaccion.
- Al migrar al servidor MCP oficial, retirar wrappers o scripts propios viejos (incluido cualquier `apts-cli.js` previo) que solo proxyeen operaciones base de APTS.

## Cobertura esperada del cliente oficial

- El cliente oficial de APTS (`apts-client.js`, ESM-only) debe exportar exactamente las operaciones publicadas en este contrato y en `apts_skills.json`.
- El servidor MCP (`apts-mcp.js`) expone esas mismas operaciones; su tabla de tools se deriva del contrato y `contract-check.js` aborta si hay desalineacion.
- Un proyecto cliente integrado no deberia necesitar desarrollar scripts adicionales para cubrir operaciones base de APTS.

## Anti-patrones

- Instanciar o bootstrapear `apts-client.*` manualmente desde snippets generados por el agente en cada conversacion.
- Armar JSON a mano con concatenacion de strings cuando puedes pasar objetos o archivos.
- Hacer pre-flight de identidad Git antes de cada llamada en lugar de dejar que el servidor MCP oficial resuelva el contexto.
- Llamar al HTTP raw para operaciones base cuando el servidor MCP ya cubre el contrato.

## Validacion minima

1. Ejecutar `register_task`.
2. Ejecutar `log_agent_progress`.
3. Ejecutar `heartbeat`.
4. Confirmar en el dashboard de APTS que la tarea aparece con actividad.