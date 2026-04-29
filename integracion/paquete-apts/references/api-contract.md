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

## Identidad que el agente debe resolver desde Git

```bash
project_url=$(git remote get-url origin)
agent_name=$(git config user.name)
agent_email=$(git config user.email)
branch=$(git branch --show-current)
```

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
- Body minimo:

```json
{
  "project_url": "https://github.com/org/repo",
  "title": "Implementar autenticacion",
  "agent_name": "Copilot",
  "agent_email": "agent@example.com"
}
```

### 2. read_project_context

- Metodo: `GET`
- Ruta: `/projects/context?url=<project_url>&limit=5`

### 2b. list_backlog_items

- Metodo: `GET`
- Ruta base: `/projects/backlog?url=<project_url>`
- Query params opcionales:
  - `status=<draft|needs_details|ready|in_progress|review|blocked|done|archived>`
  - `include_deleted=true` para incluir items eliminados por soft-delete

### 2c. create_backlog_item

- Metodo: `POST`
- Ruta: `/projects/backlog`
- Body: objeto unico o array de objetos `create_backlog_item`
- Intake recomendado para bugs desde chat: si la solicitud actual describe un bug, error o regresion nueva, primero listar backlog para buscar un item `bug` existente; si no existe, crear uno con `item_type: "bug"`, documentar sintoma, comportamiento esperado, comportamiento observado y evidencia disponible, y usar `source_kind: "chat_request"` con `source_ref` cuando el runtime exponga un identificador estable.
- Si el runtime soporta agentes custom y esta instalada la plantilla `APTS Bugfix Intake`, usarla como entrypoint para este paso de intake antes de pasar a implementacion.
- Body minimo:

```json
{
  "project_url": "https://github.com/org/repo",
  "title": "Definir onboarding inicial"
}
```

### 2d. update_backlog_item

- Metodo: `PATCH`
- Ruta single: `/backlog/:id`
- Ruta batch: `/backlog`
- Body batch: objetos con `backlog_item_id` y campos a actualizar.

### 2e. delete_backlog_item (soft-delete)

- Metodo: `DELETE`
- Ruta single: `/backlog/:id`
- Ruta batch: `/backlog`
- Body batch: objetos con `backlog_item_id`.
- Comportamiento: marca el item como eliminado logicamente. Por defecto no aparece en listados salvo que se pida `include_deleted=true`.

### 3. update_task_status

- Metodo: `PATCH`
- Ruta single: `/tasks/:id/status`
- Ruta batch: `/tasks/status`
- Estados soportados: `todo`, `in_progress`, `review`, `done`, `stalled`
- Regla de transicion: `done` solo se acepta desde `review`.
- Regla de cierre robusto: para pasar a `done` debe existir actividad reciente de ejecucion (heartbeat o log de progreso reciente).

### 4. log_agent_progress

- Metodo: `POST`
- Ruta single: `/tasks/:id/logs`
- Ruta batch: `/tasks/logs`
- `technical_details` puede incluir `files_modified`, `commands_run` y `outcome`

### 5. report_blocker

- Metodo: `POST`
- Ruta: `/projects/blockers`
- Body: objeto unico o array de objetos `report_blocker`

### 6. heartbeat

- Metodo: `POST`
- Ruta single: `/tasks/:id/heartbeat`
- Ruta batch: `/tasks/heartbeat`

## Flujo operativo recomendado

1. Resolver identidad desde Git.
2. Leer contexto y backlog del proyecto.
3. Si la solicitud actual es un bugfix, error o regresion reportada por chat, verificar si ya existe un backlog item `bug` equivalente y reutilizarlo cuando corresponda.
4. Crear o actualizar backlog en APTS (incluyendo soft-delete cuando corresponda). Para defectos nuevos, crear primero el item `bug` antes de implementar.
5. Crear o reanudar tarea con `register_task` usando `backlog_item_id` cuando aplique.
6. Reportar progreso en cada hito importante.
7. Enviar heartbeat mientras la tarea siga activa.
8. Reportar blocker si el agente queda detenido.
9. Cerrar primero en `review`; pasar a `done` solo desde `review` y con actividad reciente de ejecucion.

## Politica anti-loop de reintentos

- No reintentar en `400`, `401`, `403` o `404`.
- Reintentar solo ante errores de red, `429` y `5xx`.
- Limitar a 2 reintentos por operacion.
- Si tras los reintentos sigue fallando, reportar blocker y detener ejecucion.

## Regla de invocacion del cliente oficial

- Usar payload JSON con forma de contrato para cada operacion (contract-first).
- Para compatibilidad hacia atras, el cliente oficial puede aceptar firmas posicionales legadas en algunas funciones, pero la forma recomendada y estable es siempre objeto JSON.
- Si el runtime prefiere invocacion por terminal en lugar de imports, usar la CLI oficial (`apts-cli.js` o `apts-cli.mjs`) junto a su cliente gemelo en la misma carpeta (`apts-client.js` o `apts-client.mjs`).
- Al migrar al cliente o CLI oficial, retirar wrappers o scripts propios viejos que solo proxyeen operaciones base de APTS.

## Cobertura esperada del cliente oficial

- El cliente oficial de APTS (`apts-client.js` o `apts-client.mjs`) debe cubrir todas las operaciones de integracion publicadas en este contrato y en `apts_skills.json`.
- La CLI oficial de APTS (`apts-cli.js` o `apts-cli.mjs`) debe exponer esas mismas operaciones como comandos estables sin obligar al proyecto cliente a crear wrappers ad-hoc.
- Un proyecto cliente integrado no deberia necesitar desarrollar scripts adicionales para cubrir operaciones base de APTS.

## Validacion minima

1. Ejecutar `register_task`.
2. Ejecutar `log_agent_progress`.
3. Ejecutar `heartbeat`.
4. Confirmar en el dashboard de APTS que la tarea aparece con actividad.