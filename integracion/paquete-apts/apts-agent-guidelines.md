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

## OpenCode process plugins (recommended)

If the client project runs agents through OpenCode with a synchronous `bash` tool (common on Windows with Git Bash), install both official process plugins to avoid hanging server commands during validation runs:

- `@zenobius/opencode-background` (tested with `v0.1.0-alpha.2`)
- `opencode-pty` (tested with `v0.3.4`)

Recommended `opencode.json` snippet:

```json
{
	"$schema": "https://opencode.ai/config.json",
	"plugin": [
		"@zenobius/opencode-background",
		"opencode-pty"
	]
}
```

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

For the official APTS client/CLI, identity fields are auto-resolved from environment variables first, then managed local execution context, and then local Git when omitted in payloads:
- project_url/url: `APTS_PROJECT_URL` or `git remote get-url origin`
- agent_name: `APTS_AGENT_NAME` or `git config user.name`
- agent_email: `APTS_AGENT_EMAIL` or `git config user.email`
- branch: `APTS_BRANCH` or `git branch --show-current`
- task_id for active execution calls: `APTS_TASK_ID` (optional but recommended to avoid repeating it in every payload)
- local context file fallback: `.apts/execution-context.json` (or the path in `APTS_CONTEXT_FILE`)

If you call the raw HTTP API directly (without the official client/CLI), you must still send all required identity fields explicitly.

Mandatory rules:
0. If the user asks for "next task", "continue backlog", "run backlog", or equivalent requests, you must invoke `APTS Backlog Orchestrator` first and not run direct implementation from the general agent.
0.1. Use only the official APTS client or CLI (`apts-client.js`, `apts-client.mjs`, `apts-cli.js`, or `apts-cli.mjs`) as the base integration layer; do not build parallel scripts for base contract operations, do not merge legacy wrapper snippets into official scripts, and retire older local wrappers for those operations during migration.
0.2. Invoke APTS operations using contract-first JSON object payloads (for example `{"task_id":"...","status":"review",...}`), even when a legacy positional signature is still supported for backward compatibility.
0.3. If `APTS Bugfix Intake` is installed in the client project, invoke it first for new bug, error, regression, or broken-behavior requests coming from chat.
0.4. If the current chat asks to fix a bug, investigate an error, or resolve a regression or broken behavior, first inspect APTS backlog for an existing matching non-deleted bug item.
0.4.1. Prefer `search_similar_bug_reports` with the symptom summary before deciding whether a new `bug` item is needed.
0.5. If no matching bug item exists, create it with `create_backlog_item` before implementation starts, using `item_type` = `bug` and capturing the symptom, expected behavior, observed behavior, and any reproduction evidence available from the chat.
0.6. When the runtime exposes a stable conversation or thread identifier, store `source_kind` = `chat_request` and persist that identifier in `source_ref` for the bug backlog item.
0.7. Do not start direct implementation or register execution work for a new defect request until the work is represented in APTS backlog and the task can reference that `backlog_item_id`.
1. Read the project backlog with `list_backlog_items` and select an item suitable for execution.
2. Call `register_task` with `backlog_item_id` for execution work and always use the returned `task_id`; this may resume interrupted work instead of creating a duplicate task.
3. Before modifying code, use `read_project_context`.
4. While working, send `heartbeat` periodically.
5. Each important milestone must be recorded with `log_agent_progress`.
6. If you cannot continue, use `report_blocker` and stop work.
7. If you are refining scope, planning, or capturing a new defect request from chat, use `create_backlog_item` or `update_backlog_item` instead of inventing work outside APTS.
8. At completion, set `review` first; use `done` only from review and only when recent execution activity exists.
9. Never invent `project_url`, `agent_name`, or `branch`; let the official client/CLI auto-resolve them from env/local context/Git or provide them explicitly with real values.
10. If `APTS_API_KEY` is missing, stop operational integration, request it from the operator, and continue only after it is stored as an environment secret.
11. Keep a local append-only resilience journal, but never use it to replace APTS as official tracking.
12. If `APTS Backlog Orchestrator` is not installed or cannot be invoked, stop task execution and ask the operator to install/fix it; do not proceed with an alternative flow without the orchestrator.
13. Apply anti-loop retry policy for APTS calls:
	- Do not retry on `400`, `401`, `403`, or `404`. Treat as contract/auth/existence errors, record context, and request operator clarification.
	- Retry only on network errors, `429`, and `5xx`, with at most 2 retries and short backoff.
	- If still failing after retries, report blocker and stop instead of attempting unbounded payload variations.
