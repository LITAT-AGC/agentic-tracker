# Integracion con APTS

Esta carpeta agrupa todo el material destinado a proyectos cliente que quieran integrarse con APTS.

Se mantiene fuera de `.github/` para evitar que VS Code/Copilot lo trate como customizacion activa del propio repositorio APTS.

## Modelo de superficie

- **MCP primario.** `apts-mcp.js` expone una tool nativa por operacion del contrato y funciona igual en Claude Code (`.mcp.json`) y opencode (`opencode.json`), apuntando al mismo binario.
- **CLI como fallback universal.** `apts-cli.js` cubre runtimes sin MCP y uso manual/automatizado. Mismas operaciones, mismo autofill de identidad.
- **ESM-only.** Un unico set de archivos `.js` corre como ESM gracias a `package.json` `{ "type": "module" }`. Los binarios se ejecutan como subprocesos (`node .ia/apts/apts-cli.js`, `node .ia/apts/apts-mcp.js`); nunca se importan desde el proyecto host. No hay gemelo CJS ni helper standalone.
- **Contrato como unica fuente de verdad.** `apts_skills.json` define las operaciones; el cliente, la tabla del CLI y la lista de tools MCP se derivan/validan desde el contrato con `contract-check.js`.

## Estructura

- `plantillas-agentes/`: plantillas de agentes para intake, orquestacion y ejecucion contra APTS (`intake-bugfix-apts.agent.md`, `orquestador-backlog-apts.agent.md`, `ejecutor-item-backlog-dev-test-commit.agent.md`).
- `paquete-apts/`: paquete exportable con contrato JSON, cliente HTTP ESM, CLI oficial, servidor MCP, self-check del contrato, guia operativa y referencia de API.
- `paquete-apts/runtime-adapters/`: artefactos por runtime generados desde `spec/apts-surface.json` (`claude/`, `opencode/`, `vscode/`).
- `paquete-apts/scripts/generate-adapters.js`: generador unico spec → adaptadores.

## Uso recomendado

1. Copia desde `paquete-apts/` el contrato JSON, el cliente HTTP, el CLI, el servidor MCP, `contract-check.js` y un `package.json` con `{ "type": "module" }` a `.ia/apts/` del proyecto cliente.
2. Registra el servidor MCP en el runtime: `.mcp.json` (Claude Code) u `opencode.json` `mcp` (opencode), apuntando a `node .ia/apts/apts-mcp.js`. Usa el CLI solo como fallback cuando el runtime no soporte MCP.
3. Copia desde `plantillas-agentes/` (o desde `runtime-adapters/`) las plantillas de agentes si quieres un flujo intake/orquestador/ejecutor apoyado en backlog de APTS.
4. Crea `AGENTS.md` (canonico) y, en Claude Code, `CLAUDE.md` con `@AGENTS.md`.

## Regla de cobertura del cliente exportable

- El cliente HTTP oficial (`apts-client.js`) debe exportar exactamente las operaciones publicadas en `apts_skills.json`.
- El CLI (`apts-cli.js`) y el MCP (`apts-mcp.js`) exponen exactamente esas operaciones; sus tablas se derivan del contrato, no se mantienen a mano.
- `contract-check.js` aborta el arranque si cliente ↔ contrato ↔ CLI ↔ MCP se desalinean.
- El proyecto cliente no deberia desarrollar scripts extra para operaciones base. Si aparece una brecha funcional, se corrige primero en `apts_skills.json` y el cliente, y luego se regeneran los adaptadores.

## Artefactos generados

- Los archivos bajo `runtime-adapters/{claude,opencode,vscode}/` se tratan como **gestionados**: se regeneran enteros desde el spec con `node paquete-apts/scripts/generate-adapters.js` y llevan banner "GENERADO — no editar". El unico editable es `spec/apts-surface.json`.

## Manifiesto publico

Si modificas el manifiesto publico de integracion expuesto por APTS en `/api/public/integrar`, sube `schema_version` y registra una nota nueva (append-only, prepended) en `bootstrap.manifest_updates.notes`. El manifiesto expone metadatos de sincronizacion por artefacto (`artifact_version`, `updated_in_schema_version`, `sync_action`, `deprecated_filenames`) y una politica global (`bootstrap.artifact_sync_policy`) que los actualizadores locales usan para sobreescribir y limpiar archivos legacy (incluidos los gemelos CJS y el helper retirados).

## Nota

Los archivos aqui presentes son artefactos de integracion y distribucion. No son customizaciones activas del workspace APTS.
