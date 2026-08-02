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

### 4. Shell Routing by Runtime (Windows)
Pick the shell by the active agent runtime, not by VS Code task:
- **Claude Code:** use the Bash tool for POSIX scripts and tests; use PowerShell for Windows-native operations (setup, file ops, git workflows, docs updates, local utilities). Start long-running validation servers with a non-blocking process primitive (Bash background mode, or PowerShell `Start-Job`/`Start-Process`) and stop them after tests.
- **opencode:** use bash; route long-running servers through a background/PTY primitive rather than relying only on `&` or `nohup`.
- This mirrors the canonical *Shell routing by runtime* guidance shipped to client projects in the APTS integration package (`integracion/paquete-apts/runtime-adapters/spec/apts-surface.json` → `instructions.body`).

---

## 🛠️ General Rules
- Always prioritize using the most specific tool for the task at hand.
- Before modifying database schemas, always create a new migration. Do not modify existing applied migrations.
- Backend startup in PostgreSQL performs a legacy bootstrap: copy rows from sqlite_legacy (`backend/apts.db`) to PostgreSQL with upsert, delete SQLite only after successful copy, then backfill embeddings for open bugs without embedding.
- When creating UI components, utilize the existing Tailwind CSS setup and prioritize the dark, premium aesthetic.
- For any functional change in APTS that affects behavior exposed to integrators (API routes, payloads, statuses, auth flow, downloadable artifacts, or integration guidance), you must bump the public integration manifest `schema_version`. The manifest only exposes `bootstrap.manifest_updates.current_version`; the change history lives in git, not in the manifest.
- If any downloadable integration artifact changes (clients, skills contract, guidelines, or agent templates), you must also version that specific artifact explicitly in the public manifest metadata (for example `artifact_version` / `updated_in_schema_version`) so local updaters can detect, overwrite, and clean legacy files deterministically.
- Any new capability added to the APTS service must be reflected in `integracion/paquete-apts/apts_skills.json`, the single source of truth, and in the in-process executor that serves the remote MCP endpoint (`backend/index.js`). The startup self-check (`backend/scripts/lib/contract_check.mjs`) aborts the boot if the two drift, so a contract change cannot be half-applied. Client integrators must not need to build ad-hoc scripts to cover base APTS integration features.

## APTS Operational Contract Quick Reference

This section is the short operational summary for agents integrating with APTS. The formal machine-readable contract lives in `integracion/paquete-apts/apts_skills.json`, which is the single source of truth for the 21 operations.

### Common Required Fields

Over the remote MCP endpoint, identity fields omitted in payloads are auto-filled from the registration headers. The table below reflects raw API required fields.

| Field | Required by | Notes |
| --- | --- | --- |
| `project_url` | `register_task`, `create_backlog_item`, `read_project_context` (`url` query), `list_backlog_items` (`url` query), `search_similar_bug_reports` (`url` body), `heartbeat`, `log_agent_progress`, `report_blocker`, `update_task_status` | Resolve it from `git remote get-url origin`. |
| `agent_name` | `register_task`, `heartbeat`, `log_agent_progress`, `report_blocker`, `update_task_status` | Resolve it from `git config user.name`. |
| `agent_email` | `register_task`, `update_task_status` | Resolve it from `git config user.email`. |
| `branch` | `log_agent_progress` | Resolve it from `git branch --show-current`. |
| `task_id` | `heartbeat`, `log_agent_progress`, `report_blocker`, `update_task_status` | Returned by `register_task`; send it in each execution call (the endpoint is stateless). Calling `register_task` again with the same `backlog_item_id` resumes the task and returns the same id. |
| `backlog_item_id` | `register_task` when executing tracked work, `update_backlog_item`, `delete_backlog_item` | Use it to bind execution to backlog and avoid duplicate work. |

### Backlog Reuse Rule

If there is no active backlog item that describes exactly the change you are about to make, create a new backlog item first.

- For bug, error, or regression requests coming from chat, look for a matching non-deleted `bug` item first.
- If a matching item exists, reuse it.
- If no matching item exists, create one before implementation starts.
- For small chores such as documentation adjustments, reuse only when an active item already covers that exact scope; otherwise create a new one.

### Happy Path

1. Register the remote MCP endpoint (`APTS_API_KEY` plus the three identity values travel in the registration headers), then use its tools with minimum payloads (no manual identity pre-flight).
2. List backlog and decide whether to reuse an existing item or create a new one.
3. Call `register_task` and keep the returned `task_id`.
4. Call `read_project_context` before editing.
5. While working, alternate `heartbeat` with `log_agent_progress` at meaningful milestones.
6. If blocked, call `report_blocker` and stop.
7. Close with `update_task_status` to `review` first, then to `done` only after review and recent execution activity.

### Copy-Ready Payloads

These examples use the public contract shape exposed to clients via the official MCP server tools.

#### create_backlog_item

```json
{
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
	"title": "Document APTS minimum command payloads",
	"context": "Improve operator guidance for APTS contract-first commands.",
	"backlog_item_id": "11111111-1111-1111-1111-111111111111"
}
```

#### read_project_context

```json
{
	"limit": 5,
	"backlog_status": "in_progress"
}
```

#### heartbeat

```json
{
	"task_id": "22222222-2222-2222-2222-222222222222"
}
```

#### log_agent_progress

```json
{
	"message": "Added explicit required-field examples to AGENTS.md.",
	"technical_details": {
		"files_modified": [
			"AGENTS.md"
		],
		"commands_run": [
			"npm test"
		],
		"outcome": "success"
	}
}
```

#### update_task_status

```json
{
	"status": "review"
}
```

### Mutation Safety

- For `update_backlog_item` / `delete_backlog_item`, always pass `backlog_item_id` (never `id`).
- For high-risk text, use staged updates: a minimal field update first, then the full content update after the first call succeeds.
- Re-read backlog/task state after every mutating call and confirm persisted fields match expectations.

### Frequent Errors

| Error | Meaning | First check | Retry? |
| --- | --- | --- | --- |
| `INVALID_ARGUMENT` | Required field missing, invalid enum, invalid UUID, or malformed JSON. | Compare your payload with `apts_skills.json` and verify required fields first. | No. Fix the payload. |
| `401` / `403` | Missing or invalid `APTS_API_KEY`. | Environment variables and bearer token wiring. | No. Fix auth first. |
| `404` | Wrong route or resource id not found. | `task_id`, `backlog_item_id`, and base URL. | No, unless the id was just created and your client is stale. |
| `429` | Rate limited. | Backoff policy and duplicate retries. | Yes, short backoff, max 2 retries. |
| `5xx` or network error | Temporary server or connectivity failure. | APTS availability and network reachability. | Yes, short backoff, max 2 retries. |

Do not retry `400`, `401`, `403`, or `404` in a loop. If retries for `429`, network, or `5xx` still fail after two attempts, report a blocker and stop.
