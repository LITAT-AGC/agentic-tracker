# Integracion con APTS

Esta carpeta agrupa el material destinado a proyectos cliente que quieran integrarse con APTS.

Se mantiene fuera de `.github/` para evitar que VS Code/Copilot lo trate como customizacion activa del propio repositorio APTS.

## Modelo de superficie

- **Una sola superficie: el endpoint MCP remoto.** Se registra con una URL y cuatro cabeceras, y las operaciones del contrato llegan por `tools/list`. No hay nada que descargar, ningun proceso local que arrancar ni version de artefacto que mantener sincronizada. Si un runtime no puede registrar un servidor MCP, es un problema de configuracion que se resuelve con el operador; no hay superficie alternativa.
- **La identidad viaja en el registro.** `Authorization` lleva la clave; las tres cabeceras `X-APTS-*` llevan proyecto y agente. El servidor no mira el sistema de archivos, el entorno ni Git del cliente. Un valor enviado en los argumentos gana a la cabecera —asi conmuta de rol un agente— y un `project_url` que contradiga la cabecera se rechaza.
- **El contrato es la unica fuente de verdad.** `apts_skills.json` define las operaciones. El backend valida su propia superficie contra el en el arranque y se niega a servir si se han separado.
- **El bucle del metodo se publica como dato.** `method_conduction`, en el manifiesto publico, lleva las reglas para conducir el ciclo BMAD. Las plantillas de agente apuntan a el en vez de repetirlo.

## Estructura

- `plantillas-agentes/`: plantillas de agentes para intake, orquestacion, ejecucion y conduccion del metodo.
- `paquete-apts/`: contrato JSON, guia operativa para `AGENTS.md`, guia de empaquetado y referencia de API.
- `paquete-apts/runtime-adapters/`: artefactos por runtime generados desde `spec/apts-surface.json` (`claude/`, `opencode/`, `vscode/`).
- `paquete-apts/scripts/generate-adapters.js`: generador unico spec → adaptadores.

## Uso recomendado

1. Lee el manifiesto publico en `GET /api/public/integrar`.
2. Copia el bloque de tu runtime desde `mcp_endpoint.registration_by_runtime` al archivo de configuracion correspondiente (`.mcp.json`, `opencode.json` o `.vscode/mcp.json`).
3. Aporta los valores que ese bloque referencia: `APTS_API_KEY`, `APTS_PROJECT_URL`, `APTS_AGENT_NAME` y `APTS_AGENT_EMAIL` (la URL del endpoint viene embebida en el bloque; solo los adaptadores estaticos generados la referencian como `APTS_MCP_URL`).
4. Crea `AGENTS.md` (canonico) y, en Claude Code, `CLAUDE.md` con `@AGENTS.md`.
5. Si el runtime admite agentes propios, genera los adaptadores con `node paquete-apts/scripts/generate-adapters.js` y copialos donde el runtime los descubra.

## Artefactos generados

Los archivos bajo `runtime-adapters/{claude,opencode,vscode}/` se tratan como **gestionados**: se regeneran enteros desde el spec y llevan banner "GENERADO — no editar". El unico editable es `spec/apts-surface.json`.

## Manifiesto publico

Si modificas el manifiesto expuesto en `/api/public/integrar`, sube `schema_version` y, para cada artefacto cuyo contenido cambie, sube su `artifact_version`.

## Nota

Los archivos aqui presentes son artefactos de integracion y distribucion. No son customizaciones activas del workspace APTS.
