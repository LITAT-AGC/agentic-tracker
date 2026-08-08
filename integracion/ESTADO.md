# Estado de la integracion

Describe **como esta hoy** la superficie de integracion y **que sigue abierto**. No cuenta como se
llego hasta aqui: eso esta en el historial de git.

## Superficie

| | |
|---|---|
| Superficie de integracion | El endpoint MCP remoto, `POST /mcp` (Streamable HTTP, sin sesion) |
| Operaciones | 22, derivadas de `apts_skills.json` |
| Registro | Una URL y cuatro cabeceras; el manifiesto publica el bloque por runtime |
| Manifiesto | `GET /api/public/integrar`, `schema_version` 1.1.1 |
| Runtimes soportados | Dos: Claude Code y opencode |
| Artefactos publicados | 8; los dos del conductor en `artifact_version` 1.6.0, `skill_markdown`, `agent_guidelines` y `adapter_generator` en 1.1.0, `loop_prompt_code_review` en 1.1.1, `surface_spec` en 1.0.2, `skills_json` en 1.0.2 |
| Descargas necesarias para **llamar** a las operaciones | Ninguna |
| Descargas necesarias para **conducir** | El spec y el generador (agentes y comandos); el conductor y su README si se quiere el bucle desatendido, y su plantilla de revision si se quiere ademas la compuerta dentro de la sesion del agente |

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

**La revision adversaria ya es una compuerta, y de la unidad.** `bmad-code-review` esta sembrado en
la biblioteca (`bmad:v6.8.0`, fase `implementation`, dueño `bmad-agent-dev`) y describe exactamente
lo que hacia falta —tres capas paralelas: Blind Hunter, Edge Case Hunter, Acceptance Auditor— pero
no corria nunca: su `routing` trae `required: false` y `resolvePhaseSpine` arma la espina solo con
los `required`.

Colgarlo de la espina tampoco servia, y ese fue el hallazgo que decidio el diseño. La espina se
recorre en orden y activa el primer workflow NO-completo, y `bmad-dev-story` solo esta completo
cuando TODAS las historias estan done: un `bmad-code-review` detras de el correria una vez, al
final, sobre el lote entero. Y su completitud seria `artifact-exists` a nivel de iniciativa, asi que
un solo documento cerraria el workflow para las 25 historias. La revision no es una compuerta de la
FASE —no dice nada sobre si implementation termino—: es una compuerta de la UNIDAD.

Asi que entra como output del paso terminal de `bmad-dev-story` y no como nodo de la espina:
`extra: [{ kind: 'artifact', doc_type: 'code_review', scope: 'story', required_for_close: true }]`
en `WORKFLOW_OUTPUTS`, que es la fuente unica. Corre por historia por construccion, se captura en el
mismo submit que cierra la unidad, y deja fila propia en `semantic_documents` con la clave de esa
unidad. `required_for_close` es lo que la hace compuerta y no adorno: el submit terminal sin
`output.content` se rechaza con `ok:false` y la story no cierra. Se comprueba **antes** de capturar
y **sin excepcion para HALT**, porque la captura corre antes que el control y un HALT declarado
sobre el paso terminal cerraria la story igual: esa puerta volveria opcional la compuerta con solo
decir que uno se detiene.

