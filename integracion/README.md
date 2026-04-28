# Integracion con APTS

Esta carpeta agrupa todo el material destinado a proyectos cliente que quieran integrarse con APTS.

Se mantiene fuera de `.github/` para evitar que VS Code/Copilot lo trate como customizacion activa del propio repositorio APTS.

## Estructura

- `plantillas-agentes/`: plantillas de agentes para intake de bugs, orquestacion y ejecucion contra APTS, incluyendo `intake-bugfix-apts.agent.md`, `orquestador-backlog-apts.agent.md` y `ejecutor-item-backlog-dev-test-commit.agent.md`.
- `paquete-apts/`: paquete exportable con contrato JSON, clientes HTTP para CommonJS y ESM, CLI oficial para CommonJS y ESM, guia operativa y referencia de API.

## Uso recomendado

1. Toma desde `paquete-apts/` el contrato JSON, el cliente HTTP adecuado para CommonJS o ESM, y si tu runtime prefiere invocacion por terminal, la CLI oficial del mismo modulo.
2. Copia desde `plantillas-agentes/` las plantillas de agentes si quieres un flujo de intake de bugs y/o un flujo orquestador/ejecutor apoyado en backlog de APTS.
3. Instala esos archivos en el proyecto cliente dentro de las ubicaciones que su runtime de agentes soporte.

## Regla de cobertura del cliente exportable

- El cliente HTTP oficial que APTS distribuye (`apts-client.js` y `apts-client.mjs`) debe cubrir todas las funcionalidades de integracion publicadas en `apts_skills.json`.
- La CLI oficial (`apts-cli.js` y `apts-cli.mjs`) es una entrada de ejecucion estable sobre ese cliente; no reemplaza al cliente y debe vivir junto a su variante correspondiente.
- El proyecto cliente no deberia tener que desarrollar scripts extra para completar operaciones base de integracion (por ejemplo listado, alta, actualizacion y soft-delete de backlog).
- Al migrar al cliente o CLI oficial, elimina wrappers o scripts locales viejos de APTS que solo deleguen operaciones base. Conserva unicamente adapters finos de discovery si el runtime los necesita.
- Si aparece una brecha funcional, se corrige primero en el paquete oficial de APTS y luego se consume la version actualizada desde el proyecto cliente.

## Troubleshooting rapido de agentes (VS Code)

Si una plantilla de agente no aparece en VS Code/Copilot, valida este checklist:

1. Nombre de archivo: debe terminar en `.agent.md` (por ejemplo `orquestador-backlog-apts.agent.md`).
2. Ubicacion: instala el archivo dentro del proyecto cliente abierto en VS Code, en `.github/agents/`.
3. Frontmatter YAML: verifica que el bloque `---` inicial sea valido y que incluya al menos `name` y `description`.
4. Tipo de artefacto: `apts_skills.json` define tools/skills HTTP, no crea agentes por si solo.
5. Recarga del editor: tras copiar agentes nuevos, ejecuta `Developer: Reload Window`.

Recomendacion: manten `APTS Bugfix Intake`, `Orquestador Backlog APTS` y `Ejecutor Item Backlog Dev Test Commit` en la misma carpeta `.github/agents/` para asegurar discovery consistente y que el flujo de intake previo a la ejecucion quede disponible cuando el runtime soporte agentes custom.

Si modificas el cliente HTTP exportable, replica el cambio tanto en `paquete-apts/apts-client.js` como en `paquete-apts/apts-client.mjs` para mantener alineadas las variantes CommonJS y ESM.

Si modificas la CLI oficial, replica el cambio tanto en `paquete-apts/apts-cli.js` como en `paquete-apts/apts-cli.mjs` y confirma que siga delegando a la variante de cliente que le corresponde.

Si modificas el manifiesto publico de integracion expuesto por APTS en `/api/public/integrar`, tambien debes subir `schema_version` y registrar una nota nueva en `bootstrap.manifest_updates.notes` para que los proyectos cliente puedan entender el cambio y reaccionar a tiempo. El historial es append-only: no se deben borrar ni reemplazar notas previas al agregar una version nueva.

El manifiesto expone metadatos de sincronizacion por artefacto (`artifact_version`, `updated_in_schema_version`, `sync_action`, `deprecated_filenames`) y una politica global (`bootstrap.artifact_sync_policy`). Los actualizadores locales deben usar esos campos para decidir que sobreescribir y que archivos legacy eliminar durante la actualizacion.

Importante: esa limpieza automatica solo aplica a nombres legacy publicados por APTS. Si el proyecto cliente tenia wrappers propios viejos para operaciones base, deben retirarse manualmente al migrar al cliente o CLI oficial.

## Nota

Los archivos aqui presentes son artefactos de integracion y distribucion. No son customizaciones activas del workspace APTS.