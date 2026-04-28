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
3. Crear o actualizar backlog en APTS (incluyendo soft-delete cuando corresponda).
4. Crear tarea si no hay `task_id`.
5. Reportar progreso en cada hito importante.
6. Enviar heartbeat mientras la tarea siga activa.
7. Reportar blocker si el agente queda detenido.
8. Cerrar la tarea con `done` o `review`.

## Politica anti-loop de reintentos

- No reintentar en `400`, `401`, `403` o `404`.
- Reintentar solo ante errores de red, `429` y `5xx`.
- Limitar a 2 reintentos por operacion.
- Si tras los reintentos sigue fallando, reportar blocker y detener ejecucion.

## Regla de invocacion del cliente oficial

- Usar payload JSON con forma de contrato para cada operacion (contract-first).
- Para compatibilidad hacia atras, el cliente oficial puede aceptar firmas posicionales legadas en algunas funciones, pero la forma recomendada y estable es siempre objeto JSON.

## Cobertura esperada del cliente oficial

- El cliente oficial de APTS (`apts-client.js` o `apts-client.mjs`) debe cubrir todas las operaciones de integracion publicadas en este contrato y en `apts_skills.json`.
- Un proyecto cliente integrado no deberia necesitar desarrollar scripts adicionales para cubrir operaciones base de APTS.

## Validacion minima

1. Ejecutar `register_task`.
2. Ejecutar `log_agent_progress`.
3. Ejecutar `heartbeat`.
4. Confirmar en el dashboard de APTS que la tarea aparece con actividad.