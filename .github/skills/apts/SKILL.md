---
name: apts
description: 'Integra un proyecto con APTS. Use when adding agent tracking, installing APTS skills or prompts, wiring register_task, read_project_context, log_agent_progress, heartbeat, report_blocker, or update_task_status against the APTS API.'
argument-hint: 'Describe el proyecto cliente y el tipo de integracion que quieres con APTS'
user-invocable: true
---

# APTS Integration Skill

Este skill empaqueta los recursos minimos para conectar un proyecto cliente con APTS sin tener que reconstruir el flujo desde cero.

## Cuando usarlo

- Cuando un proyecto quiera reportar trabajo de agentes a APTS.
- Cuando necesites copiar un cliente HTTP base para las 6 skills.
- Cuando quieras instalar instrucciones o prompts para que el agente siga el flujo de APTS.
- Cuando necesites el contrato JSON de las tools en un formato descargable junto al skill.

## Que incluye

- [Contrato de API](./references/api-contract.md)
- [Contrato JSON de skills](./assets/apts_skills.json)
- [Cliente HTTP de ejemplo](./assets/apts-client.js)
- [Guia base para AGENTS.md o copilot-instructions.md](./assets/apts-agent-guidelines.md)

## Procedimiento recomendado

1. Revisa el [contrato de API](./references/api-contract.md) para confirmar variables, endpoints y payloads.
2. Copia [apts_skills.json](./assets/apts_skills.json) al proyecto cliente si tu runtime soporta function calling o tool schemas.
3. Copia [apts-client.js](./assets/apts-client.js) al proyecto cliente si necesitas un wrapper HTTP listo para usar.
4. Copia [apts-agent-guidelines.md](./assets/apts-agent-guidelines.md) a `AGENTS.md` o a `.github/copilot-instructions.md` del proyecto cliente.
5. Configura `APTS_BASE_URL` y `APTS_API_KEY` en el entorno del proyecto cliente.
6. Valida la integracion ejecutando `register_task`, luego `log_agent_progress` y despues `heartbeat`.

## Resultado esperado

El proyecto cliente queda con:

- un contrato consistente de tools para APTS,
- una capa HTTP reutilizable,
- y una instruccion operativa para que los agentes reporten trabajo de forma uniforme.