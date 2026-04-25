# APTS - Agentic Project Tracking Service

APTS es un servicio de seguimiento de proyectos orientado a agentes de IA. En lugar de depender solo del contexto del chat o de comentarios dispersos en el codigo, APTS centraliza backlog, tareas de ejecucion, estados, heartbeats, bloqueos y logs tecnicos en una API REST pensada para automatizacion, con un dashboard web para supervision humana.

## Que incluye

- Backend en Node.js + Express + Knex.
- Base de datos SQLite para desarrollo y test, y PostgreSQL para produccion.
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

- API REST para agentes y dashboard.
- Persistencia con Knex.
- SQLite en desarrollo y test.
- PostgreSQL en produccion mediante `DATABASE_URL`.
- Autenticacion por API key para agentes.
- Sesion por cookie para dashboard humano.

### Frontend

- Login para supervisores.
- Vista Overview con metricas, tareas y feed.
- Vista Projects con drill-down por repositorio.
- Resolucion manual de bloqueos desde la UI.

### Capa de integracion de agentes

El paquete `integracion/paquete-apts/` describe las herramientas que un runtime de agentes puede exponer. Cada skill se corresponde con un endpoint REST del backend.

Importante: este repositorio publica la API y el contrato de skills, pero no incluye un servidor MCP dedicado ni un adaptador universal para todos los agentes. Cada proyecto que quiera integrarse debe cargar ese JSON en su runtime de herramientas o crear un pequeno cliente HTTP que exponga esas mismas funciones.

## Skills disponibles

El repositorio incluye un paquete descargable para proyectos clientes en `integracion/paquete-apts/`. Ese paquete agrupa el skill, un contrato JSON copiable, un cliente HTTP base y una guia de instrucciones para agentes.

Como este repositorio es publico, esos archivos se consumen directamente desde `integracion/paquete-apts/`.

Ademas, el backend puede publicar un punto de entrada publico para agentes en `/api/public/integrar`. Ese endpoint devuelve un manifiesto JSON con el orden recomendado de instalacion y enlaces descargables al contrato de skills, la guia operativa base y las plantillas opcionales de agentes, sin requerir token para el bootstrap.

Todas las llamadas de agentes deben incluir la cabecera:

```http
Authorization: Bearer <APTS_API_KEY>
```

| Skill | Metodo | Endpoint | Uso |
| --- | --- | --- | --- |
| `register_task` | POST | `/api/projects/tasks` | Crear una tarea nueva y obtener `task_id` (opcionalmente vinculada a `backlog_item_id`). |
| `read_project_context` | GET | `/api/projects/context?url=...&limit=...` | Leer backlog, tareas y logs recientes del proyecto. |
| `list_backlog_items` | GET | `/api/projects/backlog?url=...&status=...` | Listar backlog por proyecto, ordenado por prioridad y orden manual. |
| `create_backlog_item` | POST | `/api/projects/backlog` | Crear un backlog item gestionado en APTS. |
| `update_backlog_item` | PATCH | `/api/backlog/:id` | Editar estado, prioridad o contenido de un backlog item. |
| `update_task_status` | PATCH | `/api/tasks/:id/status` | Cambiar estado de una tarea. |
| `log_agent_progress` | POST | `/api/tasks/:id/logs` | Registrar progreso, decisiones o cambios tecnicos. |
| `report_blocker` | POST | `/api/projects/blockers` | Reportar bloqueo y marcar proyecto como bloqueado. |
| `heartbeat` | POST | `/api/tasks/:id/heartbeat` | Marcar actividad reciente del agente. |

## Flujo esperado de un agente

1. Resolver identidad desde Git local.
2. Consultar backlog (`list_backlog_items`) y seleccionar un item pendiente o crear uno nuevo si corresponde.
3. Crear la tarea de ejecucion con `register_task` y asociarla al `backlog_item_id`.
4. Leer el contexto del proyecto antes de trabajar (`read_project_context`).
5. Registrar progreso y enviar heartbeat mientras ejecuta la tarea.
6. Reportar blocker si no puede continuar.
7. Marcar la tarea como `done` o `review` cuando termina; APTS sincroniza el estado del backlog vinculado.

Valores que el agente debe resolver localmente antes de llamar las skills:

```bash
project_url=$(git remote get-url origin)
agent_name=$(git config user.name)
agent_email=$(git config user.email)
branch=$(git branch --show-current)
```

El backend normaliza la URL del repositorio para que valores como `git@github.com:org/repo.git` y `https://github.com/org/repo` se traten como el mismo proyecto.

