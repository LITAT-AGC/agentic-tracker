# Integracion con APTS

Esta carpeta agrupa todo el material destinado a proyectos cliente que quieran integrarse con APTS.

Se mantiene fuera de `.github/` para evitar que VS Code/Copilot lo trate como customizacion activa del propio repositorio APTS.

## Estructura

- `plantillas-agentes/`: plantillas de agentes para orquestacion y ejecucion contra APTS.
- `paquete-apts/`: paquete exportable con contrato JSON, cliente HTTP, guia operativa y referencia de API.

## Uso recomendado

1. Toma desde `paquete-apts/` el contrato JSON, el cliente HTTP o la guia que necesite tu proyecto integrador.
2. Copia desde `plantillas-agentes/` las plantillas de agentes si quieres un flujo orquestador/ejecutor apoyado en backlog de APTS.
3. Instala esos archivos en el proyecto cliente dentro de las ubicaciones que su runtime de agentes soporte.

## Nota

Los archivos aqui presentes son artefactos de integracion y distribucion. No son customizaciones activas del workspace APTS.