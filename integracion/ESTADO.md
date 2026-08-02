# Estado de la integracion

Describe **como esta hoy** la superficie de integracion y **que sigue abierto**. No cuenta como se
llego hasta aqui: eso esta en el historial de git.

## Superficie

| | |
|---|---|
| Superficie de integracion | El endpoint MCP remoto, `POST /mcp` (Streamable HTTP, sin sesion) |
| Operaciones | 21, derivadas de `apts_skills.json` |
| Registro | Una URL y cuatro cabeceras; el manifiesto publica el bloque por runtime |
| Manifiesto | `GET /api/public/integrar`, `schema_version` 1.0.0, 8.595 unidades |
| Artefactos publicados | 9, todos en `artifact_version` 1.0.0 |
| Descargas necesarias para operar | Ninguna |

**Identidad.** Viaja en las cabeceras del registro. El servidor no mira el sistema de archivos, el
entorno ni el Git del cliente. Un valor enviado en los argumentos gana a la cabecera —asi conmuta de
rol un agente— y un `project_url` que contradiga la cabecera se rechaza.

**Conduccion del metodo.** El manifiesto publica `method_conduction`, hermano de `mcp_endpoint`, con
cinco reglas: `bootstrap_rule`, `identity_switching_rule`, `drive_loop`, `generative_step_rule` y
`dev_story_completion_rule`. Es la fuente autoritativa; las plantillas de agente apuntan a el.

**Una sola fuente por cosa.** Dos auto-chequeos corren al arrancar, antes de escuchar, y abortan con
`exit 3` si algo se ha separado:

- el contrato, contra `apts_skills.json` (`backend/scripts/lib/contract_check.mjs`);
- los cuerpos de los cuatro artefactos `agent_template`, contra `apts-surface.json`
  (`checkPublishedAgentTemplates` en `backend/index.js`). Compara solo el cuerpo; la cabecera YAML de
  cada plantilla sigue a mano.

El algebra del embedding —`cosineSimilarity`, `parseEmbeddingVector`, `vectorNorm`,
`buildBugEmbeddingText`— existe una sola vez, en `backend/scripts/lib/semantic_embeddings.js`, y la
llamada a OpenRouter tambien. Ni `backend/index.js` ni `reembed_bug_embeddings.js` tienen copia
propia.

## Verificado

Contra `APTS_test` (puerto 47301), con el estado de partida `initiatives:2`, `epics:2`,
`backlog_items:361`, `tasks:263` restaurado al terminar.

- Un cliente que **no descarga nada** conduce el ciclo BMAD completo a `phase=done`: 7 workflows
  generativos, 2 unidades `dev-story` de 10 pasos, 5 cambios de rol, 3 elicitaciones, 52 submits.
- `initialize` y `tools/list` responden con 21 operaciones.
- Las 9 rutas de artefacto responden 200.
- `scripts/test_agent_api.js` y `scripts/test_agent_api_batch.js`, en verde.
- El generador de adaptadores es idempotente: una segunda corrida no cambia nada.
- El cerrojo de plantillas: arranque limpio con `agent_templates: 4`; alterando una plantilla a
  proposito, `exit 3` nombrando el artefacto y el motivo.
- La guardia del seed: sin agentes conduciendo siembra normal; con uno, `exit 1` sin tocar nada; con
  `--force`, avisa por stderr y sigue.
- La busqueda de bugs duplicados sobrevive a una fila con el vector corrupto: HTTP 200, esa fila
  fuera y el resto comparandose.
- El plazo de espera del embedding existe en el unico camino que queda: con
  `OPENROUTER_EMBEDDING_TIMEOUT_MS=1`, `timed out after 1 ms` y el elemento marcado como fallido.

## Produccion

Leido el 2026-08-02 contra `146.190.26.165:46452/APTS`, solo lectura. **Ojo: el perfil `production`
del knexfile NO apunta ahi** (ver deuda 1).

| | PROD | `APTS_test` |
|---|---|---|
| `entities` `bmad:v6.8.0` | 6 | 6 |
| `workflow_definitions` `bmad:v6.8.0` | 31 | 31 |
| `workflow_steps` | 137 | 147 |
| `primitives_palette` | 0 | 6 |
| `project_state` | 0 | 8 |
| `initiatives` | 0 | 2 |
| `backlog_items` | 461 | 361 |
| `tasks` | 317 | 263 |

**La biblioteca del metodo esta sembrada**, y con los numeros exactos que reporta el propio seed
(`APTS_test` tiene mas porque le suma la fixture toy: 5 entities, 4 definiciones, 10 pasos). Ultima
migracion aplicada `20260621000016_artifact_doc_type_spec.js`, la misma que la ultima del
repositorio: no hay migraciones pendientes. La clave `embedding_strategy:bug_dedup:model` no existe,
asi que el modelo de embedding resuelve al de por defecto por los dos caminos.

## Abierto

1. **El perfil `production` del knexfile no apunta a produccion.** Resuelve por
   `PG_CONNECTION_STRING`/`DATABASE_URL`, que en esta maquina es `192.168.0.240/APTS` —la misma que
   `development`—, mientras la base productiva vive en `146.190.26.165:46452`. Cualquier comando con
   `--env production` desde aqui toca la base equivocada, y como esa esta vacia de metodo, **parece
   que funciona**. Quedan expuestos `migrate:prod` y `seed:method:prod`; el `deploy:prod` que los
   encadenaba se retiro por innecesario, lo que reduce la superficie pero no cierra el agujero. Es lo
   mas peligroso de esta lista. Se cierra con una variable dedicada para el perfil de produccion, o
   con una guardia que se niegue a operar si la conexion cayo por el fallback.

2. **`primitives_palette` esta vacia en produccion**, y solo la siembra `seeds/f1_toy_fixture.js`,
   que es fixture de prueba y tiene doble guarda para no tocar produccion. `bmad_seed` dice
   explicitamente que no la toca. Los pasos generativos avanzan por `step_order` con `next_rules` en
   `null` y las primitivas se resuelven del registro en codigo, asi que **probablemente** no haga
   falta para el bucle publicado; no esta comprobado.

3. **`contract_check.mjs` todavia nombra al cliente borrado.** `CLIENT_UTILITY_EXPORTS`,
   `checkClientContract()` y el bloque de ejecucion directa importan `./apts-client.js`, que ya no
   existe: `node scripts/lib/contract_check.mjs` falla con `Cannot find module`. El arranque no lo
   usa —solo llama a `contractOperations()`—, asi que es codigo muerto que menciona una superficie
   retirada, no un fallo en servicio.

4. **Volver a sembrar el metodo sigue exigiendo criterio.** La guardia de `bmad_seed` avisa y se
   planta, pero el seed sigue siendo borrar-por-`source_ref`-y-reinsertar: los UUID cambian y
   `project_state` pierde donde estaba cada agente (`entity_id`, `current_workflow_id`,
   `current_step_id` son `ON DELETE SET NULL`, y `step_status` no se toca). Hoy es inocuo porque
   produccion tiene `project_state` a 0. La solucion de fondo es un upsert contra la clave natural
   para que los UUID sobrevivan.

5. **`limit` se acepta y se ignora en la busqueda semantica de bugs.** El campo del esquema es
   `top_k`; `semanticBugSearchBodySchema` no es estricto, asi que un cliente que mande `limit` no
   recibe error y se queda con el tope por defecto de 5 creyendo que pidio otra cosa.
