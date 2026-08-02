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

**Sin residuos ejecutables de la superficie retirada.** Ningun archivo del backend importa ya
`apts-client.js`. `mcp_stdio_runtime.mjs` conserva el nombre por el protocolo que habla, no por un
transporte: es el nucleo MCP, `dispatch()` devuelve la respuesta y no escribe en ningun sitio, y
quien llama le pasa el ejecutor. `contract_check.mjs` ejecutado directamente vuelve a funcionar y
lista las 21 operaciones.

**Un campo que no existe se rechaza, no se ignora.** `limit` era el nombre que cualquiera le pone al
tope de la busqueda semantica de bugs; el campo es `top_k`. Como el esquema no es estricto, `limit`
se aceptaba y se descartaba en silencio. Ahora da 400 nombrando el campo bueno, por los dos caminos.

## Destinos

Dos, no tres, y ninguno lleva el nombre de un servidor:

| destino | variable del `.env` | quien lo usa |
|---|---|---|
| principal | `PG_CONNECTION_STRING` (o `DATABASE_URL`) | el servidor y todo lo que no diga `test` |
| de prueba | `PG_TEST_CONNECTION_STRING` | `migrate:test`, `seed:method:test`, `start:test` |

`development` y `production` son **alias del mismo objeto**: existen porque el servidor arranca con
`knexConfig[process.env.NODE_ENV]` y varios scripts aceptan `--target-env`, no porque sean destinos
distintos. Donde cae la conexion principal lo decide el `.env` de la maquina donde se ejecuta, no el
nombre del entorno.

Ninguna de las dos cadenas hereda de la otra. Si falta la de prueba, `test` falla nombrando la
variable en vez de aterrizar en la base principal; si falta la principal, falla igual. Cada destino
se resuelve al pedirlo, asi que a una maquina sin base de prueba no le estorba no tenerla.

El seed del metodo es uno solo, `seeds/bmad_seed.js`. `seed:method` va al destino principal y
`seed:method:test` al de prueba; el argumento existe porque en Windows `NODE_ENV=x npm run ...` no se
propaga.

**Sembrar el metodo no mueve los UUID.** El seed hace upsert contra la clave natural —`key` en
`entities` y `workflow_definitions`, `(workflow_id, key)` en `workflow_steps`, las tres ya `UNIQUE`
en el esquema, sin migracion— asi que cada fila se actualiza en su sitio y `project_state` conserva
donde estaba cada agente. Lo unico que borra es lo que el corpus ya no trae, y la guardia se calcula
justo sobre esa diferencia: re-sembrar el mismo corpus ya no es motivo de aborto. Como `key` es
`UNIQUE` global y no lleva el `source_ref` dentro, el seed aborta antes de tocar nada si una clave del
corpus pertenece a otra biblioteca, en vez de pisarla en silencio.

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
- **El bucle publicado no necesita `primitives_palette`.** Con la tabla vaciada —la condicion exacta
  de produccion— un cliente que no descarga nada vuelve a llegar a `phase=done` con los mismos seis
  numeros que con la tabla poblada: 52 submits, 7 workflows generativos, 2 unidades `dev-story` de 10
  pasos, 5 cambios de rol, 3 elicitaciones. La tabla siguio a 0 durante toda la corrida.
- **Re-sembrar el metodo conserva los UUID.** Los 174 de la biblioteca (6 entities, 31 definiciones,
  137 pasos) sobreviven intactos a `seed:method:test`, igual que los de la fixture y
  `primitives_palette`; un agente en `running` que apuntaba a los tres campos los conserva.
- La guardia del seed, ahora calculada sobre lo que desaparece: re-sembrar el mismo corpus no aborta
  y no borra nada; retirando del corpus un workflow que un agente esta conduciendo, `exit 1`
  nombrando el workflow y el paso que pierde, sin tocar nada; con `--force`, avisa por stderr, sigue,
  y deja los punteros exactamente como habia advertido —`entity_id` incluido, que sobrevive porque
  esa entity no desaparecia.
- La busqueda de bugs duplicados sobrevive a una fila con el vector corrupto: HTTP 200, esa fila
  fuera y el resto comparandose.
- El plazo de espera del embedding existe en el unico camino que queda: con
  `OPENROUTER_EMBEDDING_TIMEOUT_MS=1`, `timed out after 1 ms` y el elemento marcado como fallido.
- `limit` se rechaza por HTTP (400) y por MCP (`isError` con el mismo mensaje); con `top_k` la
  busqueda responde igual que antes.
- Cada destino exige su propia cadena de conexion y ninguna hereda de la otra; sin
  `PG_TEST_CONNECTION_STRING`, `test` falla nombrando la variable en vez de resolver a la principal.

## Produccion

Leido el 2026-08-02 contra `146.190.26.165:46452/APTS`, solo lectura. Desde esta maquina, ese destino
no se alcanza: la conexion principal la fija el `.env` de cada maquina y aqui apunta a la base de
trabajo (ver **Destinos**).

| | PROD | `APTS_test` |
|---|---|---|
| `entities` `bmad:v6.8.0` | 6 | 6 |
| `workflow_definitions` `bmad:v6.8.0` | 31 | 31 |
| `workflow_steps` | 137 | 147 |
| `primitives_palette` | 0 (no hace falta, ver **Verificado**) | 6 |
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

Nada. Los dos puntos que quedaban se cerraron, y lo que aparecio al cerrarlos esta anotado arriba:

1. **`primitives_palette` vacia en produccion** ya no es una pregunta. La tabla no la lee ningun
   camino del runtime: `evaluatePrimitive` resuelve del registro en codigo (`PRIMITIVES`), la
   completitud por routing toma la key de `WORKFLOW_COMPLETION` —tambien en codigo—, y el unico que
   escribe la tabla es `reconcilePrimitiveRegistry`, que solo llama la fixture toy. Los 137 pasos de
   la biblioteca publicada son todos `generative` con `primitive_key` en `null`; los unicos 5 que
   nombran una primitiva son de la fixture. Comprobado ademas con la tabla vaciada (ver
   **Verificado**). Sigue siendo catalogo para UI, no autoridad.

2. **Volver a sembrar el metodo ya no exige criterio** en el caso normal: el seed hace upsert y los
   UUID sobreviven (ver **Destinos** y **Verificado**). La guardia sigue, acotada a lo que de verdad
   desaparece del corpus, que es el unico caso en que un puntero se pierde.

Queda una asimetria conocida, sin consecuencia hoy: el cerrojo de plantillas compara solo el cuerpo
del artefacto contra `apts-surface.json`; la cabecera YAML de cada plantilla sigue a mano.

