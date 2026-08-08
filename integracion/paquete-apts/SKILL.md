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

- **One surface: the remote MCP endpoint.** Register it and every contract operation arrives through `tools/list`. Nothing is downloaded, no local process runs, and there is no artifact version to keep in sync. If a runtime cannot register an MCP server, resolve the runtime setup with the operator; there is no alternative surface.
- **Registration is a URL plus four headers.** `Authorization` carries the access key; the three `X-APTS-*` headers carry project and agent identity. The public manifest publishes the exact block per runtime under `mcp_endpoint.registration_by_runtime` — copy it as-is.
- **Identity comes from the registration, not from the environment.** The server does not inspect your filesystem, your environment or your Git checkout. A value sent in the call arguments wins over the header, which is how an agent switches role; a `project_url` that contradicts the header is rejected.
- **Contract is the single source of truth.** `apts_skills.json` defines the operations. The backend validates its own surface against it at startup and refuses to serve on drift.

## When to use it

- When a project needs to report agent work to APTS.
- When you need native MCP tools for the APTS workflow in Claude Code or opencode, the two supported runtimes.
- When you want to install instructions or prompts so the agent follows the APTS workflow.
- When you need the tools JSON contract in a downloadable format together with the skill.

## What it includes

- [Skills JSON contract](./apts_skills.json) — single source of truth
- [Base guide for AGENTS.md / CLAUDE.md](./apts-agent-guidelines.md)
- [Runtime surface spec](./runtime-adapters/spec/apts-surface.json) and [adapter generator](./scripts/generate-adapters.js)

## Recommended procedure

1. Read the public manifest at `GET /api/public/integrar`.
2. Copy the block for your runtime from `mcp_endpoint.registration_by_runtime` into the runtime config file (`.mcp.json` for Claude Code, `opencode.json` for opencode).
3. Provide the values that block references: `APTS_API_KEY`, `APTS_PROJECT_URL`, `APTS_AGENT_NAME`, `APTS_AGENT_EMAIL` (the endpoint URL comes embedded in the manifest block; only the static generated adapters reference it as `APTS_MCP_URL`). Keep the key in a `.env` file at the client project root or an equivalent secret store — never in source code, versioned prompts or backlog documents.
4. Apply the AGENTS setup policy below: create `AGENTS.md` when no instruction file exists, or merge/update one APTS-managed section. In Claude Code add `CLAUDE.md` with `@AGENTS.md`.
5. Validate the integration by calling `register_task`, then `read_project_context`, `log_agent_progress`, `heartbeat` and `update_task_status review`, all with minimal payloads.

To drive the BMAD method lifecycle end to end, read `method_conduction` from the same manifest: it carries the conduction loop as data.

## Agents and commands (do this, not optional)

The four agents and the five commands are NOT downloaded one by one: run `scripts/generate-adapters.js` over `runtime-adapters/spec/apts-surface.json` and copy the directory for your runtime — `runtime-adapters/claude/` or `runtime-adapters/opencode/` — into the client project root, keeping the relative paths. That single copy brings the MCP registration, the instruction file, the permissions, the four agents and the five slash commands (`apts-next`, `apts-method`, `apts-bug`, `apts-status`, `apts-resume`).

Skipping this leaves the project without the method orchestrator and without any command, and the whole lifecycle has to be conducted by hand. Generated adapters are managed output: never hand-edit them — edit the spec and regenerate.

## Unattended implementation loop (optional)

Once the initiative reaches `implementation`, the loop conductor (`conductor/apts-loop.js`, published as the `loop_conductor` artifact) grinds the stories on its own: one agent process per story with fresh context, until the engine says `done` or a brake trips. Read its README first — `--agent-cmd` is mandatory and its shape depends on the runtime. It does not conduct the generative phases, which are interactive.

## AGENTS.md setup policy (mandatory)

- `AGENTS.md` is the canonical instructions file read by the runtimes. In Claude Code, `CLAUDE.md` only contains `@AGENTS.md`.
- If `AGENTS.md` does not exist in the client project, create it with the APTS-managed section generated from the spec (see [apts-agent-guidelines.md](./apts-agent-guidelines.md) for the install/upgrade policy).
- If it already exists, do not replace the full file. Merge or refresh only the APTS-managed section and preserve project-specific rules.
- Use idempotent markers (`<!-- APTS:START -->` and `<!-- APTS:END -->`) so future upgrades update guidance without duplicating content.
- Keep only one APTS-managed section per instruction file.

## Installation policy

- Keep APTS integration material local to each repository and avoid user-global skill installation, which increases cross-project configuration leakage and version drift.
- Treat generated adapter files as managed artifacts: replace them as full files on updates and never merge local wrapper code into them. The only hand-editable surface source is the spec.
- Do not create parallel wrappers or scripts to cover base-flow operations. If a new backend capability is introduced, add it to `apts_skills.json` first, then regenerate the adapters.

## Operational notes

- **Shell routing.** The canonical *Shell routing by runtime* guidance lives in the APTS-managed section (`runtime-adapters/spec/apts-surface.json` → `instructions.body`, generated per runtime). In short: in Claude Code use the Bash tool for POSIX scripts and PowerShell for Windows-native operations; in opencode use bash; route long-running validation servers through the runtime's native non-blocking process primitives. Do not duplicate or override the managed section here.
- **Minimal payloads.** Do not run manual identity pre-flight commands. Start with minimum payloads; if a call reports a missing identity field, it is a setup issue for the operator, not a value to guess.
- **Task recovery.** During backlog execution, call `register_task` with `backlog_item_id` so APTS resumes interrupted `todo`/`in_progress`/`stalled` tasks instead of creating duplicates.
- **Task close.** Prefer `review` first and promote to `done` only after the review policy passes and recent execution activity is present.
