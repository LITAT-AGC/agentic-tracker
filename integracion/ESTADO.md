# Estado de la integracion

Describe **como esta hoy** la superficie de integracion y **que sigue abierto**. No cuenta como se
llego hasta aqui: eso esta en el historial de git.

## Superficie

| | |
|---|---|
| Superficie de integracion | El endpoint MCP remoto, `POST /mcp` (Streamable HTTP, sin sesion) |
| Operaciones | 21, derivadas de `apts_skills.json` |
| Registro | Una URL y cuatro cabeceras; el manifiesto publica el bloque por runtime |
| Manifiesto | `GET /api/public/integrar`, `schema_version` 1.0.1, 8.678 unidades |
| Artefactos publicados | 9; `skill_markdown`, `agent_guidelines` y `surface_spec` en `artifact_version` 1.0.1, el resto en 1.0.0 |
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
- los cuatro artefactos `agent_template`, cuerpo **y** cabecera, contra `apts-surface.json`
  (`checkPublishedAgentTemplates` en `backend/index.js`). Los siete campos de la cabecera salen del
  spec, asi que no queda ninguno fuera del contrato; se comparan campo a campo ya normalizados.

Las cuatro plantillas publicadas **las escribe el generador** desde ese mismo spec, igual que los
adaptadores, asi que la cabecera y el cuerpo tienen una sola fuente y el cerrojo solo tiene que
comprobar que nadie las tocó a mano. Sus nombres de archivo son parte de las rutas publicadas y no
derivan del `id`, asi que el mapa vive explicito en el generador.

El algebra del embedding —`cosineSimilarity`, `parseEmbeddingVector`, `vectorNorm`,
`buildBugEmbeddingText`— existe una sola vez, en `backend/scripts/lib/semantic_embeddings.js`, y la
llamada al proveedor tambien. Ni `backend/index.js` ni `reembed_bug_embeddings.js` tienen copia
propia.

**Hay dos proveedores de embeddings y ninguna clave que los elija.** El proveedor lo dice el
identificador del modelo: `@cf/...` sale por Cloudflare Workers AI (punto compatible con OpenAI,
`accounts/{id}/ai/v1/embeddings`, con `CLOUDFLARE_API_TOKEN` y `CLOUDFLARE_ACCOUNT_ID`; la pasarela
`CLOUDFLARE_AI_GATEWAY_ID` es opcional) y cualquier otro por OpenRouter. Una segunda clave de
configuracion solo podria contradecir a la primera, y el modelo ya viaja en `bug_embedding_model` y
en `openrouter_usage_logs`, asi que el proveedor queda registrado de paso —esa tabla conserva el
nombre y ahora guarda los dos; lo que Cloudflare no da es coste en dolares, porque factura en
neuronas, asi que esas filas van con `cost = 0` y solo cuentan tokens—. Lo que ya estaba sigue igual:
cada proveedor tiene su plazo de espera (`OPENROUTER_EMBEDDING_TIMEOUT_MS`,
`CLOUDFLARE_EMBEDDING_TIMEOUT_MS`), los dos mensajes de fallo nombran al proveedor para que
`isSemanticProviderError()` los reconozca como 503, y el modelo efectivo entra en la comparacion del
hash, con lo que cambiar de proveedor invalida los vectores guardados en vez de darlos por buenos.
El modelo por defecto es `EMBEDDING_DEFAULT_MODEL` —`OPENROUTER_DEFAULT_EMBEDDING_MODEL` se sigue
leyendo detras—, y `backend/index.js` lo importa en vez de releer la variable, para que el panel no
pueda anunciar uno distinto del que se pide.

**Ninguna escritura del agente paga un embedding que no necesite.** Son dos vectores distintos y ya
no se comportan igual de mal:

