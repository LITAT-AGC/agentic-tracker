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

Orden de preferencia:

1. CLI oficial (`apts-cli.js` / `apts-cli.mjs`)
2. Helper oficial (`apts-helper.js` / `apts-helper.mjs`) solo si el runtime no puede invocar shell de forma fiable
3. Cliente crudo (`apts-client.js` / `apts-client.mjs`) solo dentro de helpers o wrappers predefinidos del proyecto

Reglas obligatorias:

- Preferir el CLI via shell para operaciones base de APTS.
- Usar el helper oficial solo cuando el runtime no permite shell o solo admite tools importables.
- Nunca generar codigo nuevo por interaccion que importe o bootstrapee el cliente crudo desde cero.
- Nunca construir JSON a mano con concatenacion cuando puedes pasar objetos, `--stdin`, o `--json @archivo.json`.
- Dejar que el CLI/helper oficial resuelva identidad y contexto local antes de intentar rellenar campos manualmente.

## Resolucion de identidad

Regla anti-friccion: cuando uses el CLI/helper oficial, no hagas pre-pasos manuales para obtener identidad Git en cada llamada. Envia payload minimo y deja que la capa oficial autocomplemente.

En CLI/helper oficial APTS, los campos de identidad se autocompletan cuando faltan en el payload usando este orden: variables de entorno -> contexto local gestionado -> Git local.

```env
APTS_PROJECT_URL=https://github.com/org/repo
APTS_AGENT_NAME=Copilot
APTS_AGENT_EMAIL=copilot@example.com
APTS_BRANCH=main
APTS_TASK_ID=22222222-2222-2222-2222-222222222222
APTS_CONTEXT_FILE=.apts/execution-context.json
```

`APTS_TASK_ID` lets the official client/CLI omit `task_id` in repeated execution calls such as `heartbeat`, `log_agent_progress`, `report_blocker`, and `update_task_status`.
`APTS_CONTEXT_FILE` can override where official client/CLI store managed execution context used for automatic field resolution.
`APTS_ENV_FILE` can point the official CLI to a specific env file when the runtime does not execute from the project root.

By default, official client/CLI persist execution context in `.apts/execution-context.json` and use it as an additional fallback source after env variables.

CLI helpers for managed context:
- `show-execution-context` to inspect resolved context and file path.
- `set-execution-context` to persist `task_id` or identity fields once.
- `clear-execution-context` to reset local managed context.

Fallback Git cuando no existen esas variables:

```bash
project_url=$(git remote get-url origin)
agent_name=$(git config user.name)
agent_email=$(git config user.email)
branch=$(git branch --show-current)
```

Si llamas la API HTTP sin pasar por el CLI/helper oficial, debes enviar explicitamente todos los campos requeridos por endpoint.

## Campos comunes obligatorios

La tabla refleja campos obligatorios a nivel de API. El CLI/helper oficial puede completar los campos de identidad automaticamente.

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
- Payload minimo recomendado con cliente/CLI oficial: solo `title` (los campos de identidad se autocompletan).
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
- Query minima recomendada con cliente/CLI oficial: `{}` (url autocompletada).
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
- Payload minimo en cliente/CLI oficial: `{}` (url auto-resuelta) o `{ "url": "https://github.com/org/repo" }`
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
      "node .ia/apts/apts-cli.mjs help heartbeat"
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

1. Instalar el CLI oficial junto al cliente gemelo en `.ia/apts/` y usar esa superficie como via principal.
2. Si el runtime no puede shellar el CLI de forma fiable, instalar el helper oficial y usarlo como fallback seguro.
3. Empezar con payload minimo y dejar que el CLI/helper resuelva identidad automaticamente.
4. Listar backlog y decidir si reutilizar item existente o crear uno nuevo usando la regla de alcance exacto.
5. Si la solicitud actual es un bugfix, error o regresion reportada por chat, verificar si ya existe un backlog item `bug` equivalente y reutilizarlo cuando corresponda; si no existe, crearlo.
6. Si la solicitud es reportar un bug ya solucionado, actualizar ese item `bug` a `review` o `done` con evidencia de resolucion y validacion.
7. Crear o reanudar tarea con `register_task` usando `backlog_item_id` cuando aplique.
8. Leer `read_project_context` antes de editar.
9. Reportar progreso en cada hito importante.
10. Enviar heartbeat mientras la tarea siga activa.
11. Reportar blocker si el agente queda detenido.
12. Cerrar primero en `review`; pasar a `done` solo desde `review` y con actividad reciente de ejecucion.

## Ejemplos CLI-first

Usa `--output structured` cuando quieras una envoltura estable para Custom Tools o parsers de agentes.

```bash
node .ia/apts/apts-cli.mjs register-task --json '{"title":"Documentar payloads minimos de APTS"}' --output structured
node .ia/apts/apts-cli.mjs read-project-context --json '{}' --output structured
node .ia/apts/apts-cli.mjs heartbeat --json '{}' --output structured
node .ia/apts/apts-cli.mjs log-agent-progress --json '{"message":"Se actualizaron las guias de integracion."}' --output structured
node .ia/apts/apts-cli.mjs update-task-status --json '{"status":"review"}' --output structured
node .ia/apts/apts-cli.mjs report-blocker --json '{"error_message":"Falta APTS_API_KEY"}' --output structured
```

Fallback con helper oficial:

```js
import apts from './.ia/apts/apts-helper.mjs';

await apts.run('register-task', { title: 'Documentar payloads minimos de APTS' });
await apts.run('heartbeat', {});
```

## Ejemplos PowerShell

Usar here-strings o archivos temporales evita friccion por quoting inline en Windows.

