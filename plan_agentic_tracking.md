# Plan de Implementación: Agentic Project Tracking Service (APTS)

## 1. Visión General
El **Agentic Project Tracking Service (APTS)** es una plataforma diseñada para que los agentes de inteligencia artificial (IA) puedan registrar, actualizar y consultar el estado de los proyectos en los que trabajan de manera autónoma. A diferencia de un tracker tradicional (como Jira o Trello) diseñado para humanos, APTS expone "Skills" (APIs) optimizadas para el consumo programático por LLMs, manteniendo una interfaz gráfica de solo lectura o gestión de alto nivel para los supervisores humanos.

## 2. Arquitectura del Sistema
El sistema sigue una arquitectura cliente-servidor estándar, adaptada para integrarse sin fricción con los flujos de los agentes:

*   **Backend:** Node.js (Vanilla JS) usando Express o Fastify. Ligero, asíncrono y fácil de extender.
*   **Base de Datos:** SQLite (desarrollo) → PostgreSQL (producción). La capa de datos se abstrae completamente mediante **Knex ORM**, por lo que el cambio de motor requiere únicamente modificar `knexfile.js` sin tocar ninguna query.
*   **ORM / Query Builder:** `knex` + driver `better-sqlite3` para SQLite o `pg` para Postgres. Las migraciones se gestionan con `knex migrate:latest`.
*   **Frontend (Dashboard Humano):** Vue 3 (Composition API) + Vue Router + Tailwind CSS + PrimeVue + ECharts + Pinia. Estilo visual premium, reactivo y enrutado seguro.
*   **Capa de Integración de Agentes:** Un conjunto de descripciones de herramientas (JSON Schemas) que se proporcionarán a los LLMs para que entiendan cómo interactuar con el backend.
*   **Autenticación (Agentes):** Token de API compartido (variable de entorno `APTS_API_KEY`). El agente lo incluye en la cabecera `Authorization: Bearer <token>`.
*   **Autenticación (Dashboard):** Protección mediante contraseña única definida en `.env`. El backend gestionará la sesión utilizando cookies de forma segura con `express-session`.
*   **Seguridad y Rate Limiting:** Implementación de control de tráfico para proteger la estabilidad (ej. usando `express-rate-limit`):
    *   **Login Limiter (Estricto):** Muy sensible, para prevenir ataques de fuerza bruta en la ruta `/login`.
    *   **API Limiter (Protección Anti-Bugs):** Más permisivo, aplicado a las "Skills". Su objetivo principal es frenar *loops* infinitos en caso de que un LLM se trabe y empiece a espamear llamadas.
    *   **Soporte Proxy / Cloudflare:** El backend estará configurado para leer las IPs reales a través de proxies (`app.set('trust proxy', 1)`), utilizando cabeceras como `CF-Connecting-IP` o `X-Forwarded-For` para aplicar los bloqueos correctamente a los clientes y no a los nodos de Cloudflare.
    *   **CORS Dinámico:** Los orígenes permitidos se controlarán mediante variables de entorno (ej. `CORS_ORIGIN`). Esto permite aceptar tráfico de `localhost:5173` en desarrollo, y limitarlo al dominio de producción al estar en línea. Se configurará con `credentials: true` para permitir el tráfico de las cookies de sesión.

## 3. Especificación del Modelo de Datos

> Las tablas se definen como **migraciones Knex** (`knex migrate:make <name>`), no como SQL raw. Esto garantiza la portabilidad SQLite → PostgreSQL y el versionado del esquema en el repositorio.

Se proponen **dos tablas principales + schema de log** para cubrir todos los casos de uso:

