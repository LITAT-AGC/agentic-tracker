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
- [CommonJS helper](./apts-helper.js)
- [ESM helper](./apts-helper.mjs)
- [CommonJS sample HTTP client](./apts-client.js)
- [ESM sample HTTP client](./apts-client.mjs)
- [CommonJS CLI entrypoint](./apts-cli.js)
- [ESM CLI entrypoint](./apts-cli.mjs)
- [Base guide for AGENTS.md or copilot-instructions.md](./apts-agent-guidelines.md)

## Uso recomendado para Agentes de IA

- Prefer the official CLI as the first integration surface.
- Use the official helper only when the runtime cannot shell the CLI reliably.
- Use the raw client only inside predefined helpers or wrappers that already belong to the project.
- Never generate fresh direct-client bootstrap code during each interaction.

## Workspace installation policy (recommended)

- Use a workspace-local, runtime-neutral base folder: `.ia/apts/`.
- Keep the APTS contract, the matching HTTP client, the primary CLI, and the optional helper in that base folder.
- Treat official APTS scripts as managed artifacts: replace them as full files on updates and do not merge code from legacy local wrappers into those scripts.
- Add runtime-specific adapter folders only for discovery when needed: `.github/skills/apts/` (VS Code/Copilot), `.agents/skills/apts/` (agent loaders using `.agents`), and `.claude/skills/apts/` (Claude-style loaders).
- Avoid user-global skill installation for project integrations because it increases cross-project configuration leakage and version drift.

## AGENTS.md setup policy (mandatory)

- If neither `AGENTS.md` nor `.github/copilot-instructions.md` exists in the client project, create `AGENTS.md` using [apts-agent-guidelines.md](./apts-agent-guidelines.md).
- If either file already exists, do not replace the full file. Merge or refresh only an APTS-managed section and preserve project-specific rules.
- Use idempotent markers (`<!-- APTS:START -->` and `<!-- APTS:END -->`) so future APTS upgrades can update guidance without duplicating content.
- Keep only one APTS-managed section per instruction file.

## Recommended procedure

1. Review the [API contract](./references/api-contract.md) to confirm variables, endpoints, and payloads.
2. Create `.ia/apts/` in the client project and copy [apts_skills.json](./apts_skills.json) there.
3. Copy the matching client into `.ia/apts/`: [apts-client.js](./apts-client.js) for CommonJS or [apts-client.mjs](./apts-client.mjs) for ESM (`"type": "module"`).
4. Copy the matching CLI beside that client and treat it as the default agent interface: [apts-cli.js](./apts-cli.js) for CommonJS or [apts-cli.mjs](./apts-cli.mjs) for ESM.
5. Only if the runtime cannot shell the CLI reliably, copy the matching helper beside the client: [apts-helper.js](./apts-helper.js) for CommonJS or [apts-helper.mjs](./apts-helper.mjs) for ESM.
6. If the client project previously used ad-hoc APTS wrapper scripts for base operations, remove them after the official CLI or helper is in place. Keep only thin runtime-specific adapters when discovery still requires them.
7. If your runtime requires a specific discovery path, add a thin adapter under `.github/skills/apts/`, `.agents/skills/apts/`, or `.claude/skills/apts/` that delegates to `.ia/apts/`.
8. Apply the AGENTS setup policy: create `AGENTS.md` when no instruction file exists, or merge/update one APTS-managed section in `AGENTS.md` or `.github/copilot-instructions.md` when a file already exists.
9. Configure `APTS_BASE_URL` and `APTS_API_KEY` in a `.env` file at the client project root (or an equivalent secret manager that exposes them as environment variables).
9.1. Optional but recommended: set `APTS_PROJECT_URL`, `APTS_AGENT_NAME`, `APTS_AGENT_EMAIL`, `APTS_BRANCH`, `APTS_TASK_ID`, `APTS_CONTEXT_FILE`, and `APTS_ENV_FILE` to reduce repeated protocol payload fields and make env resolution deterministic.
10. Validate the integration by running `register_task`, then `log_agent_progress`, and then `heartbeat`, using the CLI with minimal payloads.

## opencode.ai setup

- Keep the canonical scripts in `.ia/apts/`.
- Install [SKILL.md](./SKILL.md) and [apts_skills.json](./apts_skills.json) under `.agents/skills/apts/` for discovery.
- Create one thin opencode.ai Custom Tool that shells the official CLI and requests structured output (`--output structured`).
- If that runtime cannot shell reliably, implement that Custom Tool on top of the official helper instead of importing the raw client.

