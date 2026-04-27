# Integracion con APTS

Esta carpeta agrupa todo el material destinado a proyectos cliente que quieran integrarse con APTS.

Se mantiene fuera de `.github/` para evitar que VS Code/Copilot lo trate como customizacion activa del propio repositorio APTS.

## Estructura

- `plantillas-agentes/`: plantillas de agentes para orquestacion y ejecucion contra APTS, incluyendo `orquestador.agent.md` y `ejecutor-dev-test-commit.agent.md`.
- `paquete-apts/`: paquete exportable con contrato JSON, clientes HTTP para CommonJS y ESM, guia operativa y referencia de API.

## Uso recomendado

1. Toma desde `paquete-apts/` el contrato JSON, el cliente HTTP adecuado para CommonJS o ESM, o la guia que necesite tu proyecto integrador.
2. Copia desde `plantillas-agentes/` las plantillas de agentes si quieres un flujo orquestador/ejecutor apoyado en backlog de APTS.
3. Instala esos archivos en el proyecto cliente dentro de las ubicaciones que su runtime de agentes soporte.

## Regla de cobertura del cliente exportable

- El cliente HTTP oficial que APTS distribuye (`apts-client.js` y `apts-client.mjs`) debe cubrir todas las funcionalidades de integracion publicadas en `apts_skills.json`.
- El proyecto cliente no deberia tener que desarrollar scripts extra para completar operaciones base de integracion (por ejemplo listado, alta, actualizacion y soft-delete de backlog).
- Si aparece una brecha funcional, se corrige primero en el paquete oficial de APTS y luego se consume la version actualizada desde el proyecto cliente.

## Troubleshooting rapido de agentes (VS Code)

Si una plantilla de agente no aparece en VS Code/Copilot, valida este checklist:

1. Nombre de archivo: debe terminar en `.agent.md` (por ejemplo `orquestador.agent.md`).
2. Ubicacion: instala el archivo dentro del proyecto cliente abierto en VS Code, en `.github/agents/`.
3. Frontmatter YAML: verifica que el bloque `---` inicial sea valido y que incluya al menos `name` y `description`.
4. Tipo de artefacto: `apts_skills.json` define tools/skills HTTP, no crea agentes por si solo.
5. Recarga del editor: tras copiar agentes nuevos, ejecuta `Developer: Reload Window`.

Recomendacion: manten `Orquestador Agent` y `Ejecutor Dev Test Commit` en la misma carpeta `.github/agents/` para asegurar que la referencia del orquestador al subagente funcione.

Si modificas el cliente HTTP exportable, replica el cambio tanto en `paquete-apts/apts-client.js` como en `paquete-apts/apts-client.mjs` para mantener alineadas las variantes CommonJS y ESM.

Si modificas el manifiesto publico de integracion expuesto por APTS en `/api/public/integrar`, tambien debes subir `schema_version` y registrar una nota nueva en `bootstrap.manifest_updates.notes` para que los proyectos cliente puedan entender el cambio y reaccionar a tiempo.

## Nota

Los archivos aqui presentes son artefactos de integracion y distribucion. No son customizaciones activas del workspace APTS.