```js
// migrations/001_create_projects.js
exports.up = (knex) => knex.schema.createTable('projects', (t) => {
  // PK = URL normalizada a HTTPS sin .git
  // git@github.com:org/repo.git  →  https://github.com/org/repo
  t.string('url').primary();
  t.string('name').notNullable();
  t.text('description');
  t.enu('status', ['pending','active','blocked','stalled','completed'])
   .notNullable().defaultTo('pending');
  t.string('webhook_url');          // Slack/Discord, opcional por proyecto
  t.timestamps(true, true);         // created_at, updated_at
});
exports.down = (knex) => knex.schema.dropTable('projects');

// migrations/002_create_tasks.js
exports.up = (knex) => knex.schema.createTable('tasks', (t) => {
  t.uuid('id').primary().defaultTo(knex.fn.uuid());
  t.string('project_url').notNullable()
   .references('url').inTable('projects').onDelete('CASCADE');
  t.string('title').notNullable();
  t.string('agent_name');           // git config user.name
  t.string('agent_email');          // git config user.email
  t.enu('status', ['todo','in_progress','review','done','stalled'])
   .notNullable().defaultTo('todo');
  t.text('context');
  t.datetime('last_heartbeat');     // Última señal de vida del agente
  t.timestamps(true, true);
});
exports.down = (knex) => knex.schema.dropTable('tasks');

// migrations/003_create_agent_logs.js
exports.up = (knex) => knex.schema.createTable('agent_logs', (t) => {
  t.increments('id');
  t.uuid('task_id').references('id').inTable('tasks').onDelete('SET NULL');
  t.enu('action_type', ['read','write','update','error','heartbeat']);
  t.string('agent_name');           // git config user.name
  t.string('branch');               // git branch --show-current
  t.text('message').notNullable();
  t.jsonb('technical_details');     // schema estructurado (ver abajo)
  t.timestamps(true, true);
});
exports.down = (knex) => knex.schema.dropTable('agent_logs');
```

> **Cambio de motor:** para pasar a PostgreSQL basta con editar `knexfile.js`:
> ```js
> // knexfile.js
> module.exports = {
>   development: { client: 'better-sqlite3', connection: { filename: './apts.db' } },
>   production:  { client: 'pg',             connection: process.env.DATABASE_URL },
> };
> ```

### Schema de `technical_details` (contrato mínimo)

```json
{
  "files_modified": ["src/index.js", "package.json"],
  "commands_run":   ["npm install", "npm run build"],
  "outcome":        "success"
}
```
> Todos los campos son opcionales, pero si se incluye `outcome`, debe ser `"success"` o `"failure"`.

## 4. Detalles Funcionales y "Skills" (APIs)

Los agentes interactuarán con el sistema a través de las siguientes herramientas (Skills). Cada skill se traduce en un endpoint REST.

> **Convención de identidad del agente:** el agente NUNCA declara su nombre manualmente. Lo resuelve desde el entorno local antes de invocar cualquier skill:
> ```bash
> project_url  = $(git remote get-url origin)   # normalizado a HTTPS sin .git
> agent_name   = $(git config user.name)         # identidad del operador
> agent_email  = $(git config user.email)        # email de confirmación
> branch       = $(git branch --show-current)    # rama activa
> ```
> Si el proyecto no existe aún en la DB, el backend lo crea automáticamente (upsert). La `project_url` es **normalizada por el backend** antes de guardar, por lo que `git@github.com:org/repo.git` y `https://github.com/org/repo` se tratan como el mismo proyecto.

> **Autenticación:** todas las llamadas deben incluir la cabecera `Authorization: Bearer <APTS_API_KEY>`.

### Skill 0: `register_task` *(nuevo)*
*   **Descripción:** Crea una nueva tarea en el proyecto. Necesaria cuando un agente arranca desde cero y aún no tiene `task_id`.
*   **Endpoint:** `POST /api/projects/tasks`
*   **Input del Agente:** `project_url`, `title`, `agent_name`, `agent_email`, `context` (opcional).
*   **Respuesta:** `{ task_id, status }` — el agente almacena este `task_id` para todas las llamadas subsiguientes.
*   **Acción del Backend:** Upsert del proyecto + INSERT de la tarea con `status = 'in_progress'`.

### Skill 1: `read_project_context`
*   **Descripción:** Permite al agente entender el estado actual del proyecto, las tareas pendientes y la historia reciente.
*   **Endpoint:** `GET /api/projects/context?url=<project_url_encoded>&limit=<N>`
*   **Input del Agente:** `project_url` (obtenido de `git remote get-url origin`). Parámetro opcional `limit` (por defecto: 5) para controlar cuántos logs recientes se incluyen.
*   **Respuesta:** Un resumen consolidado en JSON con las tareas activas y los últimos `N` logs.

### Skill 2: `update_task_status`
*   **Descripción:** El agente informa que ha cambiado de fase (ej. empezó a trabajar, o terminó y requiere revisión humana).
*   **Endpoint:** `PATCH /api/tasks/:id/status`
*   **Input del Agente:** `task_id`, `status` (in_progress, done, review), `project_url`, `agent_name`, `agent_email`.
*   **Acción del Backend:** Actualiza el registro de la tarea y emite un evento WebSocket para actualizar el dashboard de Vue. Si el proyecto tiene `webhook_url` configurada, dispara la notificación saliente.

