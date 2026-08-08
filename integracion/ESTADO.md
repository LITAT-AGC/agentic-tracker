# Estado de la integracion

Describe **como esta hoy** la superficie de integracion y **que sigue abierto**. No cuenta como se
llego hasta aqui: eso esta en el historial de git.

## Superficie

| | |
|---|---|
| Superficie de integracion | El endpoint MCP remoto, `POST /mcp` (Streamable HTTP, sin sesion) |
| Operaciones | 22, derivadas de `apts_skills.json` |
| Registro | Una URL y cuatro cabeceras; el manifiesto publica el bloque por runtime |
| Manifiesto | `GET /api/public/integrar`, `schema_version` 1.1.0, 8.565 unidades |
| Runtimes soportados | Dos: Claude Code y opencode |
| Artefactos publicados | 7; `skill_markdown`, `agent_guidelines` y `adapter_generator` en `artifact_version` 1.1.0, `surface_spec` en 1.0.2, `skills_json` en 1.0.1, los dos del conductor en 1.0.0 |
| Descargas necesarias para **llamar** a las operaciones | Ninguna |
| Descargas necesarias para **conducir** | El spec y el generador (agentes y comandos); el conductor y su README si se quiere el bucle desatendido |

**Identidad.** Viaja en las cabeceras del registro. El servidor no mira el sistema de archivos, el
entorno ni el Git del cliente. Un valor enviado en los argumentos gana a la cabecera —asi conmuta de
rol un agente— y un `project_url` que contradiga la cabecera se rechaza.

**Conduccion del metodo.** El manifiesto publica `method_conduction`, hermano de `mcp_endpoint`, con
cinco reglas: `bootstrap_rule`, `identity_switching_rule`, `drive_loop`, `generative_step_rule` y
`dev_story_completion_rule`. Es la fuente autoritativa; los agentes generados apuntan a el.

**Dos runtimes, no tres.** VS Code salio el 2026-08-08. Era el unico que no registraba el MCP con
variables de entorno ni tenia comandos, asi que su adaptador era medio adaptador —agentes y una
instruccion, sin registro ni permisos— y su entrega iba por una segunda via: cuatro plantillas
`.agent.md` descargables que el cliente copiaba a mano a `.github/agents`. Esa segunda via se fue con
el: los cuatro artefactos `agent_template` y sus rutas ya no se publican (404), la carpeta
`plantillas-agentes/` ya no existe, y con ella desaparecio el segundo auto-chequeo de arranque, que
existia solo para vigilar que esas cuatro copias no se separaran del spec. Queda **un** auto-chequeo.

**Y por eso los clientes de Claude Code se quedaban sin agentes y sin comandos.** La politica de
instalacion de adaptadores hablaba SOLO de VS Code en los tres sitios donde aparecia —la frase de
estado, los tres `mappings` y el paso recomendado—, aunque el manifiesto publicara bloques de
registro para los tres runtimes y el generador emitiera los tres directorios. Un cliente Claude Code
la leia, concluia con razon que no le aplicaba, y no generaba nada. Se vio en un cliente real el
2026-08-08: tenia `.mcp.json`, `AGENTS.md` y el diario de resiliencia —todo lo que el manifiesto si
exige— y ni un solo agente ni comando, asi que condujo el ciclo BMAD a mano leyendo
`method_conduction`. El orquestador de metodo, ademas, no figuraba en NINGUN mapping de ningun
runtime, siendo el que conduce el ciclo desde una spec.

Ahora la condicion no nombra ningun runtime —"mientras falten los adaptadores del runtime ACTIVO"—,
hay un mapping por runtime cuyo destino es el directorio entero en vez de un agente por linea, y los
cuatro agentes se listan aparte con su papel. Copiar `runtime-adapters/claude/` o
`runtime-adapters/opencode/` a la raiz del cliente trae de una vez el registro MCP, el archivo de
instrucciones, los permisos, los cuatro agentes y los cinco comandos.

