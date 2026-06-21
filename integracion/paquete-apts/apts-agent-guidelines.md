# Base Guide for Projects Integrated with APTS

This guide explains how to install the APTS-managed instructions into a client project's canonical `AGENTS.md`. Both Claude Code and opencode read `AGENTS.md`. In Claude Code, keep `CLAUDE.md` minimal with a single line `@AGENTS.md` so there is one source of truth.

The APTS-managed section (the operational rules an integrated agent must follow) is **not authored here**: it is defined once in `runtime-adapters/spec/apts-surface.json` (`instructions.body`) and generated verbatim into each runtime's instruction file. On upgrades, replace only that managed block and preserve project-specific rules outside it. Keep exactly one managed section per instruction file.

## AGENTS.md bootstrap policy (create or update)

1. If neither `AGENTS.md` nor `.github/copilot-instructions.md` exists, create `AGENTS.md` with the managed block below.
2. If `AGENTS.md` already exists, keep project-specific rules and only merge or refresh the APTS-managed section.
3. If `AGENTS.md` does not exist but `.github/copilot-instructions.md` exists, merge or refresh the same managed section there.
4. On repeated installs or updates, do not duplicate instructions. Update the existing managed section in place.
5. In Claude Code, `CLAUDE.md` only contains `@AGENTS.md`; never duplicate guidance into `CLAUDE.md`.

Treat downloaded official APTS scripts and generated adapter files as managed: replace them entirely on version updates and do not merge legacy wrapper snippets into them. The only hand-editable surface source is `runtime-adapters/spec/apts-surface.json`.

## APTS-managed section (canonical source)

The APTS-managed instruction block — the operational rules an integrated agent must follow at runtime (MCP-only surface, identity autofill, backlog as source of truth, shell routing by runtime, resilience journal, and the mandatory/anti-loop rules) — is defined **once** in `runtime-adapters/spec/apts-surface.json` under `instructions.body`, and generated verbatim into each runtime's instruction file:

- **Claude Code:** `runtime-adapters/claude/CLAUDE.md` (which also imports `@AGENTS.md`)
- **opencode:** `runtime-adapters/opencode/AGENTS.md`
- **VS Code:** `runtime-adapters/vscode/copilot-instructions.md`

Each generated file wraps the body with the `<!-- APTS:START -->` / `<!-- APTS:END -->` markers. To install or upgrade a client, copy that managed block from the generated file for the target runtime into the client's instruction file, replacing only the existing managed section and preserving project-specific rules outside it.

Never hand-edit the managed rules — not here, and not in the generated files. The only editable source is `instructions.body` in the spec; after editing it, regenerate with `node scripts/generate-adapters.js`.

## Operational Quick Reference

Use `integracion/paquete-apts/apts_skills.json` as the formal contract and `integracion/paquete-apts/references/api-contract.md` as the human-readable source of truth.

### Common Required Fields

When using the official MCP server, missing identity fields are auto-filled from env/local context/Git. The table lists server-required fields for raw API calls.

| Field | Required by |
| --- | --- |
| `project_url` | `register_task`, `create_backlog_item`, `heartbeat`, `log_agent_progress`, `report_blocker`, `update_task_status` |
| `url` | `read_project_context`, `list_backlog_items`, `search_similar_bug_reports` |
| `agent_name` | `register_task`, `heartbeat`, `log_agent_progress`, `report_blocker`, `update_task_status` |
| `agent_email` | `register_task`, `update_task_status` |
| `branch` | `log_agent_progress` |
| `task_id` | `heartbeat`, `log_agent_progress`, `report_blocker`, `update_task_status` |
| `backlog_item_id` | `register_task` when executing tracked work, `update_backlog_item`, `delete_backlog_item` |

### Happy Path

1. Ensure `APTS_BASE_URL` and `APTS_API_KEY` are available and rely on autofill for identity/task context.
2. Call `list_backlog_items` (prefer `view = compact`) and choose to reuse or create an item.
3. Call `register_task`; the official client persists the returned `task_id` in local managed context.
4. Call `read_project_context` (prefer `view = compact`) before editing.
5. Call `heartbeat` while the task is active.
6. Call `log_agent_progress` on meaningful milestones.
7. If blocked, call `report_blocker` and stop.
8. Finish with `update_task_status` to `review`, then `done` only after review and recent activity.

### Compact Response Mode

- `list_backlog_items` and `read_project_context` default to compact summaries. Re-read with `view = full` only for the selected item or when raw detail is needed.

### Mutation safety

- For `update_backlog_item` / `delete_backlog_item`, always pass `backlog_item_id` (never `id`).
- For high-risk text, use staged updates: a minimal field update first, then the full content update after the first call succeeds.
- Re-read backlog/task state after every mutating call and confirm persisted fields match expectations.

## Anti-Patterns

- Writing one-off code that imports or bootstraps `apts-client.js` directly during a chat turn.
- Building JSON manually with string concatenation when an object payload is available.
- Running `git remote get-url origin`, `git config user.name`, and `git branch --show-current` before every APTS call instead of relying on autofill.
- Calling the raw HTTP API for base operations when the MCP server already covers the workflow.
- Creating a new wrapper script per runtime interaction instead of reusing the MCP server.

### Frequent Errors

| Error | Meaning | Retry |
| --- | --- | --- |
| `INVALID_ARGUMENT` | Missing required field, invalid enum, invalid UUID, or malformed JSON. | No. Fix payload first. |
| `401` / `403` | Missing or invalid API key. | No. Fix auth first. |
| `404` | Wrong resource id or route. | No, unless the reference is stale and can be refreshed deterministically. |
| `429` | Rate limited. | Yes, up to 2 retries with short backoff. |
| Network error / `5xx` | Temporary server or connectivity failure. | Yes, up to 2 retries with short backoff. |