```powershell
$heartbeat = @'
{
  "task_id": "22222222-2222-2222-2222-222222222222",
  "agent_name": "Copilot",
  "project_url": "https://github.com/org/repo"
}
'@

$heartbeat | node .ia/apts/apts-cli.mjs heartbeat --stdin --pretty
```

```powershell
@'
{
  "project_url": "https://github.com/org/repo",
  "title": "Documentar payloads minimos de APTS",
  "agent_name": "Copilot",
  "agent_email": "copilot@example.com"
}
'@ | Set-Content -Path register-task.json

Get-Content .\register-task.json | node .ia/apts/apts-cli.mjs register-task --stdin --pretty
```

`--json` robusto en PowerShell:

- Soporta payload inline corto.
- Soporta `--json @archivo.json` para evitar problemas de quoting en PS 5.1.
- Para payloads largos o multilinea, mantener `--stdin` como metodo principal.

Ejemplo `@archivo`:

```powershell
node .ia/apts/apts-cli.mjs get-task --json @task-query.json --pretty
```

Wrapper recomendado:

```powershell
function Invoke-AptsCli {
  param(
    [Parameter(Mandatory=$true)][string]$Command,
    [Parameter(Mandatory=$true)][string]$JsonFile,
    [switch]$Pretty
  )

  $args = @($Command, '--json', "@$JsonFile")
  if ($Pretty.IsPresent) {
    $args += '--pretty'
  }

  node .ia/apts/apts-cli.mjs @args
}
```

CLI con env file explicito:

```powershell
node .ia/apts/apts-cli.mjs show-execution-context --env-file .env --output structured
```

## opencode.ai: Custom Tools y Skills

- Instala `SKILL.md` y `apts_skills.json` en `.agents/skills/apts/` para discovery.
- Crea un Custom Tool fino que reenvie `<command>` y el payload JSON al CLI oficial, por ejemplo `node .ia/apts/apts-cli.mjs <command> --json @payload.json --output structured`.
- Si tu entorno de opencode.ai no puede invocar shell de forma fiable, implementa ese Custom Tool usando `apts-helper.mjs` o `apts-helper.js` en vez del cliente crudo.
- Mantener la logica en el CLI/helper oficial reduce errores de quoting, identidad y formato.

## Troubleshooting PowerShell (sin sorpresas)

Problemas mas comunes y regla de resolucion:

1. Campo incorrecto en update/delete de backlog: usar siempre `backlog_item_id` y no `id`.
2. Parseo roto con `--json`: empezar por payload minimo y luego escalar.
3. Here-string invalido: no usar `@' ... '@` en la misma linea con otros comandos.
4. Flujo `--stdin` colgado: validar primero con `--json` corto y luego volver a `--stdin` con archivo.
5. Texto largo con caracteres especiales: aplicar update por etapas (primero estado, luego texto completo).

Secuencia recomendada para `update-backlog-item`:

```powershell
node .ia/apts/apts-cli.mjs update-backlog-item --json '{"backlog_item_id":"11111111-1111-1111-1111-111111111111","status":"review"}' --pretty

@'
{
  "backlog_item_id": "11111111-1111-1111-1111-111111111111",
  "acceptance_criteria": "FE: estado visible y mensajes claros. BE: persistencia y validacion consistente."
}
'@ | Set-Content -Path backlog-update.json

Get-Content .\backlog-update.json | node .ia/apts/apts-cli.mjs update-backlog-item --stdin --pretty
```

Validacion final obligatoria:

- Confirmar que el comando respondio con exito.
- Volver a leer el backlog item y verificar que los campos persistidos coinciden con lo esperado.

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
- Para agentes, el camino recomendado es la CLI oficial (`apts-cli.js` o `apts-cli.mjs`) junto a su cliente gemelo en la misma carpeta (`apts-client.js` o `apts-client.mjs`).
- Si el runtime no puede usar shell, usar el helper oficial (`apts-helper.js` o `apts-helper.mjs`) junto al cliente gemelo.
- El cliente crudo solo debe quedar dentro de helpers o wrappers predefinidos; nunca generar codigo nuevo que lo bootstrapee en cada interaccion.
- Al migrar al CLI o helper oficial, retirar wrappers o scripts propios viejos que solo proxyeen operaciones base de APTS.

## Cobertura esperada del cliente oficial

- El cliente oficial de APTS (`apts-client.js` o `apts-client.mjs`) debe cubrir todas las operaciones de integracion publicadas en este contrato y en `apts_skills.json`.
- El helper oficial de APTS (`apts-helper.js` o `apts-helper.mjs`) debe exponer esas mismas operaciones como superficie importable segura y delgada.
- La CLI oficial de APTS (`apts-cli.js` o `apts-cli.mjs`) debe exponer esas mismas operaciones como comandos estables sin obligar al proyecto cliente a crear wrappers ad-hoc.
- Un proyecto cliente integrado no deberia necesitar desarrollar scripts adicionales para cubrir operaciones base de APTS.

## Anti-patrones

- Instanciar o bootstrapear `apts-client.*` manualmente desde snippets generados por el agente en cada conversacion.
- Armar JSON a mano con concatenacion de strings cuando puedes pasar objetos o archivos.
- Hacer pre-flight de identidad Git antes de cada llamada en lugar de dejar que el CLI/helper oficial resuelva el contexto.
- Llamar al HTTP raw para operaciones base cuando la CLI/helper ya cubre el contrato.

## Validacion minima

1. Ejecutar `register_task`.
2. Ejecutar `log_agent_progress`.
3. Ejecutar `heartbeat`.
4. Confirmar en el dashboard de APTS que la tarea aparece con actividad.