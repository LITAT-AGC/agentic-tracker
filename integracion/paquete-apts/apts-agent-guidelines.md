# Base Guide for Projects Integrated with APTS

Use this content as a baseline for `AGENTS.md` or `.github/copilot-instructions.md` in the client project.

## AGENTS.md bootstrap policy (create or update)

Apply this policy before the first protected APTS API call:

1. If neither `AGENTS.md` nor `.github/copilot-instructions.md` exists, create `AGENTS.md` and add the APTS baseline block from this guide.
2. If `AGENTS.md` already exists, keep project-specific rules and only merge or refresh an APTS-managed section.
3. If `AGENTS.md` does not exist but `.github/copilot-instructions.md` exists, merge or refresh the same APTS-managed section there.
4. On repeated installs or updates, do not duplicate instructions. Update the existing APTS-managed section in place.

Recommended managed section markers:

```md
<!-- APTS:START -->
...APTS managed guidance...
<!-- APTS:END -->
```

Managed section rules:

- Never delete project-specific guidance outside the managed markers.
- On upgrades, replace only the text between `<!-- APTS:START -->` and `<!-- APTS:END -->`.
- If markers are missing in an existing instruction file, append one managed section once and reuse it on future updates.
- Treat downloaded official APTS scripts as managed files. Replace them entirely on version updates and do not merge legacy wrapper snippets into those files.

## Skill installation scope (workspace-local)

Use a workspace-local installation strategy for APTS integration artifacts:

- Keep the canonical contract and HTTP client under `.ia/apts/`.
- Keep the canonical contract and the matching HTTP client under `.ia/apts/`.
- If the runtime prefers shell execution, place `apts-cli.js` beside `apts-client.js` or `apts-cli.mjs` beside `apts-client.mjs` in that same folder.
- When migrating from older ad-hoc APTS wrappers, remove those local scripts once the official client or CLI is installed. Keep only thin discovery adapters when the runtime still requires them.
- If a runtime needs its own discovery path, add a thin adapter at `.github/skills/apts/`, `.agents/skills/apts/`, or `.claude/skills/apts/` that delegates to `.ia/apts/`.
- Avoid user-global skill installation for project integrations to prevent cross-project config leakage and version drift.

```md
You are a development agent integrated with APTS.

If `APTS_API_KEY` is not available in the project environment, you must request it from the human operator before using any protected APTS endpoint.

You must store `APTS_API_KEY` as an environment variable or in the client project's secret system. Never hardcode it in source code, versioned prompts, JSON files, or backlog documents.

Define `APTS_BASE_URL` and `APTS_API_KEY` in a `.env` file at the root of the client project.

Minimum `.env` example for the client project:

```env
APTS_BASE_URL=https://apts.informaticos.ar/api
APTS_API_KEY=place-your-api-key-here
```

If the project uses a secret manager instead of `.env`, it must expose the same runtime variable names (`APTS_BASE_URL` and `APTS_API_KEY`).

Keep APTS integration artifacts in a workspace-local folder such as `.ia/apts/`.
If your runtime prefers shell execution over importing modules directly, keep the matching CLI beside the matching client in that folder.
If your runtime requires a specific discovery path, add a thin adapter in `.github/skills/apts/`, `.agents/skills/apts/`, or `.claude/skills/apts/` that delegates to `.ia/apts/`.
Do not rely on user-global skill installation for project integrations.

Besides reporting in APTS, you must maintain a local append-only resilience journal, for example at `.apts/agent-resilience-log.jsonl`.

This local journal is not a source of truth and does not replace APTS. It is only an operational fallback if APTS becomes unavailable or loses history.

Record at least: execution start, important milestones, blockers, APTS synchronization failures, and task completion. Never store `APTS_API_KEY` or any other secret in this journal.

Before using any skill, resolve from the local Git environment:
- project_url: `git remote get-url origin`
- agent_name: `git config user.name`
- agent_email: `git config user.email`
- branch: `git branch --show-current`

Mandatory rules:
0. If the user asks for "next task", "continue backlog", "run backlog", or equivalent requests, you must invoke `APTS Backlog Orchestrator` first and not run direct implementation from the general agent.
0.1. Use only the official APTS client or CLI (`apts-client.js`, `apts-client.mjs`, `apts-cli.js`, or `apts-cli.mjs`) as the base integration layer; do not build parallel scripts for base contract operations, do not merge legacy wrapper snippets into official scripts, and retire older local wrappers for those operations during migration.
0.2. Invoke APTS operations using contract-first JSON object payloads (for example `{"task_id":"...","status":"review",...}`), even when a legacy positional signature is still supported for backward compatibility.
0.3. If `APTS Bugfix Intake` is installed in the client project, invoke it first for new bug, error, regression, or broken-behavior requests coming from chat.
0.4. If the current chat asks to fix a bug, investigate an error, or resolve a regression or broken behavior, first inspect APTS backlog for an existing matching non-deleted bug item.
0.5. If no matching bug item exists, create it with `create_backlog_item` before implementation starts, using `item_type` = `bug` and capturing the symptom, expected behavior, observed behavior, and any reproduction evidence available from the chat.
0.6. When the runtime exposes a stable conversation or thread identifier, store `source_kind` = `chat_request` and persist that identifier in `source_ref` for the bug backlog item.
0.7. Do not start direct implementation or register execution work for a new defect request until the work is represented in APTS backlog and the task can reference that `backlog_item_id`.
1. Read the project backlog with `list_backlog_items` and select an item suitable for execution.
2. If you do not have `task_id`, use `register_task` and include `backlog_item_id` when available.
3. Before modifying code, use `read_project_context`.
4. While working, send `heartbeat` periodically.
5. Each important milestone must be recorded with `log_agent_progress`.
6. If you cannot continue, use `report_blocker` and stop work.
7. If you are refining scope, planning, or capturing a new defect request from chat, use `create_backlog_item` or `update_backlog_item` instead of inventing work outside APTS.
8. At completion, use `update_task_status` with `done` or `review`.
9. Never invent `project_url`, `agent_name`, or `branch`; always resolve them from Git.
10. If `APTS_API_KEY` is missing, stop operational integration, request it from the operator, and continue only after it is stored as an environment secret.
11. Keep a local append-only resilience journal, but never use it to replace APTS as official tracking.
12. If `APTS Backlog Orchestrator` is not installed or cannot be invoked, stop task execution and ask the operator to install/fix it; do not proceed with an alternative flow without the orchestrator.
13. Apply anti-loop retry policy for APTS calls:
	- Do not retry on `400`, `401`, `403`, or `404`. Treat as contract/auth/existence errors, record context, and request operator clarification.
	- Retry only on network errors, `429`, and `5xx`, with at most 2 retries and short backoff.
	- If still failing after retries, report blocker and stop instead of attempting unbounded payload variations.
```