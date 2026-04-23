# Contrato de Integracion con APTS

## Variables de entorno requeridas

```env
APTS_BASE_URL=http://localhost:46100/api
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

### 1. register_task

- Metodo: `POST`
- Ruta: `/projects/tasks`
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

### 3. update_task_status

- Metodo: `PATCH`
- Ruta: `/tasks/:id/status`
- Estados soportados: `todo`, `in_progress`, `review`, `done`, `stalled`

### 4. log_agent_progress

- Metodo: `POST`
- Ruta: `/tasks/:id/logs`
- `technical_details` puede incluir `files_modified`, `commands_run` y `outcome`

### 5. report_blocker

- Metodo: `POST`
- Ruta: `/projects/blockers`

### 6. heartbeat

- Metodo: `POST`
- Ruta: `/tasks/:id/heartbeat`

## Flujo operativo recomendado

1. Resolver identidad desde Git.
2. Crear tarea si no hay `task_id`.
3. Leer contexto del proyecto.
4. Reportar progreso en cada hito importante.
5. Enviar heartbeat mientras la tarea siga activa.
6. Reportar blocker si el agente queda detenido.
7. Cerrar la tarea con `done` o `review`.

## Validacion minima

1. Ejecutar `register_task`.
2. Ejecutar `log_agent_progress`.
3. Ejecutar `heartbeat`.
4. Confirmar en el dashboard de APTS que la tarea aparece con actividad.