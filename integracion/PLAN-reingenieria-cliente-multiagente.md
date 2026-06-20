# Plan de reingeniería: cliente APTS multi-runtime (Claude Code + opencode)

> Documento de planificación. Estado y avance se llevan en
> [`TRACKING-reingenieria-cliente-multiagente.md`](./TRACKING-reingenieria-cliente-multiagente.md).
> Fecha de redacción: 2026-06-20. Sin restricción de compatibilidad hacia atrás.

## 1. Objetivo

Que la integración con APTS funcione **igual de bien en Claude Code y en opencode**, con la
mínima superficie por runtime y sin duplicación de mantenimiento. Hoy el paquete está centrado
en VS Code/Copilot: no hay artefactos nativos de Claude Code ni de opencode más allá de rutas de
discovery mencionadas en texto.

## 2. Decisiones tomadas

| Decisión | Elección | Consecuencia |
|---|---|---|
| Superficie primaria cross-runtime | **MCP oficial** (`apts-mcp`, stdio sobre `apts-client`) | Tools nativas idénticas en ambos; CLI queda como fallback universal |
| Adaptadores por runtime | **Generados desde un spec único** | Cero drift; un solo lugar que editar |
| Compatibilidad hacia atrás | **No se mantiene** | Libertad para borrar gemelos CJS, helper y wrappers legacy |

## 3. Principios de diseño (post-reingeniería)

1. **MCP-first.** `apts-mcp` es la superficie principal en Claude Code (`.mcp.json`) y opencode
   (`opencode.json`), apuntando al mismo binario. El CLI permanece solo como fallback para
   runtimes sin MCP.
2. **ESM-only.** Los binarios se ejecutan como subprocesos (`node .ia/apts/apts-cli.js`,
   `node .ia/apts/apts-mcp.js`), nunca se importan desde el proyecto host, así que el sistema de
   módulos del host es irrelevante. Se elimina la dualidad CJS/ESM: un único set de archivos `.js`
   ESM con `.ia/apts/package.json` `{ "type": "module" }`. **Desaparece la regla de paridad
   `.js`/`.mjs`.**
3. **Contrato como única fuente de verdad.** `apts_skills.json` define las operaciones. El cliente,
   la tabla de comandos del CLI y la lista de tools MCP se **derivan/validan** del contrato en
   arranque. Un self-check falla si cliente ↔ contrato ↔ CLI ↔ MCP se desalinean. **Desaparece la
   regla de "reflejar la capacidad nueva en N archivos a mano".**
4. **Un spec → un generador → N runtimes.** `runtime-adapters/spec/apts-surface.json` describe
   agentes, comandos, permisos, instrucciones y hooks una sola vez; `scripts/generate-adapters.js`
   emite `.claude/`, `.opencode/` y `.github/` (VS Code). Archivos generados llevan banner
   "no editar".
5. **Instrucciones unificadas.** `AGENTS.md` es la fuente canónica (ambos runtimes la leen). En
   Claude Code, `CLAUDE.md` solo hace `@AGENTS.md`. Sección gestionada idempotente con marcadores
   `<!-- APTS:START/END -->`, una sola por archivo.
6. **Menos superficie.** Se elimina el helper standalone (`apts-helper.*`): con MCP primario + CLI
   fallback ya no tiene nicho. Se eliminan los gemelos CJS y los wrappers legacy.

## 4. Arquitectura objetivo

```
.ia/apts/                         # núcleo neutral, ESM-only, fuente de verdad
  package.json                    # { "type": "module" }
  apts_skills.json                # contrato único (15 operaciones)
  apts-client.js                  # cliente HTTP (única implementación)
  apts-cli.js                     # CLI fallback; tabla de comandos derivada del contrato
  apts-mcp.js                     # NUEVO: servidor MCP stdio sobre el cliente
  contract-check.js               # NUEVO: self-check cliente↔contrato↔CLI↔MCP

runtime-adapters/
  spec/apts-surface.json          # NUEVO: spec único de superficie de agentes
  claude/                         # GENERADO
    .mcp.json  CLAUDE.md  .claude/{agents,commands,skills,settings.json}
  opencode/                       # GENERADO
    opencode.json  AGENTS.md  .opencode/{agent,command,plugin}
  vscode/                         # GENERADO (migrado desde el actual escrito a mano)

scripts/generate-adapters.js      # NUEVO: spec → artefactos por runtime
```