### Skill 3: `log_agent_progress`
*   **Descripción:** La herramienta más usada. El agente deja un comentario sobre lo que acaba de implementar, un bug que arregló o una decisión arquitectónica que tomó.
*   **Endpoint:** `POST /api/tasks/:id/logs`
*   **Input del Agente:** `task_id`, `project_url`, `agent_name`, `branch`, `message` (resumen), `technical_details` (opcional, ver schema en sección 3).
*   **Beneficio:** Genera un historial de desarrollo inmutable con trazabilidad de rama y archivos afectados.

### Skill 4: `report_blocker`
*   **Descripción:** Skill de emergencia. Si el agente no puede continuar (falla de dependencias, permisos denegados, requerimientos ambiguos), usa esta herramienta.
*   **Endpoint:** `POST /api/projects/blockers`
*   **Input del Agente:** `project_url`, `task_id`, `error_message`, `agent_name`.
*   **Acción del Backend:** Cambia el estado del proyecto a `blocked`, envía alerta visual al dashboard y dispara el `webhook_url` del proyecto si está configurado.

### Skill 5: `heartbeat` *(nuevo)*
*   **Descripción:** Señal de vida periódica. El agente la envía cada ~5 minutos mientras trabaja. Si el backend no recibe un heartbeat en más de 15 minutos, marca la tarea como `stalled` y alerta al equipo humano.
*   **Endpoint:** `POST /api/tasks/:id/heartbeat`
*   **Input del Agente:** `task_id`, `agent_name`, `project_url`.
*   **Acción del Backend:** Actualiza `tasks.last_heartbeat = NOW()`. Un job interno verifica periódicamente las tareas sin heartbeat reciente.

## 5. El Frontend (Dashboard Vue 3)

El panel de control humano no necesita ser complejo, pero sí altamente reactivo y estéticamente "premium".
*   **Autenticación y Login:** Pantalla de login inicial (`/login`) que solicita un texto (contraseña) validada contra la variable en el `.env` del backend. Almacena la sesión de forma segura usando cookies.
*   **Enrutamiento:** Se utilizará **Vue Router** para gestionar las vistas y permitir que la página se pueda refrescar con normalidad en el navegador manteniendo el estado de la sesión.
*   **Centro de Mando (Overview & Métricas):** Vista inicial de alto nivel (`/dashboard/overview`) con tarjetas de KPIs (Proyectos Activos, Bloqueados, Agentes Stalled). Se utilizará **Apache ECharts** (mediante `vue-echarts`) por su alto rendimiento y animaciones fluidas para renderizar gráficas de estado. Incluirá un buscador global y filtros para poder ver el Kanban/Feed de un solo proyecto o agente específico.
*   **Vista Principal (Kanban):** Un tablero con las tareas. Las tarjetas se mueven automáticamente cuando un agente invoca `update_task_status`.
*   [x] **Resolución de Bloqueos (Intervención Activa):** Las tarjetas en estado `blocked` incluirán una acción para "Resolver". El usuario humano podrá ingresar instrucciones de desbloqueo, las cuales el backend adjuntará al `context` de la tarea, regresando su estado a `todo` para que el agente reanude el trabajo.
*   [x] **Vista de Actividad (Live Feed):** Un timeline lateral similar a una terminal de logs donde van apareciendo los mensajes que los agentes envían a través de `log_agent_progress`. Cada entrada muestra el `agent_name`, la `branch` y el `outcome` del `technical_details`.
*   [x] **Auditoría de Código (Panel Lateral):** Los logs del feed que posean `technical_details` serán interactivos. Al hacer clic, se abrirá un *Drawer* (panel lateral) desplegando de forma clara los archivos afectados y comandos ejecutados por el agente.
*   **Indicador de Stalled:** Las tarjetas de tareas sin heartbeat reciente muestran un ícono de advertencia y cambian a color ámbar para alertar al supervisor.
*   **Estética (Tailwind CSS):** Construido apoyándose en clases utilitarias de **Tailwind CSS** para agilizar el diseño. Tema oscuro elegante, colores de estado vibrantes y tipografía moderna.

## 6. Estrategia de Pruebas (Testing E2E Obligatorio)

Para asegurar la calidad del sistema, el agente **debe desarrollar pruebas E2E por cada funcionalidad** que implemente:
*   **Backend:** Scripts de prueba en Node.js para invocar y validar que los endpoints de la API y las operaciones en la base de datos funcionan según lo esperado.
*   **Frontend:** Automatización E2E utilizando **Playwright**.
    *   **Restricción de Instalación:** Playwright debe instalarse **sin descargar los navegadores web por defecto** (ej. ejecutando con `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`).
    *   **Ejecución:** En la configuración de Playwright, se debe especificar explícitamente el uso del **Google Chrome instalado en la máquina local** del usuario (ej. utilizando `channel: 'chrome'` o configurando el `executablePath`).

