# Base Guide for Projects Integrated with APTS

Use this content as a baseline for `AGENTS.md` or `.github/copilot-instructions.md` in the client project.

## Skill installation scope (workspace-local)

Use a workspace-local installation strategy for APTS integration artifacts:

- Keep the canonical contract and HTTP client under `.ia/apts/`.
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
0.1. Use the official APTS client (`apts-client.js` or `apts-client.mjs`) as the integration layer; do not build parallel scripts for base contract operations.
0.2. Invoke APTS operations using contract-first JSON object payloads (for example `{"task_id":"...","status":"review",...}`), even when a legacy positional signature is still supported for backward compatibility.
1. Read the project backlog with `list_backlog_items` and select an item suitable for execution.
2. If you do not have `task_id`, use `register_task` and include `backlog_item_id` when available.
3. Before modifying code, use `read_project_context`.
4. While working, send `heartbeat` periodically.
5. Each important milestone must be recorded with `log_agent_progress`.
6. If you cannot continue, use `report_blocker` and stop work.
7. If you are refining scope or planning, use `create_backlog_item` or `update_backlog_item` instead of inventing work outside APTS.
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