- El de **dedupe** (`bug_dedup`, en `backlog_items.bug_embedding`) se regeneraba en cada escritura
  del item, tocara o no el texto que se embebe. Ahora `backlog_items.bug_embedding_hash` guarda el
  sha256 de ese texto y la escritura corta cuando coincide —y tambien mira el modelo efectivo, para
  que cambiar `embedding_strategy:bug_dedup:model` no deje pasar por bueno un vector que la busqueda
  ya no puede comparar—. El hash no viaja en las respuestas: `mapBacklogItemRecord` lo quita junto
  con el vector, porque es una clave de cache y son 64 caracteres de entropia por item.
- El de **cobertura funcional** (`semantic_documents`) colgaba de las seis operaciones de escritura
  —crear backlog, actualizar backlog, registrar tarea por sus dos caminos, cambiar estado de tarea y
  reportar bloqueo— y nadie del lado del agente lo lee: el unico lector es el buscador del panel.
  Ahora esas seis solo dejan el documento al dia (`stageBacklogCoverageDocument`), que es una
  escritura local; el vector lo pide el camino explicito del panel,
  `POST /api/dashboard/projects/:url/semantic/backlog/index`, que ya estimaba el coste antes de
  gastarlo. Entre medias el documento cuenta como `stale_documents`, que es justo lo que el panel
  muestra.

`syncBacklogCoverageDocument` sigue existiendo —documento y vector— para ese camino explicito y para
`reindex_semantic_documents.js`. La busqueda de bugs duplicados no cambia: sigue embebiendo su
consulta, que es su unico trabajo y no un efecto lateral.

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

Contra `APTS_test` (puerto 47301; la ultima ronda —la del coste de los embeddings— en 47399, porque
47301 ya estaba ocupado), con el estado de partida `initiatives:2`, `epics:2`, `backlog_items:361`,
`tasks:263` restaurado al terminar.

- Un cliente que **no descarga nada** conduce el ciclo BMAD completo a `phase=done`: 7 workflows
  generativos, 2 unidades `dev-story` de 10 pasos, 5 cambios de rol, 3 elicitaciones, 52 submits.
- `initialize` y `tools/list` responden con 21 operaciones.
- Las 9 rutas de artefacto responden 200.
- `scripts/test_agent_api.js` y `scripts/test_agent_api_batch.js`, en verde.
- El generador es idempotente, tambien ahora que escribe las cuatro plantillas publicadas: una
  segunda corrida no cambia nada, y esos cuatro archivos conservan su CRLF.
- El cerrojo de plantillas, en sus dos mitades: arranque limpio con `agent_templates: 4`; alterando
  el cuerpo, `exit 3` nombrando el artefacto y el motivo; y en la cabecera, las tres clases de
  divergencia —campo que falta, valor que difiere y campo que el spec no declara— dan `exit 3`
  nombrando artefacto, agente, campo y el valor que el spec exige. Se reportan todas juntas, no solo
  la primera.
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
- **Lo que cada escritura del agente le cuesta a OpenRouter**, contado sobre las filas que aparecen
  en `openrouter_usage_logs` durante la operacion:

  | operacion | antes | ahora |
  |---|---|---|
  | `create_backlog_item` (bug) | 2 | 1 (`bug_embedding`) |
  | `update_backlog_item` sin tocar el texto embebido | 2 | 0 |
  | `update_backlog_item` cambiando el titulo | 2 | 1 (`bug_embedding`) |
  | `register_task` con `backlog_item_id` | 1 | 0 |
  | `update_task_status` | 1 | 0 |
  | `search_similar_bug_reports` | 1 | 1 (`semantic_search_embedding`) |

  En el update que no toca el texto, el documento de cobertura **si** cambia de `content_hash` —el
  estado operativo va dentro— y aun asi no se pide vector; `bug_embedding_hash` queda intacto.
  Cambiando el titulo, el hash cambia y se vuelve a embeber una vez.
- La busqueda sigue encontrando el bug que acaba de escribirse: HTTP 200, un candidato escaneado y
  una coincidencia a 0,7172 sobre el item creado.