```

## Operational Quick Reference

Use `integracion/paquete-apts/apts_skills.json` as the formal contract and `integracion/paquete-apts/references/api-contract.md` as the human-readable source of truth.

### Common Required Fields

When you use the official client/CLI, missing identity fields are auto-filled from env/local context/Git. The table below still lists server-required fields for raw API calls.

| Field | Required by |
| --- | --- |
| `project_url` | `register_task`, `create_backlog_item`, `heartbeat`, `log_agent_progress`, `report_blocker`, `update_task_status` |
| `url` | `read_project_context`, `list_backlog_items`, `search_similar_bug_reports` |
| `agent_name` | `register_task`, `heartbeat`, `log_agent_progress`, `report_blocker`, `update_task_status` |
| `agent_email` | `register_task`, `update_task_status` |
| `branch` | `log_agent_progress` |
| `task_id` | `heartbeat`, `log_agent_progress`, `report_blocker`, `update_task_status` |
| `backlog_item_id` | `register_task` when executing tracked work, `update_backlog_item`, `delete_backlog_item` |

### Reuse Or Create Backlog Item

- Reuse an item only when an active backlog item already describes exactly the same scope.
- If no active item matches exactly, create a new backlog item before execution.
- For new bug, error, or regression requests from chat, look for an existing non-deleted `bug` item first, then create one only if no matching item exists.
- For small chores such as documentation adjustments, follow the same exact-scope rule instead of guessing based on size alone.

### Happy Path

1. Ensure identity context is available (official client/CLI resolves from env/local context/Git automatically).
2. Call `list_backlog_items`, preferably with `view = compact`, and choose to reuse or create an item.
3. Call `register_task`; official client/CLI persists the returned `task_id` in local managed context for subsequent calls.
4. Call `read_project_context`, preferably with `view = compact`, before editing.
5. Call `heartbeat` while the task is active.
6. Call `log_agent_progress` on meaningful milestones.
7. If blocked, call `report_blocker` and stop.
8. Finish with `update_task_status` to `review`, then `done` only after review and recent activity.

### Compact Response Mode

- `list_backlog_items` and `read_project_context` now default to compact summaries in official agent flows.
- Re-read with `view = full` only for the selected backlog item or when you specifically need raw descriptions, acceptance criteria, full task context, or full log `technical_details`.

### Minimum Payloads

```json
{
	"list_backlog_items": {
		"status": "ready"
	},
	"create_backlog_item": {
		"title": "Document APTS command payloads"
	},
	"register_task": {
		"title": "Document APTS command payloads"
	},
	"read_project_context": {
		"limit": 5
	},
	"heartbeat": {
	},
	"set_execution_context": {
		"task_id": "22222222-2222-2222-2222-222222222222"
	},
	"log_agent_progress": {
		"message": "Updated APTS docs with explicit payload examples."
	},
	"update_task_status": {
		"status": "review"
	}
}
```

For `heartbeat`, `log_agent_progress`, `report_blocker`, and `update_task_status`, minimum payloads above assume `task_id` is already available through `APTS_TASK_ID` or managed execution context.

### PowerShell Examples

```powershell
$heartbeat = @'
{
	"task_id": "22222222-2222-2222-2222-222222222222"
}
'@

$heartbeat | node .ia/apts/apts-cli.mjs set-execution-context --stdin --pretty
```

```powershell
@'
{
}
'@ | Set-Content -Path heartbeat.json

Get-Content .\heartbeat.json | node .ia/apts/apts-cli.mjs heartbeat --stdin --pretty
```

### PowerShell Reliability Checklist

1. For `update-backlog-item` and `delete-backlog-item`, always use `backlog_item_id` (never `id`).
2. If inline `--json` starts failing with parsing or unexpected extra arguments, reduce to a minimal payload and retry first.
3. Do not write here-strings in a single line after `@'`; keep the JSON body on following lines and close with `'@` on its own line.
4. If `--stdin` appears stuck, verify the command with a short `--json` payload, then return to file-piped stdin.
5. For long texts (`acceptance_criteria`, multiline notes), use staged updates: minimal field first, full text second.
6. After every mutating call, read the item again and verify persisted fields.

### Staged PowerShell Update Example (Backlog)

```powershell
node .ia/apts/apts-cli.mjs update-backlog-item --json '{"backlog_item_id":"11111111-1111-1111-1111-111111111111","status":"review"}' --pretty

@'
{
	"backlog_item_id": "11111111-1111-1111-1111-111111111111",
	"acceptance_criteria": "FE: shows retry state and validation hints. BE: persists normalized payload and status transitions."
}
'@ | Set-Content -Path backlog-update.json

Get-Content .\backlog-update.json | node .ia/apts/apts-cli.mjs update-backlog-item --stdin --pretty
```

### Frequent Errors

| Error | Meaning | Retry |
| --- | --- | --- |
| `INVALID_ARGUMENT` | Missing required field, invalid enum, invalid UUID, or malformed JSON. | No. Fix payload first. |
| `401` / `403` | Missing or invalid API key. | No. Fix auth first. |
| `404` | Wrong resource id or route. | No, unless the reference is stale and can be refreshed deterministically. |
| `429` | Rate limited. | Yes, up to 2 retries with short backoff. |
| Network error / `5xx` | Temporary server or connectivity failure. | Yes, up to 2 retries with short backoff. |