**El conductor del bucle ya se publica.** `integracion/conductor/apts-loop.js` existia desde el
2026-08-06 y no aparecia en ninguna parte del manifiesto: ni como artefacto ni nombrado en una
cadena. Un cliente que arrancaba desde la URL no podia saber que existia. Ahora son dos artefactos,
`loop_conductor` y `loop_conductor_readme`, y van juntos a proposito: `--agent-cmd` es obligatorio y
su forma depende del runtime, asi que el script sin su manual no se puede usar. El script es
autocontenido —CommonJS, solo builtins de Node— asi que descargar ese unico archivo basta.

**La fase de partida ya no se puede regalar.** `create_initiative` publica `phase`, y era la unica
puerta del contrato por la que un cliente podia saltarse fases enteras: el paseo inter-fase arranca
en `initiatives.phase`, asi que arrancar adelantado no se salta un paso, se salta el trabajo que el
motor habria exigido por el camino. Lo encontro produccion el 2026-08-07: un cliente que traia una
spec arranco en `solutioning` —"analysis y planning ya cubiertos por el SPEC adjunto"— y la
iniciativa llego a `implementation` sin `brief` y sin `prd`, es decir sin la elicitacion del analyst
y sin el PM. Ahora `startPhaseGaps` exige que los artefactos que cierran las fases salteadas ya
existan en el proyecto, y si no da 400 (`PHASE_NOT_REACHABLE`) nombrando cada uno con su fase y su
workflow. Los lee de la misma espina y del mismo mapa de completitud que usa `apts_next`, asi que no
hay un segundo criterio que pueda contradecir al primero; y la spec no compra ningun salto, porque
su `doc_type` es `spec` justamente para no cerrar ninguna fase. Solo corre en el alta: en el resume
`phase` es inerte, y rechazarlo alli romperia la via de recuperacion del agente que repite su
llamada original. La regla viaja tambien en `bootstrap_rule` y en la descripcion de la operacion,
para que el cliente se entere antes de que le rechacen la llamada.

Esto invirtio una dependencia: `method_bootstrap` consulta la espina, asi que ahora importa a
`method_resolver` y no al reves. `loadRosterKeys` —fuente unica del roster— se mudo con ella.

**Las constraints del proyecto ya se pueden escribir.** `get_project_constraints` existia desde el
principio y no habia escritor en ninguna de las tres superficies —ni operacion, ni ruta HTTP, ni
pantalla del panel—, asi que un proyecto nuevo respondia los seis campos en `null` para siempre y el
agente que si descubria como se verifica el repositorio no tenia donde dejarlo. La operacion 22,
`set_project_constraints`, cierra el hueco por las dos superficies (`PUT
/api/projects/:url/constraints`). Es un parche, no un reemplazo: escribe solo los campos que trae la
llamada, un `null` explicito borra uno —y gana sobre lo que venga de `projects.description`, porque
queda como clave presente en el JSON de `config`, que es la mitad que pisa a la otra—, un nombre de
campo inventado se rechaza en vez de descartarse en silencio, y una llamada sin ningun campo tambien,
porque seria un 200 que no escribe nada. Devuelve lo efectivo, no lo enviado.

De paso, los dos sitios que decian «21 operaciones» dejaron de decir un numero: el manifiesto remite
a lo que devuelve `tools/list`, que es lo que el cliente va a leer igualmente.

**Una sola fuente por cosa.** Un auto-chequeo corre al arrancar, antes de escuchar, y aborta con
`exit 3` si algo se ha separado: el contrato, contra `apts_skills.json`
(`backend/scripts/lib/contract_check.mjs`).

Eran dos. El segundo comparaba las cuatro plantillas publicadas —cuerpo y cabecera— contra
`apts-surface.json`, y existia porque eran una segunda copia del mismo texto que ya se habia
separado del spec sin que nadie lo notara. Al retirarlas con VS Code desaparece la copia, y con la
copia el cerrojo: ahora el spec tiene un solo consumidor, el generador, y lo que este emite se
comprueba regenerando.

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
lista las 22 operaciones.

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
- `initialize` y `tools/list` responden con 22 operaciones.
- **`set_project_constraints`, por las dos superficies.** Escritura parcial: deja `test_command` y
  `typecheck_command` y el resto en `null`; una segunda llamada agrega `lint_command` y `language`
  sin borrar los dos primeros; `language: null` borra ese y solo ese. Las comillas que envuelven un
  comando se pierden, igual que en la lectura. Un campo inventado (`tests_command`) da 400 nombrando
  los seis validos; una llamada sin ningun campo, tambien; un valor no-cadena, 400 nombrando el
  campo; y un proyecto que no existe, 404. Por HTTP, `PUT` responde lo mismo que el `GET` de al lado
  devuelve despues.
