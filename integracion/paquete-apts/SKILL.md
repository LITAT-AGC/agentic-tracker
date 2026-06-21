---
name: apts
description: 'Integrate a project with APTS. Use when adding agent tracking, installing APTS tools or prompts, wiring register_task, read_project_context, log_agent_progress, heartbeat, report_blocker, or update_task_status against the APTS API.'
argument-hint: 'Describe the client project and the type of APTS integration you need'
user-invocable: true
---

# APTS Integration Skill

This skill packages the minimum resources needed to connect a client project with APTS without rebuilding the workflow from scratch.

Note: in this repository, it is published as integration material under the repository-level APTS package folder to avoid confusion with active customizations of the APTS project itself.

## Surface model (read this first)

- **MCP-only.** `apts-mcp` is the only supported integration surface. It exposes one native tool per contract operation and works identically in Claude Code (`.mcp.json`) and opencode (`opencode.json`), pointing to the same binary. If a runtime cannot register an MCP server, resolve the runtime setup with the operator; there is no alternative script surface.
- **ESM-only.** A single `.js` file set runs as ESM via `package.json` `{ "type": "module" }`. The MCP server is executed as a subprocess (`node .ia/apts/apts-mcp.js`); it is never imported by the host project, so the host module system is irrelevant. There is no CJS twin and no standalone helper.
- **Contract is the single source of truth.** `apts_skills.json` defines the operations. The client exports and the MCP tool list are derived/validated from it by `contract-check.js`. A self-check aborts startup on misalignment.

## When to use it

- When a project needs to report agent work to APTS.
- When you need native MCP tools for the APTS workflow in Claude Code or opencode.
- When you want to install instructions or prompts so the agent follows the APTS workflow.
- When you need the tools JSON contract in a downloadable format together with the skill.

## What it includes

- [API contract](./references/api-contract.md)
- [Skills JSON contract](./apts_skills.json) — single source of truth
- [HTTP client (ESM)](./apts-client.js)
- [MCP server (ESM)](./apts-mcp.js)
- [Contract self-check](./contract-check.js)
- [Base guide for AGENTS.md / CLAUDE.md / copilot-instructions.md](./apts-agent-guidelines.md)
- [Runtime surface spec](./runtime-adapters/spec/apts-surface.json) and [adapter generator](./scripts/generate-adapters.js)

## Recommended usage for AI agents

- Use the MCP tools in any supported runtime (Claude Code, opencode). If MCP cannot be registered, resolve the runtime setup with the operator; there is no alternative surface.
- Never generate fresh direct-client bootstrap code during an interaction. Direct `apts-client.js` import is reserved for the bundled MCP server entrypoint.

## Workspace installation policy (recommended)

- Use a workspace-local, runtime-neutral base folder: `.ia/apts/`.
- Keep the APTS contract, the HTTP client, the MCP server, `contract-check.js`, and `package.json` (`{ "type": "module" }`) in that base folder.
- Treat official APTS scripts and generated adapter files as managed artifacts: replace them as full files on updates and never merge legacy local wrapper code into them. The only hand-editable surface source is the spec.
- Register the MCP server per runtime (`.mcp.json` for Claude Code, `opencode.json` `mcp` for opencode). These adapter files are generated from `runtime-adapters/spec/apts-surface.json`.
- Avoid user-global skill installation for project integrations because it increases cross-project configuration leakage and version drift.

## AGENTS.md setup policy (mandatory)

- `AGENTS.md` is the canonical instructions file read by both runtimes. In Claude Code, `CLAUDE.md` only contains `@AGENTS.md`.
- If neither `AGENTS.md` nor `.github/copilot-instructions.md` exists in the client project, create `AGENTS.md` with the APTS-managed section generated from the spec (see [apts-agent-guidelines.md](./apts-agent-guidelines.md) for the install/upgrade policy; the managed block itself is generated into `runtime-adapters/{claude,opencode,vscode}/`).
- If either file already exists, do not replace the full file. Merge or refresh only the APTS-managed section and preserve project-specific rules.
- Use idempotent markers (`<!-- APTS:START -->` and `<!-- APTS:END -->`) so future APTS upgrades can update guidance without duplicating content.
- Keep only one APTS-managed section per instruction file.

## Recommended procedure

1. Review the [API contract](./references/api-contract.md) to confirm variables, endpoints, and payloads.
2. Create `.ia/apts/` in the client project and copy [apts_skills.json](./apts_skills.json), [apts-client.js](./apts-client.js), [apts-mcp.js](./apts-mcp.js), [contract-check.js](./contract-check.js), and a `package.json` with `{ "type": "module" }` there.
3. Register the MCP server in the runtime:
   - Claude Code: `.mcp.json` entry running `node .ia/apts/apts-mcp.js`.
   - opencode: `opencode.json` `mcp` entry running the same binary.
