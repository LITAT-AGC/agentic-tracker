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
- [CommonJS CLI entrypoint](./apts-cli.js)
- [ESM CLI entrypoint](./apts-cli.mjs)
- [Base guide for AGENTS.md or copilot-instructions.md](./apts-agent-guidelines.md)

## Workspace installation policy (recommended)

- Use a workspace-local, runtime-neutral base folder: `.ia/apts/`.
- Keep the APTS contract, the matching HTTP client, and the optional matching CLI in that base folder.
- Add runtime-specific adapter folders only for discovery when needed: `.github/skills/apts/` (VS Code/Copilot), `.agents/skills/apts/` (agent loaders using `.agents`), and `.claude/skills/apts/` (Claude-style loaders).
- Avoid user-global skill installation for project integrations because it increases cross-project configuration leakage and version drift.

## Recommended procedure

1. Review the [API contract](./references/api-contract.md) to confirm variables, endpoints, and payloads.
2. Create `.ia/apts/` in the client project and copy [apts_skills.json](./apts_skills.json) there.
3. Copy [apts-client.js](./apts-client.js) if the client project uses CommonJS, or [apts-client.mjs](./apts-client.mjs) if it uses ESM (`"type": "module"`), into `.ia/apts/`.
4. If your runtime prefers shellable command entrypoints over importing JavaScript modules directly, copy the matching CLI beside that client: [apts-cli.js](./apts-cli.js) for CommonJS or [apts-cli.mjs](./apts-cli.mjs) for ESM.
5. If the client project previously used ad-hoc APTS wrapper scripts for base operations, remove them after the official client or CLI is in place. Keep only thin runtime-specific adapters when discovery still requires them.
6. If your runtime requires a specific discovery path, add a thin adapter under `.github/skills/apts/`, `.agents/skills/apts/`, or `.claude/skills/apts/` that delegates to `.ia/apts/`.
7. Copy [apts-agent-guidelines.md](./apts-agent-guidelines.md) into `AGENTS.md` or `.github/copilot-instructions.md` of the client project.
8. Configure `APTS_BASE_URL` and `APTS_API_KEY` in a `.env` file at the client project root (or an equivalent secret manager that exposes them as environment variables).
9. Validate the integration by running `register_task`, then `log_agent_progress`, and then `heartbeat`.

## Official client coverage

- The exported APTS client (`apts-client.js` / `apts-client.mjs`) must include every operation in the integration contract, including backlog management with soft-delete.
- The official CLI (`apts-cli.js` / `apts-cli.mjs`) is a thin executable entrypoint over the matching client and must stay aligned with that client variant.
- The client project should not create parallel wrappers or scripts to cover missing functions of the base flow.
- When migrating to the official client or CLI, retire any older project-local APTS wrappers that only proxy those base operations.
- If a new integration backend capability is introduced, add it first to the official client and to `apts_skills.json`, then update the guide.

## Maintenance note

- `apts-client.js` and `apts-client.mjs` must keep the same public API and behavior.
- If an endpoint, payload, helper, or error handling changes in one file, replicate the same change in the other.
- `apts-cli.js` and `apts-cli.mjs` must keep the same command surface and behavior.
- Each CLI file must keep delegating to its matching client file in the same folder.

## Backlog execution policy (mandatory)

- For execution requests such as "next task", "continue backlog", or "run backlog", the entry point must be `APTS Backlog Orchestrator`.
- Do not execute direct implementation from the general agent when a backlog run applies.
- If `APTS Backlog Orchestrator` is not available in the client project, stop the operation and ask the operator to install/fix the template before continuing.

## Bugfix intake policy (mandatory)

- If a user chat asks to fix a bug, investigate an error, or resolve a regression or broken behavior, first inspect APTS backlog for an existing matching non-deleted bug item.
- If the client runtime supports custom agents, install and invoke `APTS Bugfix Intake` as the first entrypoint for those defect requests.
- If a matching bug item already exists, reuse it instead of creating a duplicate defect entry.
- If no matching bug item exists, create it in APTS before implementation starts using `create_backlog_item` with `item_type: "bug"`.
- Capture the symptom, expected behavior, observed behavior, and any reproduction evidence available from the chat in that backlog item.
- When the runtime exposes a stable conversation or thread identifier, store `source_kind: "chat_request"` and persist that identifier in `source_ref`.
- If `APTS Bugfix Intake` is not installed, apply the same backlog-first defect intake policy manually from the general agent.
- Do not begin direct implementation until the execution task can reference the tracked bug backlog item.

## Expected result

The client project ends up with:

- a consistent tools contract for APTS,
- a reusable HTTP layer and optional shell entrypoint,
- and an operational instruction so agents report work consistently, including creating or reusing bug backlog items before implementing chat-triggered defect fixes.