- El hash no se escapa por la respuesta: el JSON de `read_backlog_item` no contiene
  `bug_embedding_hash` ni `bug_embedding`.
- El camino del panel si embebe, y cierra la cuenta: con el documento en `stale_documents: 1` e
  `indexed_documents: 0`, indexar el proyecto gasta exactamente una llamada
  (`semantic_document:backlog_functional_coverage`) y lo deja en `1` y `0`.
- `limit` se rechaza por HTTP (400) y por MCP (`isError` con el mismo mensaje); con `top_k` la
  busqueda responde igual que antes.
- Cada destino exige su propia cadena de conexion y ninguna hereda de la otra; sin
  `PG_TEST_CONNECTION_STRING`, `test` falla nombrando la variable en vez de resolver a la principal.
- **El despacho por proveedor, hasta donde llega el token de hoy.** `openai/text-embedding-3-small`
  resuelve a OpenRouter y devuelve su vector de 1536 con norma 1,0002 —la ruta que ya existia no
  cambio—; `@cf/baai/bge-m3` resuelve a Cloudflare, sale por su punto compatible y su fallo llega
  leido de `errors[]`: `Cloudflare embedding request failed: Authentication error`. Los espacios
  delante del identificador no confunden al despacho.

## Produccion

Donde vive, al dia el 2026-08-07:

| | |
|---|---|
| Aplicacion | `134.122.62.55:/opt/APTS`, pm2 `apts-backend` (fork, cwd `backend/`), puerto 46315 |
| Frontend | nginx en `apts.informaticos.ar`, servido desde `frontend/dist` |
| Base | `10.110.0.10:46452/APTS`, PostgreSQL 17.9, usuario `apt_user` |
| Despliegue | Una orden: la directiva `.claude/skills/desplegar-produccion` y `scripts/deploy_prod.sh`. Sigue sin gestionarlo el deploy-hub de `/opt/deploy-system` |

**El despliegue ya no se recuerda de memoria.** `scripts/deploy_prod.sh` no vive en el servidor: se
canaliza por ssh desde el checkout, asi que el que corre es el del commit que dispara el despliegue.
Trae el codigo, instala solo donde cambio el `package.json`, copia la base **antes** de migrar y solo
si hay migraciones pendientes, compila el frontend a `dist.new` y lo intercambia —el anterior queda
en `dist.prev`—, reinicia pm2 y comprueba. Si algo falla despues del pull, vuelve al sha de partida y
restaura el `dist`. Lo unico que no puede revertir es el esquema.

**`/mcp` ya lo contesta el backend.** nginx no tenia `location` para esa ruta, asi que caia en el
`try_files ... /index.html` y la servia como estatico: el manifiesto publicaba
`https://apts.informaticos.ar/mcp` como punto de integracion y un POST recibia **405 de nginx**, con
lo que ningun cliente MCP externo podia usar la superficie publicada. Corregido el 2026-08-07 con un
`location = /mcp` que hace `proxy_pass` al 46315, con `client_max_body_size 4m` —el endpoint declara
4mb y el limite por defecto de nginx es 1m, que habria cortado los mensajes grandes con un 413— y
`proxy_read_timeout 180s`, porque un paso generativo pasa de los 60s por defecto. El `/api/` de al
lado conserva esos dos valores por defecto. Ojo con las copias del fichero: el include es
`sites-enabled/*`, asi que un `.bak` ahi dentro se carga como un server duplicado; las copias van a
`/root/nginx-backups/`.

**El servidor de base de datos es compartido; la base no.** Conviven ocho bases —entre ellas
`prd_geronimo` y `lms_prd`, de otros sistemas productivos—, pero las tablas de `APTS` son todas de
APTS. `apt_user` no es superusuario ni tiene `createdb`/`createrole`, y aunque las 18 tablas eran
suyas, la base y el esquema `public` pertenecen a `postgres`: cualquier operacion queda encerrada
dentro de `APTS`.

