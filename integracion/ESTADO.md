# Estado de la integracion

Describe **como esta hoy** la superficie de integracion y **que sigue abierto**. No cuenta como se
llego hasta aqui: eso esta en el historial de git.

## Superficie

| | |
|---|---|
| Superficie de integracion | El endpoint MCP remoto, `POST /mcp` (Streamable HTTP, sin sesion) |
| Operaciones | 21, derivadas de `apts_skills.json` |
| Registro | Una URL y cuatro cabeceras; el manifiesto publica el bloque por runtime |
| Manifiesto | `GET /api/public/integrar`, `schema_version` 1.0.0, ~8.600 unidades |
| Artefactos publicados | 9, todos en `artifact_version` 1.0.0 |
| Descargas necesarias para operar | Ninguna |

**Identidad.** Viaja en las cabeceras del registro. El servidor no mira el sistema de archivos, el
entorno ni el Git del cliente. Un valor enviado en los argumentos gana a la cabecera —asi conmuta de
rol un agente— y un `project_url` que contradiga la cabecera se rechaza.

**Conduccion del metodo.** El manifiesto publica `method_conduction`, hermano de `mcp_endpoint`, con
cinco reglas: `bootstrap_rule`, `identity_switching_rule`, `drive_loop`, `generative_step_rule` y
`dev_story_completion_rule`. Es la fuente autoritativa; las plantillas de agente apuntan a el.

**Auto-chequeo.** El backend valida su superficie contra `apts_skills.json` al arrancar
(`backend/scripts/lib/contract_check.mjs`) y aborta si se han separado.

## Verificado

Contra `APTS_test` (puerto 47301), con el estado de partida `initiatives:2`, `epics:2`,
`backlog_items:361`, `tasks:263` restaurado al terminar.

- Un cliente que **no descarga nada** conduce el ciclo BMAD completo a `phase=done`: 7 workflows
  generativos, 2 unidades `dev-story` de 10 pasos, 5 cambios de rol, 3 elicitaciones, 52 submits.
- `initialize` y `tools/list` responden con 21 operaciones.
- Las 9 rutas de artefacto responden 200.
- `scripts/test_agent_api.js` y `scripts/test_agent_api_batch.js`, en verde.
- El generador de adaptadores es idempotente: una segunda corrida no cambia nada.

## Abierto

1. **`cosineSimilarity` y `parseEmbeddingVector` siguen duplicadas** entre `backend/index.js` y
   `backend/scripts/lib/`. Difieren de forma observable: con vectores incompatibles una devuelve `0`
   y la otra `NaN`; una tolera JSON invalido y la otra lanza. Es benigno hoy porque la busqueda
   filtra por `Number.isFinite` y por un umbral de 0,78, asi que un par incompatible se descarta por
   las dos vias. Unificarlas exige medir la busqueda antes y despues.

2. **Una tercera copia de la llamada de embedding**, en `backend/scripts/reembed_bug_embeddings.js`
   (`:162` y `:204`), con su propia resolucion de modelo, su propio `fetch` y **sin plazo de
   espera**. Es un script de mantenimiento fuera de linea; no lo alcanzan ni las 21 operaciones ni
   el panel.

3. **Dos lecturas obligatorias antes de desplegar a PROD**, ambas consultas, no ejecuciones:
   - Si existe la clave de configuracion `embedding_strategy:bug_dedup:model`. En `APTS_test` no
     existe, y el modelo resuelve por `openrouter_embedding_model` a `openai/text-embedding-3-small`.
     Si en PROD **si** existe, el modelo de los embeddings de bug cambiaria y los vectores ya
     guardados dejarian de ser comparables con los nuevos: la deteccion de duplicados degradaria en
     silencio.
   - Si PROD tiene sembrada la biblioteca del metodo (entidades BMAD, `workflow_definitions`,
     `workflow_steps`). Sin ella, `method_conduction` publica un bucle que alli no se puede seguir:
     `set_agent_role` rechaza cualquier `entity_key` que no este en la biblioteca de la iniciativa.

4. **Nada impide que la plantilla del orquestador y el cuerpo del agente en `apts-surface.json`
   vuelvan a divergir.** Hoy son identicos y se comprobo a mano, pero son dos archivos que se editan
   por separado. Ya divergieron una vez sin que nadie lo notara. Un chequeo que compare los dos
   cuerpos y falle el arranque —como ya hace el auto-chequeo de contrato— cerraria el agujero.

5. **`paquete-apts/references/api-contract.md`** (456 lineas) describe la superficie retirada: el
   CLI, el cliente HTTP y el servidor local. No se sirve por HTTP, pero `SKILL.md` ya no lo enlaza.
   O se reescribe o se retira.