- **La guardia de la fase de partida**, por la libreria y por MCP: `phase: 'solutioning'` en el alta
  da 400 nombrando `brief` (analysis, `bmad-product-brief`) y `prd` (planning, `bmad-prd`);
  `implementation` nombra los cinco, con los tres de solutioning en su orden topologico; el alta sin
  `phase` sigue creando en `analysis` con el roster de 6; repetir la llamada original con
  `phase: 'solutioning'` sobre la iniciativa viva resume sin rechazar; y con `brief` y `prd` escritos
  a mano, los huecos de `solutioning` desaparecen y los de `implementation` se reducen a los tres que
  faltan. Por MCP llega como `isError` con `PHASE_NOT_REACHABLE` en `details` y `retriable: false`.
  El rechazo no deja residuo: la guardia corre dentro de la transaccion y antes de `ensureProject`.
- Las 7 rutas de artefacto responden 200, incluidas las dos nuevas del conductor; y las cuatro
  `/agentes/*.agent.md` que se retiraron dan 404.
- **El manifiesto no menciona VS Code por ninguna parte**, ni en las claves ni en la prosa:
  `vscode`, `VS Code`, `copilot`, `.github/agents` y `agent_template` dan cero coincidencias sobre
  el JSON entero. Y encogio: 8.565 unidades contra 8.766, aun habiendo agregado el conductor.
- **El conductor publicado se ejecuta.** Descargado como un unico archivo y corrido con `--dry-run`
  contra el servidor de prueba, anuncia su alcance y su politica de modelo, resuelve la primera
  decision y para con `PARADA (blocked): sin iniciativa activa` y codigo 10, que es exactamente lo
  que su README documenta. No necesita nada instalado: CommonJS y solo builtins de Node.
- `scripts/test_agent_api.js` y `scripts/test_agent_api_batch.js`, en verde.
- El generador es idempotente: una segunda corrida emite los mismos 23 archivos y no cambia el
  arbol.
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

**Comprobado despues del despliegue del 2026-08-08** (`c41ad1b`, sin migraciones), por la URL
publica y con credenciales leidas en el propio servidor: `tools/list` devuelve **22 operaciones**,
entre ellas `set_project_constraints`; la guardia de la fase de partida rechaza `phase:
'solutioning'` nombrando `brief` y `prd`, y no deja proyecto ni iniciativa detras; el manifiesto
publica `surface_spec` en 1.0.2, `skills_json` en 1.0.1 y la regla nueva dentro de `bootstrap_rule`;
y las seis comprobaciones del desplegador —`/api/health` local y publico, manifiesto con
`mcp_endpoint`, `/mcp` por los dos caminos y el bundle del dist nuevo— pasaron. El aviso de `/mcp`
no salio: nginx lo enruta desde el 2026-08-07.

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

**El `.env` de PROD no necesita ninguna clave nueva.** Tiene diez y ninguna de las que llegaron
despues es obligatoria: `EMBEDDING_DEFAULT_MODEL` no hace falta porque
`OPENROUTER_DEFAULT_EMBEDDING_MODEL` se sigue leyendo detras y ya vale
`openai/text-embedding-3-small`; `METHOD_CLAIM_TTL_MS` (1 h) y `METHOD_MAX_STEP_REVISITS` (3) traen
valor por defecto; `PUBLIC_APP_URL` cae en `CORS_ORIGIN`, que apunta al sitio bueno; y las tres
`CLOUDFLARE_*` solo hacen falta el dia que el modelo por defecto pase a ser un `@cf/...`.

