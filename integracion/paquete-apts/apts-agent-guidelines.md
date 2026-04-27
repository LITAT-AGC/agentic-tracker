# Guia Base para Proyectos Integrados con APTS

Usa este contenido como base para `AGENTS.md` o `.github/copilot-instructions.md` del proyecto cliente.

```md
Eres un agente de desarrollo integrado con APTS.

Si `APTS_API_KEY` no esta disponible en el entorno del proyecto, debes solicitarla al operador humano antes de usar cualquier endpoint protegido de APTS.

Debes alojar `APTS_API_KEY` como variable de entorno o en el sistema de secretos del proyecto cliente. Nunca la hardcodees en codigo fuente, prompts versionados, archivos JSON ni documentos de backlog.

Ademas de reportar en APTS, debes mantener una bitacora local append-only de resiliencia, por ejemplo en `.apts/agent-resilience-log.jsonl`.

Esa bitacora local no es fuente de verdad y no reemplaza a APTS. Solo sirve como respaldo operativo por si APTS queda inaccesible o perdiera historial.

Registra al menos: inicio de ejecucion, hitos importantes, bloqueos, fallos de sincronizacion con APTS y cierre de tarea. Nunca guardes `APTS_API_KEY` ni otros secretos en esa bitacora.

Antes de usar cualquier skill debes resolver desde el entorno Git local:
- project_url: `git remote get-url origin`
- agent_name: `git config user.name`
- agent_email: `git config user.email`
- branch: `git branch --show-current`

Reglas obligatorias:
0. Si el usuario pide "siguiente tarea", "next task", "continuar backlog", "ejecutar backlog" o equivalentes, debes invocar primero `Orquestador Agent` y no ejecutar implementacion directa desde el agente general.
0.1. Usa el cliente oficial de APTS (`apts-client.js` o `apts-client.mjs`) como capa de integracion; no desarrolles scripts paralelos para cubrir operaciones base del contrato.
1. Lee backlog del proyecto con `list_backlog_items` y elige un item apto para ejecucion.
2. Si no tienes task_id, usa `register_task` e incluye `backlog_item_id` cuando exista.
3. Antes de modificar codigo, usa `read_project_context`.
4. Mientras trabajas, envia `heartbeat` periodicamente.
5. Cada hito importante debe registrarse con `log_agent_progress`.
6. Si no puedes continuar, usa `report_blocker` y deten el trabajo.
7. Si estas refinando alcance o plan, usa `create_backlog_item` o `update_backlog_item` en vez de inventar trabajo fuera de APTS.
8. Al terminar, usa `update_task_status` con `done` o `review`.
9. Nunca inventes `project_url`, `agent_name` ni `branch`; resuelvelos siempre desde Git.
10. Si falta `APTS_API_KEY`, deten la integracion operativa, solicitala al operador y solo continua cuando este alojada como secreto del entorno.
11. Mantiene una bitacora local append-only de resiliencia, pero no la uses para reemplazar a APTS como tracking oficial.
12. Si `Orquestador Agent` no esta instalado o no puede invocarse, debes detener la ejecucion de la tarea y pedir al operador la instalacion/correccion; no avances con un flujo alternativo sin orquestador.
```