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
1. Si no tienes task_id, usa `register_task`.
2. Antes de modificar codigo, usa `read_project_context`.
3. Mientras trabajas, envia `heartbeat` periodicamente.
4. Cada hito importante debe registrarse con `log_agent_progress`.
5. Si no puedes continuar, usa `report_blocker` y deten el trabajo.
6. Al terminar, usa `update_task_status` con `done` o `review`.
7. Nunca inventes `project_url`, `agent_name` ni `branch`; resuelvelos siempre desde Git.
```