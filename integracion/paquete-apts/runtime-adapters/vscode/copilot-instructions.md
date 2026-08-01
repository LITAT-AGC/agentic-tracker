<!-- GENERADO — no editar; fuente: spec/apts-surface.json -->

<!-- APTS:START -->
## APTS integration (managed section)

You are a development agent integrated with APTS (Agentic Project Tracking Service).

### Surface

- **MCP-only.** The APTS MCP server (`apts`) is the only supported surface and exposes one native tool per operation: `register_task`, `read_project_context`, `list_backlog_items`, `get_backlog_item`, `get_task`, `get_project_constraints`, `search_similar_bug_reports`, `create_backlog_item`, `update_backlog_item`, `delete_backlog_item`, `update_task_status`, `log_agent_progress`, `report_blocker`, `heartbeat`. Use these tools. If the active runtime cannot register an MCP server, that is a runtime setup issue to resolve with the operator, not a reason to fall back to another surface.
- The server may be registered as a local process or as a remote HTTP endpoint. That is a setup choice made once by the operator and it does not change how you call the tools.
- Never generate fresh code that imports or bootstraps a raw APTS HTTP client from scratch during a chat turn. Direct client usage lives only inside the MCP server itself.

### Backlog is the source of truth

- The APTS backlog and APTS task state are the single operational source of truth for what to work on and its status.
- Do not use local planning or tracking documents (checklists, mirrors, deleted compatibility files) as operational tracking, and do not read pending status from them. Enrich planning inside the APTS backlog with backlog operations instead of local checklist files.

### Credentials

If `APTS_API_KEY` is not available in the project environment, request it from the human operator before any protected APTS call. Store it as an environment variable or in the project's secret system. Never hardcode it in source, prompts, JSON, or backlog documents.

Define the integration variables in a `.env` file at the client project root:

```env
APTS_BASE_URL=https://apts.informaticos.ar/api
APTS_API_KEY=place-your-api-key-here
APTS_PROJECT_URL=https://github.com/your-org/your-repo.git
APTS_AGENT_NAME=your-agent-name
APTS_AGENT_EMAIL=your-agent@example.com
```

If a secret manager is used instead of `.env`, it must expose the same variable names. The operator wires these into the MCP server registration once; you never read them yourself.

### Identity

The integration layer supplies `project_url`/`url`, `agent_name` and `agent_email` before the call reaches APTS. Where it takes them from depends on how the server was registered, and that is not your concern: send minimal payloads and do not spend turns resolving identity by hand.

Two fields always travel in the call, because nothing can resolve them for you:
- `task_id` on execution calls. `register_task` returns it; reuse that value.
- `branch` on `log_agent_progress`. Optional, and only a traceability field: send it when it matters, since a remotely registered server never sees your repository.

A missing-identity error is a configuration problem, not missing content: report it to the operator instead of guessing a value. If you call the raw HTTP API directly, without the MCP server, send every required identity field explicitly.

### Shell routing by runtime

- **Claude Code:** use the Bash tool for POSIX scripts and tests; use PowerShell for Windows-native operations. Use the runtime's native non-blocking process primitives for long-running validation servers and stop them after tests.
- **opencode:** use bash. For long-running servers under synchronous bash, use a background/PTY process primitive (e.g. an opencode background/pty plugin) rather than relying only on `&` or `nohup`.
- Other runtimes: use the runtime's native background/PTY primitives; if unavailable, avoid server-dependent validation and report a blocker.

### Resilience journal

Maintain a local append-only resilience journal (e.g. `.apts/agent-resilience-log.jsonl`). It is an operational fallback, not a source of truth, and never replaces APTS. Record execution start, milestones, blockers, APTS sync failures, and completion. Never store secrets in it.

### Mandatory rules

0. For "next task", "continue backlog", "run backlog", or equivalent, invoke the APTS backlog orchestrator agent first; do not run direct implementation from the general agent. If the orchestrator is not installed/invocable, stop and ask the operator to install/fix it.
1. Use the APTS MCP tools as the integration layer. Prefer minimum payloads and avoid pre-flight Git identity commands.
2. Invoke operations with contract-first JSON object payloads (e.g. `{"status":"review"}`).
3. For bug/error/regression requests from chat, run read-only triage first: search the backlog for a matching non-deleted `bug` item (prefer `search_similar_bug_reports`) and verify the symptom is a real defect.
   - If intent is ambiguous (question, clarification, diagnosis), stop at read-only triage and ask whether to register it as a bug in APTS.
4. If no matching bug item exists, create it with `create_backlog_item` (`item_type: "bug"`) only after explicit user confirmation, capturing symptom, expected/observed behavior, and reproduction evidence. When a stable thread id exists, set `source_kind: "chat_request"` and `source_ref`.
5. For "report this as a resolved bug in APTS", update the tracked item with `update_backlog_item`, set status `review` or `done`, and include resolution plus validation evidence.
6. Do not start direct implementation for a new defect until it is represented in the backlog and the task can reference its `backlog_item_id`.
7. Backlog execution: read with `list_backlog_items` (paginated — limit defaults to 50, max 200, offset defaults to 0; page through large backlogs rather than fetching everything); call `register_task` with `backlog_item_id` and use the returned `task_id` (this may resume interrupted work); call `read_project_context` before editing (orientation only, not the execution loop: its tasks and backlog sections are paginated — default 50, max 200 each — via tasks_limit/tasks_offset and backlog_limit/backlog_offset; page through large backlogs rather than fetching everything, and drive the loop with apts_next/apts_workflow_step); send `heartbeat` periodically; record milestones with `log_agent_progress`; on blockers use `report_blocker` and stop.
8. At completion set `review` first; promote to `done` only from review and only with recent execution activity.
9. Never invent `project_url`, `agent_name`, `agent_email`, or `branch`. Either the integration layer supplies them or you send real values; a missing-field error is a setup issue to raise with the operator, never a value to guess.
10. Anti-loop retry policy: do not retry on `400/401/403/404` (contract/auth/existence — record and ask). Retry only on network errors, `429`, and `5xx`, at most 2 retries with short backoff; then report a blocker and stop.
<!-- APTS:END -->
