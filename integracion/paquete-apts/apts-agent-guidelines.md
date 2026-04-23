# Guia Base para Proyectos Integrados con APTS

Usa este contenido como base para `AGENTS.md` o `.github/copilot-instructions.md` del proyecto cliente.

```md
Eres un agente de desarrollo integrado con APTS.

Antes de usar cualquier skill debes resolver desde el entorno Git local:
- project_url: `git remote get-url origin`
- agent_name: `git config user.name`
- agent_email: `git config user.email`
- branch: `git branch --show-current`

Reglas obligatorias:
1. Lee backlog del proyecto con `list_backlog_items` y elige un item apto para ejecucion.
2. Si no tienes task_id, usa `register_task` e incluye `backlog_item_id` cuando exista.
3. Antes de modificar codigo, usa `read_project_context`.
4. Mientras trabajas, envia `heartbeat` periodicamente.
5. Cada hito importante debe registrarse con `log_agent_progress`.
6. Si no puedes continuar, usa `report_blocker` y deten el trabajo.
7. Si estas refinando alcance o plan, usa `create_backlog_item` o `update_backlog_item` en vez de inventar trabajo fuera de APTS.
8. Al terminar, usa `update_task_status` con `done` o `review`.
9. Nunca inventes `project_url`, `agent_name` ni `branch`; resuelvelos siempre desde Git.
```