## 7. Fases de Desarrollo

*   **Fase 1: Core del Backend**
    *   [x] Inicializar proyecto Node.js e instalar `knex`, `better-sqlite3` (dev) y `pg` (prod).
    *   [x] Crear `knexfile.js` con perfiles `development` (SQLite) y `production` (Postgres).
    *   [x] Escribir y ejecutar las migraciones: `knex migrate:latest`.
    *   [x] Implementar los endpoints REST principales usando el query builder de Knex.
*   **Fase 2: Frontend Estructural**
    *   [x] Inicializar Vue 3 con Vite y PrimeVue.
    *   [x] Crear los servicios HTTP para consumir la API.
    *   [x] Diseñar el layout base, el componente de "Live Feed" y la tabla/kanban de tareas.
*   **Fase 3: Refinamiento de Skills**
    *   [x] Definir los esquemas de llamadas a funciones (Function Calling schemas) que se le proporcionarán a los LLM.
    *   [x] Implementar la normalización de URLs en el backend.
    *   [x] Implementar el job interno de detección de tareas `stalled` (sin heartbeat).
    *   [x] Pruebas simulando peticiones locales para verificar la integridad de la base de datos.
*   **Fase 4: Prueba de Fuego (Pilotaje)**
    *   [x] Asignar una tarea real en un entorno de pruebas a un agente autónomo (Test API Simulator).
    *   [x] Verificar que el agente interactúa con los endpoints correctamente sin ayuda humana y que el dashboard refleja el estado.
    *   [x] Probar la notificación saliente a un webhook de Slack/Discord (Backend webhooks configurados).

## 8. Fase 5: Expansión del Dashboard (Gestión de Proyectos)
Para proporcionar una vista de alto nivel más allá de las tareas individuales, se implementará un módulo dedicado a la gestión global de proyectos:
*   [x] **Vista de Proyectos (DataTable):** Añadir un nuevo ítem en el menú lateral de navegación (`/dashboard/projects`) que renderice un `DataTable` de PrimeVue mostrando todos los proyectos registrados (URL, Nombre, Estado global, Webhook).
*   [x] **Inspección Profunda (Drill-down):** Al hacer clic en un renglón del DataTable, se abrirá un componente `Dialog` modal. Este diálogo contendrá otra tabla detallando todas las "operaciones" (tareas y últimos logs) asociadas a ese proyecto en específico, permitiendo auditar rápidamente el histórico completo de un repositorio.
*   [x] **Endpoint de Soporte:** Asegurar que el backend posea un endpoint optimizado (`GET /api/dashboard/projects`) que devuelva el listado tabular para alimentar la nueva vista con paginación o carga diferida si es necesario.

## 9. Bonus: Instrucción de Sistema para Agentes
Para garantizar que esto funcione, a los agentes se les debe dotar de un System Prompt estricto. Ejemplo:

> *"Eres un agente de desarrollo integrado al sistema APTS.*
>
> **PASO 0 — Resolución de identidad (obligatorio antes de cualquier skill):**
> *Ejecuta los siguientes comandos para obtener tus credenciales de sesión:*
> *- `project_url`  → `git remote get-url origin`*
> *- `agent_name`   → `git config user.name`*
> *- `agent_email`  → `git config user.email`*
> *- `branch`       → `git branch --show-current`*
> *Incluye la cabecera `Authorization: Bearer <APTS_API_KEY>` en cada llamada.*
>
> **Tu flujo de trabajo OBLIGATORIO es:**
> *0) Si no tienes `task_id`, usa `register_task` para crear tu tarea y obtenerlo.*
> *1) Ejecutar la herramienta `read_project_context` con el `project_url` resuelto para entender tu misión.*
> *2) Comenzar el desarrollo de código. Enviar un `heartbeat` cada ~5 minutos mientras trabajas.*
> *3) Cada vez que cada completes un hito, crees un archivo importante o resuelvas un bug, usa `log_agent_progress` incluyendo `branch` y `technical_details`.*
> *4) Si te encuentras bloqueado permanentemente, detente y usa `report_blocker`.*
> *5) Al terminar toda tu tarea asignada, usa `update_task_status` para marcarla como 'done'.*
>
> *Bajo ninguna circunstancia asumas contexto sin antes consultar el tracker ni inventes tu `project_url` o `agent_name` — resuélvelos siempre desde el entorno Git local."*