## Modelo operativo backlog -> task

APTS separa la planificacion del trabajo de su ejecucion:

- `backlog_items`: trabajo planificado y priorizado por proyecto.
- `tasks`: ejecuciones concretas de agentes (una sesion de trabajo sobre un item).
- `agent_logs`: evidencia tecnica de la ejecucion.

Un backlog item puede enlazarse con una `active_task_id` mientras esta en ejecucion.

## Agentes recomendados

Este repositorio incluye plantillas de agentes de integracion en `integracion/plantillas-agentes/`:

- `Orquestador Agent` (`integracion/plantillas-agentes/orquestador-agent.md`): toma items `ready` del backlog en APTS, crea la task de ejecucion y delega el trabajo atomico.
- `Ejecutor Dev Test Commit` (`integracion/plantillas-agentes/ejecutor-dev-test-commit.agent.md`): implementa un solo item del backlog, registra progreso en APTS, ejecuta validaciones relevantes del repositorio y solo committea si pasan.

Las plantillas exportables viven en `integracion/plantillas-agentes/` y el repo ya no depende de borradores locales temporales.

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
PORT=46100
CORS_ORIGIN=http://localhost:46101,http://localhost:5173
SESSION_SECRET=replace-with-a-secure-secret
APTS_API_KEY=replace-with-a-secure-api-key
DASHBOARD_PASSWORD=replace-with-a-strong-password

# Solo en produccion
DATABASE_URL=postgres://user:password@host:5432/apts
```

Notas:

- En desarrollo y test se usa SQLite automaticamente mediante `backend/knexfile.js`.
- En produccion, `NODE_ENV=production` usa PostgreSQL con `DATABASE_URL`.

### 3. Ejecutar migraciones

```bash
cd backend
npx knex migrate:latest
```

### 4. Levantar el proyecto

Desde la raiz:

```bash
npm run dev
```

Servicios por defecto:

- Backend: `http://localhost:46100`
- Frontend: `http://localhost:46101`

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
- `node simulate_apts_data.js`: genera trafico de ejemplo para poblar el dashboard.

## Testing

### Smoke test de API

Con el backend corriendo:

```bash
node scripts/test_agent_api.js
```

### E2E del frontend

Seguir las reglas de `AGENTS.md`:

- No ejecutar `npx playwright install`.
- Usar el Chrome local del sistema.
- Ejecutar el backend en modo `test` para no tocar la base de desarrollo.

En PowerShell:

```powershell
cd backend
$env:NODE_ENV="test"
npx knex migrate:latest
node index.js
```

En otra terminal:

```bash
cd frontend
npx playwright test
```

## Como integrar otros proyectos con APTS

Esta es la parte importante si quieres que otros repositorios reporten actividad a este servicio.

### Paso 1: apuntar el proyecto integrador al servicio APTS

En el proyecto cliente define al menos estas variables de entorno en tu runtime de agentes, CI o wrapper local:

```env
APTS_BASE_URL=http://localhost:46100/api
APTS_API_KEY=replace-with-the-shared-api-key
```

Si el servicio APTS esta desplegado en otro host, reemplaza la URL base por la correspondiente.

### Paso 2: instalar las skills en el proyecto integrador

Tienes dos opciones validas.

Si quieres una base lista para descargar, copia directamente la carpeta `integracion/paquete-apts/` de este repositorio al proyecto cliente y reutiliza sus assets.

#### Opcion A: tu runtime soporta esquemas JSON o function calling

1. Copia `integracion/paquete-apts/apts_skills.json` a tu proyecto integrador, por ejemplo en `tools/apts_skills.json`.
2. Registra cada skill en tu runtime usando el mismo nombre y parametros.
3. Haz que cada tool invoque el endpoint HTTP correspondiente en APTS.
4. Adjunta siempre `Authorization: Bearer <APTS_API_KEY>`.

Mapeo recomendado:

| Skill | Endpoint backend |
| --- | --- |
| `register_task` | `POST {APTS_BASE_URL}/projects/tasks` |
| `read_project_context` | `GET {APTS_BASE_URL}/projects/context?url=...&limit=...` |
| `list_backlog_items` | `GET {APTS_BASE_URL}/projects/backlog?url=...&status=...` |
| `create_backlog_item` | `POST {APTS_BASE_URL}/projects/backlog` |
| `update_backlog_item` | `PATCH {APTS_BASE_URL}/backlog/:id` |
| `update_task_status` | `PATCH {APTS_BASE_URL}/tasks/:id/status` |
| `log_agent_progress` | `POST {APTS_BASE_URL}/tasks/:id/logs` |
| `report_blocker` | `POST {APTS_BASE_URL}/projects/blockers` |
| `heartbeat` | `POST {APTS_BASE_URL}/tasks/:id/heartbeat` |

