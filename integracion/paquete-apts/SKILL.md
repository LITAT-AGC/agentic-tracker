---
name: apts
description: 'Integra un proyecto con APTS. Use when adding agent tracking, installing APTS skills or prompts, wiring register_task, read_project_context, log_agent_progress, heartbeat, report_blocker, or update_task_status against the APTS API.'
argument-hint: 'Describe el proyecto cliente y el tipo de integracion que quieres con APTS'
user-invocable: true
---

# APTS Integration Skill

Este skill empaqueta los recursos minimos para conectar un proyecto cliente con APTS sin tener que reconstruir el flujo desde cero.

Nota: en este repositorio se publica como material de integracion en la carpeta raiz `integracion/paquete-apts/` para evitar confundirlo con customizaciones activas del propio proyecto APTS.

## Cuando usarlo

- Cuando un proyecto quiera reportar trabajo de agentes a APTS.
- Cuando necesites copiar un cliente HTTP oficial que cubra todas las skills publicadas para integracion.
- Cuando quieras instalar instrucciones o prompts para que el agente siga el flujo de APTS.
- Cuando necesites el contrato JSON de las tools en un formato descargable junto al skill.

## Que incluye

- [Contrato de API](./references/api-contract.md)
- [Contrato JSON de skills](./apts_skills.json)
- [Cliente HTTP de ejemplo CommonJS](./apts-client.js)
- [Cliente HTTP de ejemplo ESM](./apts-client.mjs)
- [Guia base para AGENTS.md o copilot-instructions.md](./apts-agent-guidelines.md)

## Procedimiento recomendado

1. Revisa el [contrato de API](./references/api-contract.md) para confirmar variables, endpoints y payloads.
2. Copia [apts_skills.json](./apts_skills.json) al proyecto cliente si tu runtime soporta function calling o tool schemas.
3. Copia [apts-client.js](./apts-client.js) si el proyecto cliente usa CommonJS, o [apts-client.mjs](./apts-client.mjs) si usa ESM (`"type": "module"`).
4. Copia [apts-agent-guidelines.md](./apts-agent-guidelines.md) a `AGENTS.md` o a `.github/copilot-instructions.md` del proyecto cliente.
5. Configura `APTS_BASE_URL` y `APTS_API_KEY` en el entorno del proyecto cliente.
6. Valida la integracion ejecutando `register_task`, luego `log_agent_progress` y despues `heartbeat`.

## Cobertura del cliente oficial

- El cliente exportable de APTS (`apts-client.js` / `apts-client.mjs`) debe incluir todas las operaciones del contrato de integracion, incluyendo gestion de backlog con soft-delete.
- El proyecto cliente no deberia crear wrappers o scripts paralelos para cubrir funciones faltantes del flujo base.
- Si surge una funcionalidad nueva en el backend de integracion, primero se incorpora al cliente oficial y al `apts_skills.json`, luego se actualiza la guia.

## Nota de mantenimiento

- `apts-client.js` y `apts-client.mjs` deben conservar la misma API publica y el mismo comportamiento.
- Si se cambia un endpoint, payload, helper o manejo de errores en uno, hay que replicar el cambio en el otro.

## Politica de ejecucion de backlog (obligatoria)

- Para pedidos de ejecucion como "siguiente tarea", "next task", "continuar backlog" o "ejecutar backlog", el punto de entrada debe ser `Orquestador Backlog APTS`.
- No ejecutes implementacion directa desde el agente general si corresponde una corrida de backlog.
- Si `Orquestador Backlog APTS` no esta disponible en el proyecto cliente, detiene la operacion y solicita al operador instalar/corregir la plantilla antes de continuar.

## Resultado esperado

El proyecto cliente queda con:

- un contrato consistente de tools para APTS,
- una capa HTTP reutilizable,
- y una instruccion operativa para que los agentes reporten trabajo de forma uniforme.