**Se empezo de cero el 2026-08-02.** Los once proyectos anteriores eran pruebas. Copia previa con
`pg_dump -Fc` en `/root/apts-backup-20260802-142327.dump` (613 KB, 18 tablas), hecha con un
contenedor `postgres:17` de usar y tirar porque el servidor es Ubuntu focal y PGDG ya no lo publica.
Despues: las 18 tablas borradas, las 17 migraciones aplicadas en un solo lote y el metodo re-sembrado.

| | PROD | `APTS_test` |
|---|---|---|
| `entities` `bmad:v6.8.0` | 6 | 6 |
| `workflow_definitions` `bmad:v6.8.0` | 31 | 31 |
| `workflow_steps` | 137 | 147 |
| `projects` / `backlog_items` / `tasks` | 0 | 30 / 361 / 263 |

La clave `embedding_strategy:bug_dedup:model` no existe —`config` esta vacia—, asi que el modelo de
embedding resuelve al de por defecto por los dos caminos.

**La ruta de embeddings esta comprobada contra PROD**, con una prueba de humo que se borro al
terminar: crear un bug gasta una llamada (`bug_embedding`, `openai/text-embedding-3-small`, norma
1,000124) y deja el documento de cobertura escrito sin vector; el update que no toca el texto gasta
cero; la busqueda de duplicados gasta una y encuentra el bug. `initialize` y `tools/list` responden
21 operaciones, el manifiesto 200, y los dos auto-chequeos pasan al arrancar.

**Comprobado despues del despliegue del 2026-08-07**, con el sitio en marcha: `/api/health` en
`ok` por el 46315 y por nginx; los dos auto-chequeos pasando (`operations: 21`,
`agent_templates: 4`); el `index.html` publicado pidiendo un bundle del dist recien compilado —que
es lo unico que distingue un frontend nuevo de uno viejo, porque con `try_files` cualquier ruta
responde 200—; y, ya por la URL publica y con credenciales, `initialize` contestando y `tools/list`
devolviendo **21 operaciones**.

## Abierto

**El camino de Cloudflare no se ha visto devolver un vector.** El `CLOUDFLARE_API_TOKEN` del `.env`
es valido y esta activo (`/user/tokens/verify` responde 200) pero no alcanza ninguna cuenta
—`/accounts` devuelve la lista vacia—, asi que cada embedding responde `401 Authentication error`.
Falta un token con permiso **Workers AI: Read** sobre `8816b3e0…`; con el, queda por confirmar de
primera mano la forma de la respuesta del punto compatible con OpenAI —vector en
`data[0].embedding` y `usage` con tokens—, que es lo unico que se dio por bueno leyendo la
documentacion. Si ese punto contestara con el sobre nativo de Workers AI, el lector ya acepta
`result.data[0]` y no haria falta tocar nada.

En el repositorio no queda nada mas. Produccion corre lo mismo que `origin/main`, con las 17
migraciones aplicadas y el frontend recompilado el 2026-08-07 —llevaba desde el 21 de junio—.

Una cosa queda fuera del repositorio: la contraseña de `apt_user` se expuso en claro durante el
despliegue del 2026-08-02 y conviene rotarla (`ALTER ROLE`, actualizar el `.env`, reiniciar pm2).

**El `.env` de PROD no necesita ninguna clave nueva.** Tiene diez y ninguna de las que llegaron
despues es obligatoria: `EMBEDDING_DEFAULT_MODEL` no hace falta porque
`OPENROUTER_DEFAULT_EMBEDDING_MODEL` se sigue leyendo detras y ya vale
`openai/text-embedding-3-small`; `METHOD_CLAIM_TTL_MS` (1 h) y `METHOD_MAX_STEP_REVISITS` (3) traen
valor por defecto; `PUBLIC_APP_URL` cae en `CORS_ORIGIN`, que apunta al sitio bueno; y las tres
`CLOUDFLARE_*` solo hacen falta el dia que el modelo por defecto pase a ser un `@cf/...`.

