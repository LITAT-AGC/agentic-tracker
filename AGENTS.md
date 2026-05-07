# Agent Guidelines for APTS

This document contains operational instructions for autonomous AI agents contributing to the Agentic Project Tracking Service (APTS).

## 🧪 Testing Guidelines

When executing end-to-end (E2E) frontend tests using Playwright, you MUST follow these specific steps to ensure our development data remains intact and isolated:

### 1. Database & Backend Preparation
The frontend E2E tests require a live backend. However, it must **never** be run against the `development` or `production` databases.

You must run the backend in `test` mode using a dedicated PostgreSQL test database (configure `PG_TEST_CONNECTION_STRING`):

```bash
# Terminal 1: Setup test database and run backend
npm run test:e2e:prepare
npm run test:e2e:backend
```
These scripts force test mode automatically:
- `test:e2e:prepare` runs backend migrations with `knex --env test`.
- `test:e2e:backend` starts backend with `NODE_ENV=test` from `backend/scripts/start_test_server.js`.

### 2. Running the E2E Tests
**Important Playwright Rules:**
- **No Browser Downloads:** Playwright must be installed without its bundled browsers. It is configured to use the local Windows Google Chrome installation via `channel: 'chrome'`. Do not run `npx playwright install`.
- **No Video Evidence:** Do not configure Playwright to capture video recordings of the test execution. Screenshots are allowed for verifying static state, but videos are strictly prohibited.

With the backend running in test mode on port 47301, you can now run the frontend tests. Playwright is configured to automatically launch the Vite dev server on port 47302 during the test run.

```bash
# Terminal 2: Run Playwright tests
cd frontend
npx playwright test
```

### 3. Cleanup (Optional but recommended)
After testing is completed, reset or drop the PostgreSQL test database if you need a clean state for the next run.

---

## 🛠️ General Rules
- Always prioritize using the most specific tool for the task at hand.
- Before modifying database schemas, always create a new migration. Do not modify existing applied migrations.
- Backend startup in PostgreSQL performs a legacy bootstrap: copy rows from sqlite_legacy (`backend/apts.db`) to PostgreSQL with upsert, delete SQLite only after successful copy, then backfill embeddings for open bugs without embedding.
- When creating UI components, utilize the existing Tailwind CSS setup and prioritize the dark, premium aesthetic.
- For any functional change in APTS that affects behavior exposed to integrators (API routes, payloads, statuses, auth flow, downloadable artifacts, or integration guidance), you must bump the public integration manifest `schema_version` and add a matching entry to `bootstrap.manifest_updates.notes`.
- `bootstrap.manifest_updates.notes` is append-only version history: never replace it with only the latest change, never delete previous entries, and always prepend the new version entry.
- If any downloadable integration artifact changes (clients, skills contract, guidelines, or agent templates), you must also version that specific artifact explicitly in the public manifest metadata (for example `artifact_version` / `updated_in_schema_version`) so local updaters can detect, overwrite, and clean legacy files deterministically.
- Any new capability added to the APTS service must be reflected in the official downloadable integration client scripts (`integracion/paquete-apts/apts-client.js` and `integracion/paquete-apts/apts-client.mjs`) and in `integracion/paquete-apts/apts_skills.json`. Client integrators must not need to build ad-hoc scripts to cover base APTS integration features.

## APTS Operational Contract Quick Reference

This section is the short operational summary for agents integrating with APTS. The formal machine-readable contract lives in `integracion/paquete-apts/apts_skills.json` and the endpoint reference lives in `integracion/paquete-apts/references/api-contract.md`.

### Common Required Fields

When using the official APTS client or CLI, identity fields are auto-filled from env, local managed execution context, and Git if omitted in payloads. The table below reflects raw API required fields.

| Field | Required by | Notes |
| --- | --- | --- |
| `project_url` | `register_task`, `create_backlog_item`, `read_project_context` (`url` query), `list_backlog_items` (`url` query), `search_similar_bug_reports` (`url` body), `heartbeat`, `log_agent_progress`, `report_blocker`, `update_task_status` | Resolve it from `git remote get-url origin`. |
| `agent_name` | `register_task`, `heartbeat`, `log_agent_progress`, `report_blocker`, `update_task_status` | Resolve it from `git config user.name`. |
| `agent_email` | `register_task`, `update_task_status` | Resolve it from `git config user.email`. |
| `branch` | `log_agent_progress` | Resolve it from `git branch --show-current`. |
| `task_id` | `heartbeat`, `log_agent_progress`, `report_blocker`, `update_task_status` | Returned by `register_task`, or resolved from `APTS_TASK_ID`, or from managed execution context (`.apts/execution-context.json` by default). |
| `backlog_item_id` | `register_task` when executing tracked work, `update_backlog_item`, `delete_backlog_item` | Use it to bind execution to backlog and avoid duplicate work. |