Official client/CLI identity autofill note: when payload fields are omitted, the official scripts resolve identity from env first, then local managed execution context file, and then local Git (`project_url/url`, `agent_name`, `agent_email`, `branch`), and resolve `task_id` from `APTS_TASK_ID` or managed context for execution calls.

Protocol overhead rule: when using official client/CLI, do not run manual Git identity discovery as a default step. Start with minimum payloads and only inspect execution context when a call reports missing required fields.

Windows VS Code shell routing rule: when developing in VS Code on Windows, run tests and APTS calls through WSL terminals/tasks, and route non-APTS non-test operations through PowerShell terminals/tasks.

Managed execution context note: official scripts persist execution context at `.apts/execution-context.json` by default (override with `APTS_CONTEXT_FILE`). CLI exposes `show-execution-context`, `set-execution-context`, and `clear-execution-context` to inspect or control that state.

Task recovery note: during backlog execution, call `register_task` with `backlog_item_id` so APTS can resume interrupted `todo`/`in_progress`/`stalled` tasks instead of creating duplicates.

Task close note: prefer `review` first and promote to `done` only after review policy passes and recent execution activity is present.

## Official client coverage

- The exported APTS client (`apts-client.js` / `apts-client.mjs`) must include every operation in the integration contract, including backlog management with soft-delete.
- The exported APTS helper (`apts-helper.js` / `apts-helper.mjs`) must stay a thin, safe wrapper over the client and must never introduce parallel protocol behavior.
- The official CLI (`apts-cli.js` / `apts-cli.mjs`) is a thin executable entrypoint over the matching client and must stay aligned with that client variant.
- For base APTS contract operations, the integration layer must use only official scripts published by APTS (`apts-client.js`, `apts-client.mjs`, `apts-helper.js`, `apts-helper.mjs`, `apts-cli.js`, `apts-cli.mjs`).
- Do not merge or splice code from old project-local wrappers into those official scripts.
- The client project should not create parallel wrappers or scripts to cover missing functions of the base flow.
- When migrating to the official client or CLI, retire any older project-local APTS wrappers that only proxy those base operations.
- If custom runtime behavior is still required, implement it as a thin adapter that delegates to the official script unchanged.
- If a new integration backend capability is introduced, add it first to the official client and to `apts_skills.json`, then update the guide.

## Maintenance note

- `apts-client.js` and `apts-client.mjs` must keep the same public API and behavior.
- If an endpoint, payload, helper, or error handling changes in one file, replicate the same change in the other.
- `apts-helper.js` and `apts-helper.mjs` must keep the same public API and behavior.
- `apts-cli.js` and `apts-cli.mjs` must keep the same command surface and behavior.
- Each CLI file must keep delegating to its matching client file in the same folder.

## Backlog execution policy (mandatory)

- For execution requests such as "next task", "continue backlog", or "run backlog", the entry point must be `APTS Backlog Orchestrator`.
- Do not execute direct implementation from the general agent when a backlog run applies.
- If `APTS Backlog Orchestrator` is not available in the client project, stop the operation and ask the operator to install/fix the template before continuing.

## Bug reporting policy (mandatory)

- If a user chat asks to fix/report a bug, investigate an error, or resolve a regression/broken behavior, inspect APTS backlog for an existing matching non-deleted bug item.
- Before creating a new bug item, prefer `search_similar_bug_reports` with the defect symptom to detect semantic duplicates.
- If a matching bug item already exists, reuse it instead of creating a duplicate defect entry.
- If no matching bug item exists, create it in APTS using `create_backlog_item` with `item_type: "bug"`.
- Capture symptom, expected behavior, observed behavior, and available reproduction evidence in that tracked bug item.
- When the runtime exposes a stable conversation or thread identifier, store `source_kind: "chat_request"` and persist that identifier in `source_ref`.
- For requests like "report this solved issue as resolved bug in APTS", update the tracked bug item with `update_backlog_item` and move status to `review` or `done`, including concise resolution and validation evidence.
- Do not start direct implementation for a newly reported defect until it is represented in APTS backlog and execution can reference that `backlog_item_id`.

## Expected result

The client project ends up with:

- a consistent tools contract for APTS,
- a reusable HTTP layer, a CLI-first shell entrypoint, and a safe helper fallback,
- runtime-aware process management guidance for server-based validations, including OpenCode plugin recommendations only when that runtime uses synchronous bash,
- and an operational instruction so agents report work consistently, including creating or reusing bug backlog items before implementing chat-triggered defect fixes.
- and an operational instruction so agents can report solved defects in APTS by updating tracked bug items with resolution evidence.