#### Opcion B: tu runtime no soporta importar JSON directamente

Implementa un adaptador pequeno en el proyecto cliente que exponga funciones con esos mismos nombres y haga `fetch` al backend de APTS.

Ejemplo minimo en Node.js:

```js
const baseUrl = process.env.APTS_BASE_URL;
const headers = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${process.env.APTS_API_KEY}`,
};

async function register_task(payload) {
  const res = await fetch(`${baseUrl}/projects/tasks`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  return res.json();
}
```

Con ese patron puedes implementar las skills y publicarlas como herramientas del agente que use tu equipo.

### Paso 3: instalar el prompt en el proyecto integrador

Ademas de las skills, el agente necesita una instruccion de trabajo consistente. La forma mas simple es agregar un archivo `AGENTS.md` en la raiz del proyecto integrador o, si tu stack lo prefiere, usar `.github/copilot-instructions.md` o el mecanismo de system/developer prompt de tu runtime.

Si el proyecto integrador usa VS Code con GitHub Copilot, la recomendacion practica es esta:

- Instrucciones globales del proyecto: `AGENTS.md` o `.github/copilot-instructions.md`
- Prompts reutilizables para tareas puntuales: `.github/prompts/*.prompt.md`
- Skills nativos de VS Code/Copilot: `.github/skills/<nombre>/SKILL.md`

Nota importante: APTS no instala por defecto estas piezas como customizacion activa del propio repositorio. Lo que publica hoy es un paquete de integracion en `integracion/paquete-apts/`. Por eso, para integrarse con APTS, un proyecto cliente normalmente hace una de estas dos cosas:

1. Usa instrucciones y prompts para obligar el flujo de trabajo del agente, y un wrapper local o MCP para ejecutar las llamadas HTTP.
2. Crea un skill propio del proyecto que internamente invoque la API de APTS.

Prompt recomendado para proyectos integrados con APTS:

```md
Eres un agente de desarrollo integrado con APTS.

Antes de usar cualquier skill debes resolver desde el entorno Git local:
- project_url: `git remote get-url origin`
- agent_name: `git config user.name`
- agent_email: `git config user.email`
- branch: `git branch --show-current`

Reglas obligatorias:
1. Lee backlog del proyecto (`list_backlog_items`) y toma un item apto para ejecucion.
2. Si no tienes task_id, usa `register_task` (incluyendo `backlog_item_id` cuando exista).
3. Antes de modificar codigo, usa `read_project_context`.
4. Mientras trabajas, envia `heartbeat` periodicamente.
5. Cada hito importante debe registrarse con `log_agent_progress`.
6. Si no puedes continuar, usa `report_blocker` y deten el trabajo.
7. Al terminar, usa `update_task_status` con `done` o `review`.
8. Nunca inventes `project_url`, `agent_name` ni `branch`; resuelvelos siempre desde Git.
```

### Paso 4: estructura recomendada para un proyecto cliente

```text
mi-proyecto/
  AGENTS.md
  .github/
    prompts/
      apts-operacion.prompt.md
  tools/
    apts_skills.json
  scripts/
    apts-client.js
  .env
```

Si el equipo quiere empaquetarlo como skill nativo de VS Code/Copilot, una variante valida es esta:

```text
mi-proyecto/
  .github/
    copilot-instructions.md
    prompts/
      apts-operacion.prompt.md
    skills/
      apts/
        SKILL.md
        apts-client.js
```

En ese caso, el `SKILL.md` del proyecto cliente debe describir cuando usar la skill y delegar la operacion al cliente HTTP o al bridge que habla con APTS.

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

- No hay servidor MCP oficial en este repositorio.
- No hay paquete NPM cliente publicado aun.
- La instalacion final de skills en proyectos clientes sigue dependiendo del runtime del agente que use cada equipo, aunque este repo ya incluye un paquete base exportable en `integracion/paquete-apts/`.

## Proximo paso natural

Si quieres que la integracion sea casi plug-and-play para otros repositorios, el siguiente paso recomendable es crear un adaptador MCP o un cliente NPM que cargue `integracion/paquete-apts/apts_skills.json` y traduzca automaticamente cada tool a llamadas HTTP contra APTS.