Eliminados: `apts-client.mjs`, `apts-cli.mjs`, `apts-helper.js`, `apts-helper.mjs`,
plantillas `.agent.md` sueltas reemplazadas por las generadas.

## 5. Workstreams

### WS0 — Limpieza base y ESM-only
Renombrar a archivo único `.js` ESM, añadir `.ia/apts/package.json`, borrar gemelos CJS y el
helper, retirar de SKILL.md/README/AGENTS.md las reglas de paridad y de helper.

### WS1 — Núcleo dirigido por contrato
`contract-check.js` que cargue `apts_skills.json` y verifique que el cliente exporta exactamente
esas 15 operaciones, que el CLI registra esos comandos y que el MCP expone esas tools. El CLI deriva
su tabla de comandos del contrato (nombre, descripción, inputSchema). Arranque aborta si hay
desalineación.

### WS2 — Servidor MCP (`apts-mcp.js`)
Servidor stdio con `@modelcontextprotocol/sdk`. Una tool por operación del contrato, `inputSchema`
tomado del contrato, reusando el autofill de identidad del cliente (env → `.apts/execution-context.json`
→ git). Soporta `--output structured`-equivalente devolviendo contenido JSON estructurado.

### WS3 — Spec único + generador
Definir `spec/apts-surface.json` (agentes, comandos, permisos, instrucciones, hooks) y
`generate-adapters.js` que traduzca a cada runtime resolviendo las divergencias:

| Concepto del spec | Claude Code | opencode | VS Code |
|---|---|---|---|
| Registro MCP | `.mcp.json` | `opencode.json` `mcp` | (n/a, usa tools) |
| Agentes | `.claude/agents/*.md` | `.opencode/agent/*.md` | `.github/agents/*.agent.md` |
| Comandos | `.claude/commands/*.md` | `.opencode/command/*.md` | (n/a) |
| Permisos | `.claude/settings.json allow[]` | `opencode.json permission` | (n/a) |
| Instrucciones | `CLAUDE.md`→`@AGENTS.md` | `AGENTS.md` | `.github/copilot-instructions.md` |
| Hooks | `settings.json hooks` | `.opencode/plugin/*.ts` | (n/a) |

### WS4 — Adaptadores generados
Generar y verificar los tres runtimes. Comandos objetivo: `/apts-next`, `/apts-bug`,
`/apts-status`, `/apts-resume`. Agentes: orquestador (entrypoint), ejecutor (subagente),
intake-bugfix.

### WS5 — Instrucciones unificadas
`AGENTS.md` canónico con sección gestionada; `CLAUDE.md` mínimo con `@AGENTS.md`. Reescribir el
routing de shell en términos de runtime (Bash/PowerShell de Claude Code, bash de opencode) en lugar
de tareas de VS Code/WSL.

### WS6 — Manifiesto y versionado
Bump `schema_version`, nota **append-only** prepended en `bootstrap.manifest_updates.notes`,
metadatos `artifact_version`/`updated_in_schema_version`/`sync_action`/`deprecated_filenames` para
cada artefacto nuevo y para los eliminados (que los actualizadores locales limpien los legacy:
`apts-client.mjs`, `apts-cli.mjs`, `apts-helper.*`).

### WS7 — Validación end-to-end
Probar en Claude Code y en opencode: registro MCP, `register_task` → `read_project_context` →
`log_agent_progress` → `heartbeat` → `update_task_status review`, y un flujo `/apts-bug` con
`search_similar_bug_reports`.

## 6. Convenciones del repo que siguen vigentes

- Todo cambio en artefactos descargables exige bump de `schema_version` + nota append-only.
- Versionado por artefacto para sync/limpieza determinista de legacy.
- Los artefactos generados se tratan como **gestionados**: se sobrescriben enteros, nunca se mergean
  a mano; el editable es el spec.

## 7. Riesgos

- **SDK MCP como dependencia nueva.** Mantener `apts-mcp` fino; si se quiere cero-deps, evaluar
  implementar el protocolo stdio mínimo a mano (decisión registrada en tracking).
- **opencode hooks ≠ Claude hooks.** Los hooks/plugins quedan como WS opcional tardío; el flujo base
  funciona sin ellos vía MCP.
- **Limpieza de legacy en clientes ya integrados.** El manifiesto debe declarar `deprecated_filenames`
  para que los actualizadores borren los gemelos y el helper.

## 8. Orden sugerido de ejecución

WS0 → WS1 → WS2 → (WS5 en paralelo) → WS3 → WS4 → WS6 → WS7.
