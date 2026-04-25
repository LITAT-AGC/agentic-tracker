# Integracion con APTS

Esta carpeta agrupa todo el material destinado a proyectos cliente que quieran integrarse con APTS.

Se mantiene fuera de `.github/` para evitar que VS Code/Copilot lo trate como customizacion activa del propio repositorio APTS.

## Estructura

- `plantillas-agentes/`: plantillas de agentes para orquestacion y ejecucion contra APTS, incluyendo `orquestador-agent.md` y `ejecutor-dev-test-commit.agent.md`.
- `paquete-apts/`: paquete exportable con contrato JSON, clientes HTTP para CommonJS y ESM, guia operativa y referencia de API.

## Uso recomendado

1. Toma desde `paquete-apts/` el contrato JSON, el cliente HTTP adecuado para CommonJS o ESM, o la guia que necesite tu proyecto integrador.
2. Copia desde `plantillas-agentes/` las plantillas de agentes si quieres un flujo orquestador/ejecutor apoyado en backlog de APTS.
3. Instala esos archivos en el proyecto cliente dentro de las ubicaciones que su runtime de agentes soporte.

Si modificas el cliente HTTP exportable, replica el cambio tanto en `paquete-apts/apts-client.js` como en `paquete-apts/apts-client.mjs` para mantener alineadas las variantes CommonJS y ESM.

Si modificas el manifiesto publico de integracion expuesto por APTS en `/api/public/integrar`, tambien debes subir `schema_version` y registrar una nota nueva en `bootstrap.manifest_updates.notes` para que los proyectos cliente puedan entender el cambio y reaccionar a tiempo.

## Nota

Los archivos aqui presentes son artefactos de integracion y distribucion. No son customizaciones activas del workspace APTS.