La espina no se toco y el corpus no se falseo: `bmad-code-review` sigue sembrado como lo que BMAD
publica, un workflow a demanda. Sus tres pasos importados son la prosa del SKILL.md ("WORKFLOW
ARCHITECTURE", "FIRST STEP"), no un procedimiento conducible; el procedimiento real vive en los step
files del upstream, que el importador no trajo. `dev_story_completion_rule` del manifiesto ya dice
que el paso terminal declara DOS outputs y que los dos viajan en el mismo submit. `schema_version`
no cambia: no hay clave nueva.

**La ejecucion ya deja rastro, y el commit ya no se tira.** Lo noto el operador el 2026-08-08 mirando
lo poco que APTS guardaba de una ejecucion de 34 minutos: 7 tareas y 6 registros, todos de sesiones
interactivas anteriores; del bucle, ninguno. El motivo era estructural —APTS tiene dos superficies y
el bucle solo usaba una—: el motor guarda lo que el metodo PRODUJO (cursor, pasos, artefactos,
estado del backlog) y la API de agente guarda lo que PASO (tareas, registros, latidos), y el
conductor vivia entero en la primera. Una historia cerrada era un `UPDATE` de estado.

Dos arreglos. El primero, `code_ref`: el contrato pedia el hash del commit en el submit terminal, el
motor lo devolvia dentro de `captured[]` y no habia donde escribirlo, asi que APTS no podia decir que
commit cerro que historia. Ahora es columna de `backlog_items` (migracion 019) y viaja tambien en la
vista `compact`, que es la que leen los agentes por defecto. Se guarda solo si viene: un submit sin
hash no borra el que una entrega anterior dejo.

El segundo, el registro del conductor: abre **una tarea por unidad**, titulada con el nombre de la
historia, y la mueve con lo unico medible desde fuera —modelo, intento, duracion y codigo de
salida—, con `--no-task-log` para apagarlo. Esa tarea viaja al agente en el prompt (`{task_id}`)
para que use esa y no registre otra, y ahi hay algo mas que evitar una fila duplicada: **la tarea
que un agente registra por su cuenta se queda con la unidad**, y `update_task_status` propaga por
ese puntero, asi que cerrarla pondria la historia en `done` sin pasar por la compuerta. Se vio en
produccion el 2026-08-08 —la tarea `Dev story 344da12c` era la tarea activa de su historia— antes
de que mordiera. La del conductor no lo es, y por eso es la que tiene que usarse.
`review` significa que el agente entrego y el motor no lo ha confirmado, y no se asciende a `done`
por cortesia: quien puede decir que una unidad cerro es el motor, y lo dice en la vuelta siguiente al
pasar a otra. Todo el camino es best-effort: el registro de una ejecucion no puede ser el motivo de
que la ejecucion pare.

**Asociar una tarea a una unidad ya no es poder cerrarla.** Eran la misma cosa y de ahi salian dos
problemas a la vez. `tasks` no tenia ninguna columna hacia `backlog_items`: el vinculo existia solo
del otro lado y en singular, `backlog_items.active_task_id`, la tarea de AHORA. Asi que
`register_task` con `backlog_item_id` pisaba ese puntero y la ejecucion anterior quedaba huerfana
—se podia preguntar cual es la tarea de esta historia, nunca todas sus ejecuciones—. Y ese mismo
puntero es lo que dispara la propagacion de estado, de modo que pedir la asociacion traia de regalo
la capacidad de cerrar la unidad saltandose la compuerta de revision.

Ahora son dos cosas. La **asociacion** es `tasks.backlog_item_id` (migracion 020): informativa,
permanente, sin efectos, y ninguna escritura de `backlog_items` la mira. La **propiedad** sigue
siendo `active_task_id` y sigue siendo lo unico que propaga: nada de lo que propagaba dejo de
propagar. `register_task` acepta `owns_backlog_item` (por defecto `true`, que es lo que hacia hasta
ahora) y con `false` graba la asociacion sin tocar la tarea activa, sin mover la unidad de estado y
sin reanudar —la reanudacion se busca POR el puntero de propiedad, asi que sin propiedad no hay a
quien reanudar, y eso es justo lo que quiere el conductor: cada pasada sobre una unidad es una
ejecucion distinta—. El campo solo no significa nada y se rechaza con 400, y un valor que no sea
booleano tambien, porque colar `false` en silencio seria quitarle la propiedad a quien quiso pedirla.

El conductor pasa a usarlo: su tarea cuelga de la historia y sigue sin poder cerrarla. Antes el
vinculo era el titulo y un JSON dentro de `context`, que no es una relacion y no se puede consultar.
Un APTS anterior al campo no lo rechazaria —el esquema no es estricto y lo descartaria en silencio,
ligando la tarea—, asi que el conductor mira la respuesta y avisa por el diario (`tarea_ligada`).

El backfill de la migracion recupera lo unico reconstruible: las tareas que su historia todavia
apunta. Las que un `register_task` posterior desbanco no dejaron ningun rastro relacional y no se
pueden recuperar; la migracion imprime los dos numeros en vez de dar a entender que los cubrio todos.

**Un atasco ya tiene dos salidas, y ninguna pasa por escribir la base a mano.**

La primera: `report_blocker` acepta `backlog_item_id` y marca **esa** unidad, ademas de la que la
tarea posea. El radio estaba invertido —marcaba el proyecto ENTERO, que no estaba bloqueado, y no la
unidad, que si—, porque solo miraba `active_task_id` y la tarea del conductor no posee ninguna. La
unidad se **nombra** y no se deduce de `tasks.backlog_item_id` a proposito: la asociacion no tiene
efectos, y esa promesa es lo que impide abrir una puerta trasera al lado de la compuerta de revision.
Nombrar una unidad de otro proyecto da 400 y no marca nada por el camino.

La segunda: `POST /api/method/pointers/:agent/release` devuelve la unidad que sostiene un puntero de
metodo —`cursor` a null, `step_status` a `idle`— con un `agent_logs` firmado `Human Supervisor`, sin
`task_id` porque lo que se suelta es el puntero y no una tarea. El arrendamiento ya existia
(`METHOD_CLAIM_TTL_MS`, y «caducar es soltar») pero solo corre contra los punteros de OTROS agentes:
el propio se devuelve tal cual mientras la unidad no sea terminal, y eso es deliberado, porque es lo
que permite matar y relanzar el conductor sin perder el sitio. Lo que faltaba era devolverla a
proposito, y hubo que hacerlo a mano el 2026-08-08 para desatascar fm-synth.

Es ruta de panel y no operacion de agente por dos razones. Una, que soltar SOLO no le sirve al
agente: el `apts_next` siguiente vuelve a reclamar la misma unidad, porque sigue siendo la primera
del plan. Dos, que el caso real es que una persona mire un atasco y decida; el precedente de al lado,
`/api/tasks/:id/resolve`, hace exactamente eso para tareas. Un puntero que no sostiene nada responde
409 en vez de un 200 que no hizo nada.

Lo que **no** se ha hecho, porque es decision de producto y no defecto: dar a `blocked` salida del
reparto —`TERMINAL_STATUSES` sigue siendo `done` y `archived`, asi que una unidad bloqueada se
sigue repartiendo—, que exigiria antes separar los dos significados que hoy comparte ese estado (la
vigilancia de latidos diciendo «perdi contacto» y el agente diciendo «esto no se puede todavia»); y
que `projects.status` siga siendo un flag pegajoso cuya unica salida es `/api/tasks/:id/resolve`.

**El motor reparte las stories por el plan y no por el identificador.** `claimDevStory` ordenaba las
candidatas del epic por `created_at, id`, y las stories de un epic las escribe el motor en un solo
lote —`bmad-create-epics-and-stories`—, asi que el `created_at` empata en todas y el desempate lo
decidia el UUID: reparto al azar. Costo una parada en produccion el 2026-08-08: de las 15 que
quedaban en fm-synth salio primera la de `sort_order` **240**, la ultima del plan —accesibilidad del
editor—, que depende de otras cinco todavia sin hacer. El agente lo verifico, se nego a fabricarlas
como efecto colateral, reporto el bloqueo dos veces y el freno de estancamiento paro el bucle: la
cadena entera se comporto como debia sobre un reparto que no tenia sentido. Ahora ordena por
`priority, sort_order` —las dos columnas donde el backlog declara su plan, y las mismas por las que
ya ordenaba `list_backlog_items`— con `created_at, id` detras como desempate.

**Los artefactos publicados llevan la version en la URL, y el origen dice que no se cacheen.** El
sitio esta detras de Cloudflare, que cachea por extension: `.js` esta en su lista por defecto, asi
que `…/conductor/apts-loop.js` se servia desde el borde con `max-age=14400` aunque la ruta cuelgue
de `/api/` y el origen no mandara ninguna directiva. Se vio el 2026-08-08 justo despues de
desplegar: el manifiesto anunciaba el conductor en 1.4.0 y la URL entregaba el 1.3.0 —47.683 bytes
contra los 57.834 del servidor— con `Age: 6345`. Eso rompe justo lo que `artifact_version` promete.

Dos correcciones que se cubren la espalda. `sendIntegrationArtifact` manda `Cache-Control: no-cache`
—que no prohibe guardar, obliga a revalidar, y con el ETag que pone express cuesta un 304— para
quien respete las directivas. Y el manifiesto publica cada artefacto con su version dentro de la URL
(`?v=1.4.0`), que no la lee nadie —la ruta se resuelve por camino— pero mete la version en la CLAVE
de cache: cualquier intermediario reparte por URL, asi que una version nueva estrena URL y no puede
recibir los bytes de la anterior, conteste el origen lo que conteste. Descartado aprovechar la URL
versionada para cachear a largo plazo (`immutable`): la version se bumpea a mano, y un archivo
editado sin bump quedaria clavado en el borde todo ese plazo.

**`ready_for_dev` ya existe tambien para la API.** La migracion 010 metio ese estado en la columna
—lo declara en su propia lista, `BACKLOG_STATUSES_NEW`— y el motor lo escribe en CADA story que
crea, pero la constante `BACKLOG_STATUSES` de `backend/index.js` se quedo con la lista de antes de
esa migracion. La base aceptaba el valor, el motor lo escribia, y la API ni lo leia ni lo escribia.
Dos sintomas el 2026-08-08, con horas de diferencia y la misma raiz: `list_backlog_items` con ese
filtro rebotando con 400 a un agente en produccion, y `update_backlog_item` incapaz de reponer una
story que la vigilancia habia dejado en `blocked` —que es el unico camino de vuelta que el propio
motor recomienda al rechazar un `apts_set_status` desde ahi—, cosa que obligo a escribir la
`344da12c` a mano en la base. Ampliar la lista no rompe ninguna llamada: el valor ya era legal en la
columna. La lista vivia copiada en tres sitios y los tres estan al dia: la constante, los seis enums
de `apts_skills.json` y el selector del panel.

**Un parpadeo de red ya no tumba el bucle.** Cada llamada MCP del conductor reintenta tres veces
—2 s, 6 s, 18 s— antes de la parada por red, y solo lo que puede salir distinto: el `fetch` que no
llego a hablar, un 429 y los 5xx; un 4xx es una llamada mal hecha y un error JSON-RPC es el servidor
contestando que no. Cada reintento deja `reintento_red` en el diario, porque un servidor que se
degrada se ve como reintentos que aparecen y se multiplican, y esconderlos convertiria la red de
seguridad en una forma de no enterarse. No es bandera: si la red esta caida de verdad, la parada con
codigo 2 sigue ahi veintiseis segundos despues. Lo pidio la realidad —tres caidas en cuatro vueltas
el 2026-08-08, siempre en el `apts_status` inmediatamente posterior a cerrar una unidad, con el
endpoint respondiendo 200 un minuto mas tarde—, y cada una exigia que una persona relanzara el
conductor. Los dos artefactos del conductor suben a `artifact_version` 1.1.0: el comportamiento
observable cambia, y sin el bump quien cachee por version se queda con el conductor que se para al
primer parpadeo.

Del lado del conductor, `integracion/conductor/prompts/dev-story-revision-adversaria.md`
(`--prompt-file`) exige las tres capas en subagentes paralelos antes de entregar el paso 8, y ante
un hallazgo confirmado —`archivo:linea` mas escenario de fallo concreto— declara la rama que el
propio metodo ya tiene, `{"goto":"step:5"}`, en vez de parchear en silencio. La plantilla vive en el
repo y **ya se publica**, como `loop_prompt_code_review` (1.0.0), en
`…/integrar/conductor/prompts/dev-story-revision-adversaria.md`. Se publica por la misma razon que
el conductor: el README, que si era artefacto, la nombraba, asi que un cliente que arranca desde la
URL leia sobre un archivo que no podia bajarse. Es opcional de verdad —el conductor trae su
plantilla por defecto dentro—, y la compuerta del motor aplica se baje o no.

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

**Un artefacto de la unidad ya no se guarda con la clave de la iniciativa.** `story_spec` es el
unico artefacto por-story del metodo, y se escribia con el mismo `scope_key` que todos los demas
—`initiative:<id>:<doc_type>`—, asi que habia UNA sola fila para la iniciativa entera: la primera
story que escribia la suya se la servia despues a todas las demas por `needs[]`. Lo encontro un
agente el 2026-08-08 conduciendo el bucle de fm-synth: trabajando el importador SysEx recibia la
especificacion de la historia 1.3, se dio cuenta y tiro de `get_backlog_item`. El fallo era mudo
—no da error, da el contexto equivocado— y el siguiente podia no verlo.

El alcance se declara ahora como dato, en `method_outputs.js` (`scope: 'story'`), y de ahi sale el
conjunto que usan la escritura y la lectura. La clave la compone `artifactScopeKey` y nadie mas,
porque `upsertArtifact` y `resolveNeed` tienen que coincidir exactamente. Sin unidad en el cursor,
un need por-story se declara **ausente** en vez de servir el de otra. `WORKFLOW_COMPLETION` sigue
evaluando `artifact-exists` a nivel de iniciativa a proposito: ese predicado gatea el avance de
fase, no el contexto servido, y hacerlo por-story es otra decision, mas estricta y capaz de plantar
una iniciativa en marcha.

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
- **El registro de ejecucion del conductor**, con una iniciativa de prueba montada en `APTS_test`
  (dos historias, la espina previa dada por hecha) y un agente falso, y borrada al terminar. Una
  tarea por unidad y reutilizada entre vueltas mientras el motor apunte a la misma historia —sin
  duplicados—; los tres finales por su camino real: `done` cuando el motor pasa a otra unidad y al
  completarse el ciclo, `stalled` cuando el agente falla, y suelta en `review` cuando el conductor
  para por estancamiento tras una entrega buena. Cada tarea con sus registros: un intento por linea
  y el motivo de la parada.
- **El conductor, contra un agente REAL.** Hasta ahora todo se habia comprobado con un agente falso
  que duerme. Con `claude -p` de verdad (haiku) hablando MCP contra el servidor de prueba desde un
  directorio aislado, el fixture toy fue de `implementation` a `phase=done`: el agente escribio sus
  `log_agent_progress`, reporto un bloqueo legitimo en un intento (no podia crear el commit del
  `code_ref`), cerro las dos stories en el siguiente y el conductor paro con `PARADA (done):
  lifecycle completo`. Tres cosas quedan comprobadas de paso: **`stdio: 'inherit'` sigue mostrando
  la salida del agente en vivo con `spawn`** —el texto del agente aparece intercalado entre las
  lineas `[apts-loop]`, en orden, por los dos sistemas—; el **latido avanza mientras el agente
  trabaja**; y la tarea del conductor queda asociada a la unidad sin poseerla.
- **Las cuatro ordenes del buzon, con el agente real en marcha.** `resume` sin corrida previa se
  rechaza con `cancelled` y su motivo; `start` con payload arranca; `pause` a mitad corta el arbol
  —cinco niveles, con `claude.exe` dentro, todos muertos y ningun huerfano— y devuelve el conductor
  a la espera; `resume` sin payload retoma con la MISMA configuracion y el motor sirve la story
  siguiente; y un `resume` que llega mientras el agente corre queda `done` con «ya estaba
  corriendo», sin reiniciar nada.
- **La señal de vida del conductor**, con `backend/scripts/test_conductor_presence.js` (nuevo;
  necesita el servidor levantado, porque la presencia vive en la memoria de ESE proceso y no
  hay forma de mirarla sin el; crea su proyecto y lo borra). Treinta comprobaciones en verde
  con `CONDUCTOR_PRESENCE_TTL_MS=3000`, que es lo que permite ver caducar una señal sin
  esperar un minuto. Un conductor que no ha sondeado no esta escuchando y no consta ninguna
  señal suya; en cuanto sondea, `listening` y `seconds_ago` a 0; pasado el plazo deja de
  escuchar pero **conserva** `last_seen_at`, que es lo que separa callado de apagado. Dos
  destinatarios en la misma respuesta —el consultado escuchando y el de una orden pendiente
  sin señal ninguna—; el acuse y el diario tambien sellan; una orden que ya no esta pendiente
  no arrastra a su destinatario a la lista; y pedir el estado sin nombre no inventa una fila
  vacia.
- **Y con el conductor de verdad**, `apts-loop.js --daemon` contra el servidor de prueba: en
  espera —sin proyecto y sin agente— aparece escuchando con la señal de un segundo antes, y
  al matarlo queda con `listening: false` y su ultima señal intacta. Es la comprobacion que
  importa: la señal que anota el servidor es la que produce el conductor publicado, sin
  haberlo tocado.
- **La caducidad de las ordenes**, con `backend/scripts/test_conductor_order_expiry.js` (nuevo;
  necesita el servidor levantado, porque la mitad del criterio es la presencia y esa vive en su
  memoria; crea su proyecto y lo borra). **El plazo no se acorta**: las filas se envejecen contra
  la base, asi que lo que se comprueba es el de verdad —10 min— sin esperar diez minutos. Veinte
  comprobaciones en verde. Una orden recien encolada NO caduca aunque no haya nadie escuchando,
  que es lo que protege el encolar-antes-de-arrancar; pasada del plazo y con el destinatario
  ausente, mirar el buzon la caduca, con el motivo escrito en la propia fila y sin acuse. Quien
  esta escuchando manda sobre el reloj: el panel no toca su orden por vieja que sea, pero su
  sondeo siguiente no se la entrega —`order: null`— y la deja caducada con el otro motivo, que no
  es el mismo texto. Lo que ya se resolvio no se reescribe. Y el radio se respeta: una orden vieja
  de otro nombre y sin proyecto no la toca ese panel ni el sondeo de otro conductor, y si la caduca
  el suyo al preguntar.
- **El cerrojo del servidor recien arrancado**, que es la otra rama del criterio de ausencia: con
  el servidor en pie 11 s y el plazo de señal en 3.600 s, una orden vieja de un nombre sin señal
  **no** caduca. La prueba lo detecta y comprueba eso en vez del escenario completo, porque el caso
  no se puede provocar desde fuera: depende de cuando arranco el servidor.
- **Y en pantalla**, contra el servidor de prueba: la etiqueta «No hay nadie al otro lado», el
  texto de ayuda diciendo el plazo que devuelve el servidor, una orden de hace 40 min pasando a
  `cancelled` con su motivo debajo por el solo hecho de mirar la pestaña, la reciente aguantando
  `pending` con «no hay nadie al otro lado; caduca a los 10 min», y el aviso al encolar: «si no
  arranca uno en 10 min, la orden caducara sola».
- **El corte en POSIX, ejecutado por fin** (WSL Ubuntu contra el servidor de prueba de Windows). El
  agente arranca en su propio grupo (`pgid` distinto del conductor) con un nieto dentro. Un agente
  que coopera muere entero en ~2 s sin pagar la gracia. Un agente que **ignora `SIGTERM`** es el que
  destapo el fallo: con el codigo anterior, treinta segundos despues del `stop` seguian vivos su
  shell y su nieto, ya reparentados a init, y el conductor hacia rato que habia salido con codigo
  15. Con el arreglo, espera los diez segundos, avisa («el arbol del agente sigue vivo tras 10 s;
  forzando»), fuerza, y solo entonces para: cero supervivientes. Windows revalidado con el
  `taskkill` ya esperado, en modo no-daemon —que es donde el conductor sale justo detras—: dos
  nietos y su `cmd`, todos muertos.
- **El `code_ref` se escribe**, comprobado dentro de `test_code_review_gate.js`: el submit terminal
  con `code_ref` deja el hash en la historia.
- **Asociar frente a poseer**, con `backend/scripts/test_task_backlog_link.js` (nuevo; necesita el
  servidor levantado porque la validacion del campo vive en el esquema HTTP/MCP, crea su propio
  proyecto y lo borra entero al terminar). Treinta comprobaciones en verde por los dos caminos.
  El de siempre no cambia: sin el campo la tarea sigue quedando como tarea activa, la unidad pasa a
  `in_progress` y una segunda llamada reanuda en vez de duplicar. Con `owns_backlog_item: false` la
  tarea queda asociada igual, la tarea activa de la unidad no se toca, la unidad no se mueve de
  estado, una segunda llamada crea otra tarea —dos ejecuciones colgando de la misma historia, que es
  el historial que no existia— y la respuesta devuelve el campo, que es como un cliente sabe que el
  servidor lo entendio. La propagacion se comprobo sobre una misma unidad con las dos tareas a la
  vez: cerrar la asociada la deja en `in_progress` y cerrar la dueña la pone en `done` y suelta el
  puntero, y la asociada conserva su asociacion despues de cerrada. Los rechazos: el campo sin
  `backlog_item_id` da 400 nombrando lo que falta, y `'quizas'` da 400 en vez de colar como `false`;
  por MCP el rechazo llega como `isError`. Y se lee: `get_task` lo devuelve en las dos vistas, y en
  `compact` una tarea sin unidad no paga la clave vacia.
- **Las dos salidas del atasco**, con `backend/scripts/test_blocker_scope_and_release.js` (nuevo),
  diecinueve comprobaciones. Una tarea que no posee nada nombra su unidad y **esa** queda `blocked`,
  sin haberla poseido en ningun momento; sin el campo, `report_blocker` marca la que la tarea posee,
  como hasta ahora; una unidad de otro proyecto da 400 y sigue en su estado. Soltar el claim exige
  sesion de panel (401 sin ella), un puntero inexistente da 404, uno que no sostiene nada da 409, y
  el que si sostiene queda con el cursor vacio y en `idle` diciendo cual solto, con el rastro firmado
  `Human Supervisor` sin `task_id` y con el motivo dentro. La unidad soltada no cambia de estado:
  vuelve al reparto tal cual.
- **El orden de reparto**, con `backend/scripts/test_dev_story_claim_order.js` (nuevo; transaccion
  revertida, sin servidor). Montado con los UUID en contra —la primera del plan es la que el criterio
  viejo dejaba para el final—: reparte primero la de `sort_order` mas bajo y no la que ganaba por
  identificador; cerrada esa, cae la segunda del plan; y una `priority` mas alta se salta el
  `sort_order`. Comprobado ademas que la prueba no es vacua: con el orden viejo, tres de las cuatro
  caen en rojo y siempre gana el mismo UUID.
- **Las URL versionadas del manifiesto**: cada artefacto se publica con `?v=<artifact_version>` —y
  la de descarga con `&download=1` detras—, la ruta sirve el mismo contenido con la query puesta, y
  la respuesta del origen lleva `Cache-Control: no-cache`.
- **Y por la URL publica, contra el borde de verdad**: la URL versionada devuelve los 57.834 bytes
  del servidor con el mismo md5, y a la segunda peticion Cloudflare contesta
  `cf-cache-status: REVALIDATED` —guarda, pero pregunta al origen antes de servir, que es
  exactamente lo que `no-cache` pide—. Ojo al leerlo: **la cabecera `Cache-Control` que se ve desde
  fuera es `max-age=14400`, reescrita por Cloudflare**, no la del origen; por dentro (`127.0.0.1:46315`)
  sale `no-cache`. Quien mire solo la respuesta publica concluiria que el arreglo no llego.
- **`ready_for_dev` por la API**, con `backend/scripts/test_ready_for_dev_status.js` (nuevo):
  `list_backlog_items` filtra por el estado y devuelve la story que el motor creo asi;
  `update_backlog_item` repone a `ready_for_dev` una story dejada en `blocked`, y la deja en el
  estado canonico del metodo y no en un primo suyo; y un estado inventado sigue dando 400.
- El backfill de la migracion 020 sobre `APTS_test`: `backlog_item_id` recuperado en 93 tareas, 196
  sin asociacion posible —las que un `register_task` posterior desbanco antes de que la columna
  existiera—.
- **El conductor asocia y no posee**, con una iniciativa de prueba en `implementation` y un agente
  falso, borrada al terminar: abre su tarea titulada con el nombre de la historia y con
  `backlog_item_id` escrito, y la unidad termina la vuelta con `active_task_id` en `null` y en
  `ready`, sin que el conductor la haya tocado. El aviso `tarea_ligada` no salio, que es lo correcto
  contra un servidor que si acepta el campo.
- **Los reintentos de red del conductor**, por los dos caminos y en seco (`--dry-run`, que resuelve
  la decision sin lanzar agente). Contra un puerto muerto: tres reintentos, tres lineas
  `reintento_red` en el diario con las esperas 2000/6000/18000 ms, y parada por red con codigo 2 a
  los 26,1 s. Contra una ruta que contesta 404 (`POST /api/health`): ni un reintento y parada en
  1,1 s, que es lo correcto —repetir una llamada mal hecha solo retrasa el motivo—.
- **La compuerta de revision por unidad**, con `backend/scripts/test_code_review_gate.js` (nuevo:
  no habia arnes del motor de metodo, solo de la API de agente; corre dentro de una transaccion que
  se revierte y no necesita el servidor levantado). El submit terminal sin revision se rechaza
  nombrando `code_review`, y no deja nada detras: la story sigue `in_progress`, no hay artefacto
  escrito y el cursor no avanza. Con la revision cierra, captura las dos declaraciones
  (`artifact,status`), la story queda `done` y el documento aterriza en
  `initiative:<id>:code_review:story:<story>` —no en la clave de la iniciativa—, asi que otra story
  de la misma iniciativa no lo ve como suyo. La migracion 018 y el sembrado coinciden: tras correr
  `seed:method:test` el paso 10 sigue con los mismos dos descriptores.
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
- **El alcance por-unidad de `story_spec`**, en cinco casos: con solo la spec de A escrita, A la ve y
  B se declara ausente en vez de recibir la ajena; con las dos escritas, cada una ve la suya y hay
  dos filas con `scope_key` distinto; reescribir la de A la versiona a v2 sin crear otra fila ni
  tocar la de B; un artefacto de iniciativa (`architecture`) lo siguen viendo las dos y tambien
  quien no sostiene ninguna unidad; y un need por-story sin unidad en el cursor da `present: false`.
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

Donde vive, al dia el 2026-08-08:

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

**Comprobado despues del segundo despliegue del 2026-08-08** (`91c5bc5`, sin migraciones), por la
URL publica: el manifiesto sale con `schema_version` **1.1.0** y **7 artefactos**
—`skill_markdown`, `agent_guidelines` y `adapter_generator` en 1.1.0—; `supported_runtime_values`,
los bloques de registro y los `mappings` dicen los mismos dos runtimes, `claudecode` y `opencode`;
no queda ni una mencion a VS Code en el JSON entero; los dos artefactos del conductor responden 200
(44 KB el script, 15 KB el README) y `/agentes/apts-method-orchestrator.agent.md` responde 404, que
es la respuesta correcta ahora. Las seis comprobaciones del desplegador pasaron.

**Comprobado despues del despliegue del 2026-08-08** (`c41ad1b`, sin migraciones), por la URL
publica y con credenciales leidas en el propio servidor: `tools/list` devuelve **22 operaciones**,
entre ellas `set_project_constraints`; la guardia de la fase de partida rechaza `phase:
'solutioning'` nombrando `brief` y `prd`, y no deja proyecto ni iniciativa detras; el manifiesto
publica `surface_spec` en 1.0.2, `skills_json` en 1.0.1 y la regla nueva dentro de `bootstrap_rule`;
y las seis comprobaciones del desplegador —`/api/health` local y publico, manifiesto con
`mcp_endpoint`, `/mcp` por los dos caminos y el bundle del dist nuevo— pasaron. El aviso de `/mcp`
no salio: nginx lo enruta desde el 2026-08-07.

**Comprobado despues del cuarto despliegue del 2026-08-08** (`091e65b`, **con migracion**: la 018,
la primera que corre en PROD desde el arranque de cero). La copia previa quedo en
`/root/apts-backup-20260808-020936-ce2fd604f.dump` (556 KB). En la base del servidor: `code_review`
esta en el enum de `semantic_documents`, y el paso terminal de `bmad-dev-story` (`bmad:v6.8.0`, el
10) trae los dos descriptores —`status` y el `artifact` `code_review` con `scope: 'story'` y
`required_for_close: true`—, asi que el recableado alcanzo a la libreria ya sembrada sin necesidad
de re-sembrar. Por la URL publica, `dev_story_completion_rule` ya publica la regla de los dos
outputs. Las seis comprobaciones del desplegador pasaron y el aviso de `/mcp` no salio.

Se desplego **con el bucle de fm-synth corriendo contra PROD**, por decision explicita del
operador y no por descuido: el reinicio de pm2 puede tumbar la llamada MCP de un agente en vuelo, y
un conductor arrancado antes de este cambio lleva en memoria una plantilla que no manda
`output.content`, asi que sus submits terminales rebotan hasta que se reinicie. El rechazo es
autoexplicativo —dice que falta `output.content`—, que es lo que hace el riesgo asumible.

Y funciono a la primera, en la primera historia que paso por ella: la `258f7db6` cerro a las
05:13:54 —**despues** del despliegue de las 05:06— dejando su `code_review` v1 en
`initiative:be1691a6…:code_review:story:258f7db6…`, con la clave de la unidad. El agente que la
cerro llevaba la plantilla vieja, la que no manda `output.content`: choco con el rechazo, lo leyo y
mando la revision. La compuerta se explica sola, que era la apuesta. La revision, ademas, encontro
un fallo real —los algoritmos 3 y 4, y el 5 y el 6, eran duplicados byte a byte por una asignacion
equivocada del operador de realimentacion— y una asercion de test vacua; el agente lo cruzo contra
dexed y hexter, lo corrigio y volvio a pasar la revision limpia. Costo 33,8 min contra los 5,7–23
de las historias sin revisar.

**Comprobado despues del quinto despliegue del 2026-08-08** (`085b448`, sin migraciones): el
manifiesto publica `loop_conductor` y `loop_conductor_readme` en `artifact_version` **1.1.0**, y las
dos rutas responden 200 sirviendo lo nuevo de verdad —el script (46,2 KB) trae `REINTENTOS_RED`, y
el README (18,5 KB) la seccion de reintentos de red y la tabla de plantillas de `prompts/`—. Las
seis comprobaciones del desplegador pasaron.

**Comprobado despues del sexto despliegue del 2026-08-08** (`be3e7b1`, sin migraciones): el
manifiesto publica **8 artefactos**, con `loop_prompt_code_review` en 1.0.0, `optional: true` y
dependiendo de `loop_conductor`; y su ruta responde 200 con `text/markdown` y 7 KB del texto real
—las tres capas nombradas y los marcadores como `{story_id}` sin sustituir, que es como tiene que
viajar una plantilla—. Las seis comprobaciones del desplegador pasaron.

**Comprobado despues del septimo despliegue del 2026-08-08** (`3d06ef9`, **con migracion**: la 020).
La copia previa quedo en `/root/apts-backup-20260808-040808-54b3f5988.dump` (562 KB). El backfill
sobre PROD asocio 2 tareas de 12: las otras diez son de sesiones anteriores cuyo puntero ya habia
sido pisado. Por la URL publica, el manifiesto sale con `schema_version` **1.1.1**, el conductor y su
README en **1.4.0**, `skills_json` en 1.0.2 y `loop_prompt_code_review` en 1.1.1, y publica
`register_task_link_rule`; `skills.json` trae `owns_backlog_item` en las dos ramas del `oneOf`; y
`tools/list` devuelve 22 operaciones con el campo en el `inputSchema` de `register_task`. Las seis
comprobaciones del desplegador pasaron.

Y con la migracion ya aplicada se desligo a mano la tarea `f6c66111` (`Dev story 344da12c…`, la que
registro un agente por su cuenta y quedaba como tarea activa de su historia): en ese orden, porque el
backfill le grabo antes su `backlog_item_id`. Conserva la asociacion y perdio la propiedad, asi que
su `stalled` ya no arrastra la historia. Lo que el desligado no deshace es el `blocked` que la
vigilancia de fondo ya le habia puesto: la maquina de metodo no tiene salida desde ese estado
—`apts_set_status` responde 409 diciendo que se reponga con `update_backlog_item`—, asi que la
historia `344da12c` quedaba en `blocked` esperando esa reposicion. Ya no: comprobado contra la base
de PROD el 2026-08-08, esta en `done` desde las 07:34 de ese dia y **no queda ninguna unidad
`blocked`** en toda la produccion.

**Comprobado despues del octavo despliegue del 2026-08-08** (`99c5cfa`, **con tres
migraciones**: la 021 `entity_overrides`, la 022 —el CHECK de `agent_logs.action_type` con
`journal`— y la 023 `conductor_orders`; batch 5). La copia previa quedo en
`/root/apts-backup-20260808-153424-424d2d4f4.dump` (564 KB). Entraron cuatro commits: las
cinco pestañas del proyecto y las restricciones editables, el roster BMAD editable con
`role_profile`, el conductor asincrono con buzon de ordenes, y el arreglo de `resume` y del
corte del arbol.

En la base del servidor: las dos tablas nuevas existen, el CHECK de `agent_logs` ya admite
`journal` y el de `conductor_orders.command` trae los cuatro valores, `resume` incluido. Por
la URL publica: el manifiesto sale con `schema_version` **1.1.1** y **8 artefactos**, con el
conductor y su README en **1.6.0**; las dos rutas versionadas responden 200 sirviendo lo
nuevo de verdad —el script (75.567 bytes) trae `grupoVivo`, `GRACIA_CORTE_MS`,
`cortePendiente` y el rechazo de la reanudacion sin corrida previa, y el README su seccion
«Reanudar»—; y `tools/list` devuelve **22 operaciones**, `set_project_constraints` entre
ellas. El frontend desplegado es el nuevo: su chunk `ProjectDetails` trae el boton Reanudar,
las pestañas y la llamada a `conductor/orders`, y la pagina Roster se sirve aparte. Las seis
comprobaciones del desplegador pasaron y el aviso de `/mcp` no salio.

El script publicado difiere del local **solo en el fin de linea** —1.528 bytes de diferencia
sobre 1.528 lineas, y el md5 coincide normalizando a LF—, que es lo de siempre: el checkout
del servidor guarda LF. Y la cabecera `Cache-Control` del `.js` se ve otra vez como
`max-age=14400` desde fuera, reescrita por Cloudflare; el `.md` de al lado, que no esta en su
lista por extension, sale con el `no-cache` del origen.

**Comprobado despues del noveno despliegue del 2026-08-08** (`0858fa1`, **sin migraciones**:
no hay tabla ni columna nueva, la presencia vive en la memoria del proceso). Entraron dos
commits, la señal de vida del buzon y la nota del octavo despliegue. El frontend desplegado es
el nuevo y se comprobo contra el contenido y no contra el 200: el chunk `ProjectDetails` que
sirve nginx trae los cuatro estados por su texto —«No hay nadie al otro lado», «Sin señal desde
hace», «El servidor acaba de arrancar», «sin datos del destinatario»— y el «se actualiza sola
cada 10 s». En el servidor, `backend/index.js` trae las cuatro llamadas a `markConductorSeen` y
la constante del plazo, y pm2 quedo `online` con **un** reinicio (21 acumulados contra 20), que
es lo que distingue un arranque bueno del bucle de los auto-chequeos. Las seis comprobaciones
del desplegador pasaron y el aviso de `/mcp` no salio.

Lo que **no** se ha comprobado en PROD es la pantalla: el panel de produccion pide la
contraseña del operador. Los cuatro estados se vieron en vivo contra el servidor de prueba.
—Ya no: la señal de vida se vio en verde contra PROD el 2026-08-08, ver abajo.

**`resume` y el corte del arbol, por fin ejercidos contra PROD** (2026-08-08). Hasta ese dia
todo el buzon se habia probado solo contra el servidor de prueba, y la rama POSIX del corte
solo en WSL. Se ejercio **por el panel de produccion**, pulsando los botones de verdad, con el
conductor corriendo **en el propio servidor** —asi ningun secreto sale del `.env`, y de paso la
rama que se ejerce es la POSIX contra produccion— y un agente falso que solo duerme y lanza un
nieto, que es lo unico que distingue matar al hijo de matar al arbol.

| paso | resultado |
|---|---|
| Reanudar sin corrida previa | `cancelled`, «no hay corrida anterior que reanudar» |
| Iniciar | reclama una story y lanza el agente en su propio grupo (`pgid` distinto del conductor) |
| Pausar | los TRES muertos —`sh`, agente y nieto—; el conductor sobrevive y vuelve a esperar |
| Reanudar | retoma la misma story con la misma configuracion, sin reescribir nada en el panel |
| Detener | el arbol muerto otra vez |

Y de paso quedaron vistas dos cosas mas contra PROD: la **señal de vida** en verde («Escuchando
· ultima señal hace 0 s») y el **diario del conductor** llegando a APTS —`parada`, `agente ...
terminado por SIGTERM`, `exit_code 15`— colgado de la tarea de la unidad.

El escenario se monto conduciendo el ciclo BMAD **real** por MCP con contenido de relleno hasta
`implementation` —sin sembrar nada y sin tocar el corpus—, sobre un proyecto de fixture propio
que se borro entero al terminar (3 iniciativas, 4 stories, 22 documentos, 2 tareas, 10 filas de
diario, 5 ordenes). En PROD volvio a quedar solo `fm-synth`. Dos trampas del montaje, por si
hay que repetirlo: el motor espera las historias en **`output.stories`** y no bajo el nombre del
`kind` —mandarlas como `backlog_items` cierra el paso capturando cero, porque las stories son
`extra` y quien gatea la completitud es el artefacto `epics`—; y el ciclo **vuelve sobre un
mismo rol mas de una vez**, asi que llevar la cuenta de los roles ya usados en vez del rol
actual deja al agente plantado en `wait` para siempre.

**Comprobado despues del decimo despliegue del 2026-08-08** (`7396a7e`, **sin migraciones**:
`cancelled` ya estaba en el enum y el motivo cabe en `detail`). Entraron dos commits, la
caducidad de las ordenes y la nota del noveno despliegue. Se comprobo contra contenido y no
contra el 200: el chunk `ProjectDetails` que sirve nginx trae los tres textos nuevos —«caduca
sola pasados», «caduca a los» y «caducara sola»—, y `backend/index.js` en el servidor trae las
dos funciones de caducidad y las dos constantes. **Y funcionalmente vivo**: sondear el buzon en
PROD —que es el camino que caduca al entregar— responde 200 con `{"order":null}`. pm2 quedo
`online` con **un** reinicio (22 acumulados contra 21). Las seis comprobaciones del desplegador
pasaron y el aviso de `/mcp` no salio.

**El panel ya escribe donde antes solo miraba, y el conductor ya se puede parar.** Tres
huecos que venian del mismo sitio —lo que APTS sabia hacer no tenia por donde pedirse— se
cerraron el 2026-08-08.

El primero, las restricciones del proyecto: la logica existia entera desde ese mismo dia,
pero solo se llegaba a ella por la superficie de agente (`authenticateAgent`), y el panel
va por sesion. Dos rutas de dashboard sobre las mismas funciones, ninguna logica nueva.

El segundo, el roster del metodo. `entities` guarda persona, principios, estilo e
instruccion desde la primera siembra y **no las leia nadie**: el paso servido llevaba
`role`, y `role` era la CLAVE de la entity, no su perfil. Un editor habria editado texto
que ningun agente recibe. Ahora la lectura pasa por `resolveEntityProfile` —corpus,
override global `'*'`, override del proyecto, en ese orden, y un campo nulo hereda— y
`buildStepPayload` adjunta `role_profile`. Solo si alguien edito a ese agente: el perfil
del corpus pesa unos 650 caracteres y mandarlo en cada paso seria un gasto de contexto que
nadie pidio; sin override el payload sale byte a byte como salia antes.

Las ediciones **no** se escriben en `entities`, porque `bmad_seed.js` las borraria con su
`onConflict('key').merge()`. Viven en `entity_overrides`, tabla que el seed no mira. Las
reglas de conduccion siguen el mismo reparto: `METHOD_CONDUCTION` sigue siendo la fuente
autoritativa y el override va a `config`, como las restricciones; el manifiesto acepta
`?project_url=` y mezcla. `schema_version` no cambia —no hay clave nueva— y `role_profile`
es clave de respuesta, no de entrada, asi que las 22 operaciones tampoco.

El tercero, el conductor. Lanzaba al agente con `spawnSync`, que bloquea el proceso entero:
no podia latir mientras el agente trabajaba —de ahi que la vigilancia de fondo marcara
`stalled` una historia larga y hubiera que reanimar la tarea al cerrarla— y no podia
escuchar, asi que detenerlo era matar el proceso a mano en la maquina donde corriera. Con
`spawn` late cada cinco minutos, copia su diario a `agent_logs` (`action_type: 'journal'`,
migracion 022) y sondea un buzon de ordenes cada diez segundos, tambien mientras el agente
corre. Al recibir `stop` o `pause` mata **el arbol**: `shell: true` interpone `cmd.exe`, asi
que matar el pid del hijo dejaria al agente vivo escribiendo en APTS. Y sin `--project-url`
ni `--agent-cmd` ya no falla: espera ordenes.

El buzon (`conductor_orders`, migracion 023) y el diario van por REST y no por MCP: no son
del metodo, no las llama un agente, y el panel —que tambien escribe ordenes— va por sesion.

Comprobado contra `APTS_test` con el fixture `apts://fixture/toy` llevado a
`implementation`: el latido avanzando mientras el agente falso dormia, una orden de `stop`
cortandolo con salida 15 y sin dejar huerfanos (`taskkill /t`), la corrida siguiente
retomando la misma story `defb4b31`, y `pause` devolviendo al conductor a la espera sin
matar el proceso.

**Y `resume` ya hace algo.** Estaba en el enum de la migracion 023 y en `CONDUCTOR_COMMANDS`
desde el primer dia, el panel podia encolarlo y **no lo recogia nadie**: la orden se quedaba
`pending` para siempre. Ahora es un `start` que no trae configuracion —repite la de la
ultima corrida de ESE proceso—, que es lo que convierte retomar un `pause` en un boton en
vez de volver a escribir el comando del agente. Lo que recuerda es el proceso y no APTS, a
proposito: `--agent-cmd` invoca un binario de la maquina donde corre el conductor, asi que
una configuracion guardada en el servidor podria llegarle a otra maquina donde ese comando
no existe. Un conductor recien arrancado la rechaza (`cancelled`, «no hay corrida anterior
que reanudar») en vez de adivinar, y un `resume` que llega mientras el agente trabaja se
acusa y se descarta, porque dejarlo en el buzon lo pondria por delante de la orden de parar.

**Y el corte remata de verdad en POSIX.** La rama existia escrita y nunca ejecutada, con dos
fallos que se tapaban entre si: el `SIGKILL` de gracia colgaba de un
`setTimeout(...).unref()` —que por definicion no retiene el bucle de eventos, y el conductor
sale con codigo 15 un segundo despues de cortar, asi que la señal no llegaba nunca— y su
guardian preguntaba por `hijo.exitCode`, es decir por el shell, que es lo PRIMERO que muere
con el `SIGTERM` mientras sus descendientes siguen. Cualquiera de los dos por separado ya
bastaba para dejar al agente vivo. Ahora la gracia se espera dentro del corte, lo que se
mira es si el **grupo** sigue vivo (`kill(-pgid, 0)`), y quien va a parar espera esa promesa
antes de irse. En Windows el `taskkill /t` pasa a esperarse tambien, por el mismo motivo: en
modo no-daemon el conductor sale justo detras.

Los dos artefactos del conductor suben a `artifact_version` **1.6.0**: quien se quedara con
la 1.5.0 tiene un boton Reanudar cuya orden no recoge nadie y, en Linux o macOS, un corte
que cree haber matado al agente. Desplegado el 2026-08-08 con sus tres migraciones.

**Y el panel ya dice si hay alguien al otro lado del buzon.** El buzon solo lo atiende quien
esta corriendo, asi que una orden `pending` significaba dos cosas muy distintas —«la recoge
en diez segundos» y «no hay nadie escuchando ese nombre»— y el panel las mostraba
exactamente igual. Pulsar Detener y no saber si sirvio de algo era el daño real; el que
las ordenes viejas se acumulen es el otro problema, y se cerro despues (ver abajo).

Lo que las distingue ya pasaba por el servidor: **el sondeo del buzon**. Quien pregunta es,
por definicion, quien puede recoger la orden, y preguntan los dos modos —el que espera y el
que esta conduciendo, tambien mientras el agente trabaja—, asi que basta con anotar quien
pregunto. No hace falta un latido nuevo, ni una columna, ni tocar el conductor: `apts-loop.js`
no cambia ni una linea y los dos artefactos se quedan en **1.6.0**.

La anotacion vive en la **memoria del proceso** y no en la base. Es un dato que caduca en un
minuto y no vale nada pasado ese minuto: persistirlo serian seis escrituras por minuto y por
conductor para no contestar nada que no conteste un `Map`. Tampoco es una segunda version de
la verdad —no dice que hace el conductor, solo cuando hablo—, asi que perderla en un reinicio
no desincroniza nada y se recupera sola al sondeo siguiente. Ese hueco es el unico riesgo, y
esta cubierto: la respuesta lleva `server_uptime_seconds`, y con el servidor recien arrancado
el panel calla en vez de afirmar una ausencia que todavia no puede conocer. Va en segundos y
no como fecha a proposito, para que el desfase del reloj del navegador no entre en la unica
cuenta que decide si se puede afirmar algo.

`GET /api/dashboard/projects/:url/conductor` devuelve `presence[]` con `last_seen_at`,
`seconds_ago` y `listening` —para el conductor consultado y para el destinatario de cada
orden que siga pendiente, que no tiene por que ser el mismo—. El plazo son 60 s, seis
sondeos: un sondeo perdido no es una ausencia. Se ajusta con `CONDUCTOR_PRESENCE_TTL_MS`,
por entorno y no por bandera, igual que los intervalos del conductor y por el mismo motivo:
nadie lo toca en una corrida normal, pero una prueba no puede esperar un minuto.

Son **cuatro** estados y no dos, porque «callado» no es «apagado»: escuchando, callado desde
hace tanto (hablo y dejo de hacerlo), no hay nadie (nunca hablo, y el servidor lleva en pie
lo suficiente para saberlo) y sin datos (el servidor acaba de arrancar). El aviso que sale al
encolar se compone **despues** de releer el estado: encolar siempre funciona —escribe una
fila— y prometer «la recoge en unos diez segundos» cuando no hay nadie escuchando era
justamente lo que dejaba mudo al buzon.

**Y una orden que nadie va a recoger ya caduca.** Era el otro medio problema del buzon: una orden
dirigida a un conductor que no corre se quedaba `pending` para siempre. El daño visible era la
lista acumulando lo que nunca se recogeria; el que muerde es otro, y es el que decidio el diseño:
el conductor en espera recoge la PRIMERA pendiente de su nombre, asi que uno arrancado mañana
ejecutaria el `start` de hoy —o cortaria con un `stop` que ya no viene a cuento—. Ejecutar una
orden rancia es peor que perderla.

El sondeo del conductor no vale como unico disparador, porque el caso a caducar es justamente
aquel en que no hay nadie sondeando. Son **dos** reglas con dos motivos. Al **entregar**
(`/conductor/orders/next`) no se entrega lo que lleva mas del plazo, y ahi no hace falta mirar la
presencia: quien pregunta esta vivo por definicion, y si la orden siguio pendiente todo ese rato es
que el conductor estaba ocupado con otra corrida o acababa de arrancar. Al **mirar** (la ruta del
panel) caduca lo que lleva mas del plazo Y cuyo destinatario consta ausente, que es justo lo que la
señal de vida ya sabia decir; el plazo a secas mataria la orden encolada a proposito para un
conductor que se arranca cinco minutos despues.

El plazo son **10 min**, ajustable con `CONDUCTOR_ORDER_TTL_MS` —por entorno y no por bandera, como
los otros dos— y viaja en la respuesta (`order_ttl_seconds`) para que el panel lo diga en vez de
llevarlo escrito, que se separaria el dia que alguien lo tocara. La ausencia se juzga con el mismo
cerrojo que ya usa el panel: sin ninguna señal de ese nombre solo se puede afirmar que no hay nadie
si el servidor lleva en pie mas que el plazo de presencia, porque esa señal vive en memoria y un
reinicio la pierde. Sin ese cerrojo, caducar seria matar las ordenes de un conductor vivo cada vez
que se reinicia pm2.

No hace falta migracion: `cancelled` ya estaba en el enum y el motivo cabe en `detail`, que es lo
que el panel ya mostraba debajo del estado. `acked_at` se queda en `null` a proposito —caducar no
es que le llegara a nadie— y los dos motivos son distintos segun el camino, porque no dicen lo
mismo. El conductor no cambia ni una linea: los dos artefactos se quedan en **1.6.0**.

Un efecto que conviene saber: un `start` encolado **mientras** el conductor conduce otra cosa se
queda `pending` —el bucle solo atiende `stop`, `pause` y `resume` con el agente en marcha—, asi que
si esa corrida dura mas del plazo, la orden caduca en vez de arrancar sola al terminar. Es lo que
se queria: arrancar horas despues de que alguien lo pidiera es exactamente la sorpresa que la
caducidad evita.

De paso, la pestaña Conductor **se refresca sola** cada diez segundos, el mismo intervalo que
sondea el conductor: mirar mas seguido no adelantaria nada, porque el buzon no se mueve entre
sus preguntas. Solo corre con esa pestaña delante y la ventana visible, el boton Actualizar
sigue estando, y el refresco automatico no enciende el indicador de carga —quien esta mirando
no pidio nada—.

## Abierto

**El camino de Cloudflare no se ha visto devolver un vector.** El `CLOUDFLARE_API_TOKEN` del `.env`
es valido y esta activo (`/user/tokens/verify` responde 200) pero no alcanza ninguna cuenta
—`/accounts` devuelve la lista vacia—, asi que cada embedding responde `401 Authentication error`.
Falta un token con permiso **Workers AI: Read** sobre `8816b3e0…`; con el, queda por confirmar de
primera mano la forma de la respuesta del punto compatible con OpenAI —vector en
`data[0].embedding` y `usage` con tokens—, que es lo unico que se dio por bueno leyendo la
documentacion. Si ese punto contestara con el sobre nativo de Workers AI, el lector ya acepta
`result.data[0]` y no haria falta tocar nada.

**Detener y Pausar son el mismo boton, y hay que unificarlos en Pausar.** Contra un conductor
en `--daemon` las dos ordenes hacen exactamente lo mismo: cortan el arbol del agente, terminan
esa corrida y devuelven el conductor a la espera. No es un defecto del corte —el codigo lo dice
a proposito, «en espera, una parada no termina el proceso: termina esa corrida», que es lo que
hace que pausar y volver a arrancar sean una sola sesion—. Y no es solo cosa del daemon:
**`stop` y `pause` aparecen UNA sola vez en `apts-loop.js`, juntos en la misma condicion**
(`if (!['stop', 'pause'].includes(orden.command)) return;`), asi que no hay ni una linea que
los distinga en ningun modo. Lo unico observable que cambia entre uno y otro es la etiqueta del
motivo que va al diario (`orden:stop` frente a `orden:pause`). El problema, entonces, es lo que
el panel promete: dos botones que hacen lo mismo. Se vio pulsandolos los dos contra PROD el
2026-08-08.

Decidido el 2026-08-08: **se unifica en Pausar**, no al reves. El panel encola ordenes para un
conductor que no arranca el —lo arranca una persona en la maquina donde vive el `--agent-cmd`—,
asi que un boton que apagara el proceso dejaria el buzon sin nadie al otro lado y sin forma de
volver a levantarlo desde el panel: justo lo que la señal de vida vino a hacer visible. Queda
por decidir que pasa con `stop` en el enum de `conductor_orders` y en `CONDUCTOR_COMMANDS`, que
es superficie ya publicada.

**Editar `workflow_steps` sigue fuera de alcance**, declarado. Las instrucciones paso a paso
del metodo se editan sembrando el corpus, no desde el panel.

En el repositorio no queda nada mas. Produccion corre lo mismo que `origin/main`, con las 23
migraciones aplicadas y el frontend recompilado el 2026-08-08.

**El `.env` de PROD no necesita ninguna clave nueva.** Tiene diez y ninguna de las que llegaron
despues es obligatoria: `EMBEDDING_DEFAULT_MODEL` no hace falta porque
`OPENROUTER_DEFAULT_EMBEDDING_MODEL` se sigue leyendo detras y ya vale
`openai/text-embedding-3-small`; `METHOD_CLAIM_TTL_MS` (1 h) y `METHOD_MAX_STEP_REVISITS` (3) traen
valor por defecto; `PUBLIC_APP_URL` cae en `CORS_ORIGIN`, que apunta al sitio bueno; y las tres
`CLOUDFLARE_*` solo hacen falta el dia que el modelo por defecto pase a ser un `@cf/...`.

