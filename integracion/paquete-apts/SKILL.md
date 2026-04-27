---
name: apts
description: 'Integrate a project with APTS. Use when adding agent tracking, installing APTS skills or prompts, wiring register_task, read_project_context, log_agent_progress, heartbeat, report_blocker, or update_task_status against the APTS API.'
argument-hint: 'Describe the client project and the type of APTS integration you need'
user-invocable: true
---

# APTS Integration Skill

This skill packages the minimum resources needed to connect a client project with APTS without rebuilding the workflow from scratch.

Note: in this repository, it is published as integration material under the repository-level APTS package folder to avoid confusion with active customizations of the APTS project itself.

## When to use it

- When a project needs to report agent work to APTS.
- When you need to copy an official HTTP client that covers all skills published for integration.
- When you want to install instructions or prompts so the agent follows the APTS workflow.
- When you need the tools JSON contract in a downloadable format together with the skill.

## What it includes

- [API contract](./references/api-contract.md)
- [Skills JSON contract](./apts_skills.json)
- [CommonJS sample HTTP client](./apts-client.js)
- [ESM sample HTTP client](./apts-client.mjs)
- [Base guide for AGENTS.md or copilot-instructions.md](./apts-agent-guidelines.md)

## Workspace installation policy (recommended)

- Use a workspace-local, runtime-neutral base folder: `.ia/apts/`.
- Keep the APTS contract and HTTP client in that base folder.
- Add runtime-specific adapter folders only for discovery when needed: `.github/skills/apts/` (VS Code/Copilot), `.agents/skills/apts/` (agent loaders using `.agents`), and `.claude/skills/apts/` (Claude-style loaders).
- Avoid user-global skill installation for project integrations because it increases cross-project configuration leakage and version drift.

## Recommended procedure

1. Review the [API contract](./references/api-contract.md) to confirm variables, endpoints, and payloads.
2. Create `.ia/apts/` in the client project and copy [apts_skills.json](./apts_skills.json) there.
3. Copy [apts-client.js](./apts-client.js) if the client project uses CommonJS, or [apts-client.mjs](./apts-client.mjs) if it uses ESM (`"type": "module"`), into `.ia/apts/`.
4. If your runtime requires a specific discovery path, add a thin adapter under `.github/skills/apts/`, `.agents/skills/apts/`, or `.claude/skills/apts/` that delegates to `.ia/apts/`.
5. Copy [apts-agent-guidelines.md](./apts-agent-guidelines.md) into `AGENTS.md` or `.github/copilot-instructions.md` of the client project.
6. Configure `APTS_BASE_URL` and `APTS_API_KEY` in a `.env` file at the client project root (or an equivalent secret manager that exposes them as environment variables).
7. Validate the integration by running `register_task`, then `log_agent_progress`, and then `heartbeat`.

## Official client coverage

- The exported APTS client (`apts-client.js` / `apts-client.mjs`) must include every operation in the integration contract, including backlog management with soft-delete.
- The client project should not create parallel wrappers or scripts to cover missing functions of the base flow.
- If a new integration backend capability is introduced, add it first to the official client and to `apts_skills.json`, then update the guide.

## Maintenance note

- `apts-client.js` and `apts-client.mjs` must keep the same public API and behavior.
- If an endpoint, payload, helper, or error handling changes in one file, replicate the same change in the other.

## Backlog execution policy (mandatory)

- For execution requests such as "next task", "continue backlog", or "run backlog", the entry point must be `APTS Backlog Orchestrator`.
- Do not execute direct implementation from the general agent when a backlog run applies.
- If `APTS Backlog Orchestrator` is not available in the client project, stop the operation and ask the operator to install/fix the template before continuing.

## Expected result

The client project ends up with:

- a consistent tools contract for APTS,
- a reusable HTTP layer,
- and an operational instruction so agents report work consistently.