### Backlog Reuse Rule

If there is no active backlog item that describes exactly the change you are about to make, create a new backlog item first.

- For bug, error, or regression requests coming from chat, look for a matching non-deleted `bug` item first.
- If a matching item exists, reuse it.
- If no matching item exists, create one before implementation starts.
- For small chores such as documentation adjustments, reuse only when an active item already covers that exact scope; otherwise create a new one.

### Happy Path

1. Ensure identity context is available: official client/CLI auto-resolves `project_url`, `agent_name`, `agent_email`, and `branch` from env/local context/Git.
2. List backlog and decide whether to reuse an existing item or create a new one.
3. Call `register_task` and keep the returned `task_id`.
4. Call `read_project_context` before editing.
5. While working, alternate `heartbeat` with `log_agent_progress` at meaningful milestones.
6. If blocked, call `report_blocker` and stop.
7. Close with `update_task_status` to `review` first, then to `done` only after review and recent execution activity.

### Copy-Ready Payloads

These examples use the public contract shape exposed to clients and the official CLI.

#### create_backlog_item

```json
{
	"project_url": "https://github.com/org/repo",
	"title": "Document APTS minimum command payloads",
	"description": "Add required-field summaries, examples, and troubleshooting for APTS commands.",
	"acceptance_criteria": "AGENTS.md and README include copy-ready examples for the base APTS workflow.",
	"item_type": "chore",
	"status": "ready",
	"priority": 2
}
```

#### register_task

```json
{
	"project_url": "https://github.com/org/repo",
	"title": "Document APTS minimum command payloads",
	"agent_name": "Copilot",
	"agent_email": "copilot@example.com",
	"context": "Improve operator guidance for APTS contract-first commands.",
	"backlog_item_id": "11111111-1111-1111-1111-111111111111"
}
```

#### read_project_context

```json
{
	"url": "https://github.com/org/repo",
	"limit": 5,
	"backlog_status": "in_progress"
}
```

#### heartbeat

```json
{
	"task_id": "22222222-2222-2222-2222-222222222222",
	"agent_name": "Copilot",
	"project_url": "https://github.com/org/repo"
}
```

#### log_agent_progress

```json
{
	"task_id": "22222222-2222-2222-2222-222222222222",
	"project_url": "https://github.com/org/repo",
	"agent_name": "Copilot",
	"branch": "main",
	"message": "Added explicit required-field examples to AGENTS.md.",
	"technical_details": {
		"files_modified": [
			"AGENTS.md"
		],
		"commands_run": [
			"node .ia/apts/apts-cli.mjs heartbeat --stdin"
		],
		"outcome": "success"
	}
}
```

#### update_task_status

```json
{
	"task_id": "22222222-2222-2222-2222-222222222222",
	"status": "review",
	"project_url": "https://github.com/org/repo",
	"agent_name": "Copilot",
	"agent_email": "copilot@example.com"
}
```

### PowerShell-Safe CLI Examples

Prefer file payloads or here-strings on Windows instead of inline escaped JSON.

```powershell
@'
{
	"task_id": "22222222-2222-2222-2222-222222222222",
	"agent_name": "Copilot",
	"project_url": "https://github.com/org/repo"
}
'@ | Set-Content -Path heartbeat.json

Get-Content .\heartbeat.json | node .ia/apts/apts-cli.mjs heartbeat --stdin --pretty
```

```powershell
$payload = @'
{
	"project_url": "https://github.com/org/repo",
	"title": "Document APTS minimum command payloads",
	"agent_name": "Copilot",
	"agent_email": "copilot@example.com"
}
'@

$payload | node .ia/apts/apts-cli.mjs register-task --stdin --pretty
```

### Frequent Errors

| Error | Meaning | First check | Retry? |
| --- | --- | --- | --- |
| `INVALID_ARGUMENT` | Required field missing, invalid enum, invalid UUID, or malformed JSON. | Compare your payload with `apts_skills.json` and verify required fields first. | No. Fix the payload. |
| `401` / `403` | Missing or invalid `APTS_API_KEY`. | Environment variables and bearer token wiring. | No. Fix auth first. |
| `404` | Wrong route or resource id not found. | `task_id`, `backlog_item_id`, and base URL. | No, unless the id was just created and your client is stale. |
| `429` | Rate limited. | Backoff policy and duplicate retries. | Yes, short backoff, max 2 retries. |
| `5xx` or network error | Temporary server or connectivity failure. | APTS availability and network reachability. | Yes, short backoff, max 2 retries. |

Do not retry `400`, `401`, `403`, or `404` in a loop. If retries for `429`, network, or `5xx` still fail after two attempts, report a blocker and stop.