4. Apply the AGENTS setup policy: create `AGENTS.md` when no instruction file exists, or merge/update one APTS-managed section. In Claude Code add `CLAUDE.md` with `@AGENTS.md`.
5. Configure `APTS_BASE_URL` and `APTS_API_KEY` in a `.env` file at the client project root (or an equivalent secret manager that exposes them as environment variables).
   - Optional but recommended: set `APTS_PROJECT_URL`, `APTS_AGENT_NAME`, `APTS_AGENT_EMAIL`, `APTS_BRANCH`, `APTS_TASK_ID`, `APTS_CONTEXT_FILE`, and `APTS_ENV_FILE` to reduce repeated payload fields and make env resolution deterministic.
6. Validate the integration by running `register_task`, then `read_project_context`, `log_agent_progress`, `heartbeat`, and `update_task_status review` via the MCP tools with minimal payloads.

## Identity autofill note

When payload fields are omitted, the official client resolves identity from env first, then the local managed execution context file, and then local Git (`project_url/url`, `agent_name`, `agent_email`, `branch`), and resolves `task_id` from `APTS_TASK_ID` or managed context for execution calls. The MCP server runs that same client, so this autofill applies to every MCP tool call.

Protocol overhead rule: do not run manual Git identity discovery as a default step. Start with minimum payloads and only inspect execution context when a call reports missing required fields.

Shell routing rule: the canonical *Shell routing by runtime* guidance lives in the APTS-managed section (`runtime-adapters/spec/apts-surface.json` → `instructions.body`, generated per runtime). In short: in Claude Code use the Bash tool for POSIX scripts and PowerShell for Windows-native operations; in opencode use bash; route long-running validation servers through the runtime's native non-blocking process primitives. Do not duplicate or override the managed section here.

Managed execution context note: official scripts persist execution context at `.apts/execution-context.json` by default (override with `APTS_CONTEXT_FILE`). Inspect or edit that file directly to review or reset the managed identity state.

Task recovery note: during backlog execution, call `register_task` with `backlog_item_id` so APTS can resume interrupted `todo`/`in_progress`/`stalled` tasks instead of creating duplicates.

Task close note: prefer `review` first and promote to `done` only after review policy passes and recent execution activity is present.

## Official surface coverage

- The HTTP client (`apts-client.js`) must export exactly the operations declared in `apts_skills.json`.
- The MCP server (`apts-mcp.js`) must expose exactly those operations; its tool table is derived from the contract, not hand-maintained.
- `contract-check.js` fails startup if client ↔ contract ↔ MCP drift.
- Do not create parallel wrappers or scripts to cover base-flow functions. If a new backend capability is introduced, add it first to `apts_skills.json` and the client, then regenerate adapters.

## Backlog execution policy (mandatory)

- For execution requests such as "next task", "continue backlog", or "run backlog", the entry point must be the APTS backlog orchestrator agent (`/apts-next`).
- Do not execute direct implementation from the general agent when a backlog run applies.
- If the orchestrator agent is not available in the client project, stop and ask the operator to install/fix the adapter before continuing.

## Bug reporting policy (mandatory)

- If a user chat asks to fix/report a bug, investigate an error, or resolve a regression/broken behavior, inspect the APTS backlog for an existing matching non-deleted bug item.
- Before creating a new bug item, prefer `search_similar_bug_reports` with the defect symptom to detect semantic duplicates.
- If a matching bug item already exists, reuse it instead of creating a duplicate defect entry.
- If no matching bug item exists, create it with `create_backlog_item` using `item_type: "bug"` only after the user explicitly confirms they want it tracked.
- Capture symptom, expected behavior, observed behavior, and reproduction evidence in that tracked bug item.
- When the runtime exposes a stable conversation or thread identifier, store `source_kind: "chat_request"` and persist that identifier in `source_ref`.
- For "report this solved issue as resolved bug in APTS", update the tracked bug item with `update_backlog_item` and move status to `review` or `done`, including concise resolution and validation evidence.
- Do not start direct implementation for a newly reported defect until it is represented in the APTS backlog and execution can reference that `backlog_item_id`.

## Expected result

The client project ends up with:

- a single tools contract for APTS,
- native MCP tools over one ESM HTTP client,
- runtime-aware process management guidance for server-based validations,
- and operational instructions so agents report work consistently, including creating or reusing bug backlog items before implementing chat-triggered defect fixes and reporting solved defects with resolution evidence.
