# Estado de la integracion

Describe **como esta hoy** la superficie de integracion y **que sigue abierto**. No cuenta como se
llego hasta aqui: eso esta en el historial de git.

## Superficie

| | |
|---|---|
| Superficie de integracion | El endpoint MCP remoto, `POST /mcp` (Streamable HTTP, sin sesion) |
| Operaciones | 23, derivadas de `apts_skills.json` |
| Registro | Una URL y cuatro cabeceras; el manifiesto publica el bloque por runtime |
| Manifiesto | `GET /api/public/integrar`, `schema_version` 1.1.3 |
| Guia para personas | `GET /api/public/integrar/guia`, HTML renderizado del manifiesto |
| Runtimes soportados | Dos: Claude Code y opencode |
| Artefactos publicados | 8; el conductor en `artifact_version` 1.9.0 y su README en 1.10.0, `adapter_generator` en 1.3.0, `loop_prompt_code_review` en 1.2.0, `agent_guidelines` y `surface_spec` en 1.1.1, `skill_markdown` y `skills_json` en 1.1.0 |
| Descargas necesarias para **llamar** a las operaciones | Ninguna |
| Descargas necesarias para **conducir** | El spec y el generador (agentes y comandos); el conductor y su README si se quiere el bucle desatendido, y su plantilla de revision si se quiere ademas la compuerta dentro de la sesion del agente |

**Identidad.** Viaja en las cabeceras del registro. El servidor no mira el sistema de archivos, el
entorno ni el Git del cliente. Un valor enviado en los argumentos gana a la cabecera —asi conmuta de
rol un agente— y un `project_url` que contradiga la cabecera se rechaza.

**Conduccion del metodo.** El manifiesto publica `method_conduction`, hermano de `mcp_endpoint`, con
seis reglas: `bootstrap_rule`, `identity_switching_rule`, `drive_loop`, `generative_step_rule`,
`dev_story_completion_rule` y `loop_conductor_rule`. Es la fuente autoritativa; los agentes generados
apuntan a el.

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
instrucciones, los permisos, los cuatro agentes y los cinco comandos —y, en opencode, el plugin que
carga el `.env`—.

**El conductor del bucle ya se publica.** `integracion/conductor/apts-loop.js` existia desde el
2026-08-06 y no aparecia en ninguna parte del manifiesto: ni como artefacto ni nombrado en una
cadena. Un cliente que arrancaba desde la URL no podia saber que existia. Ahora son dos artefactos,
`loop_conductor` y `loop_conductor_readme`, y van juntos a proposito: `--agent-cmd` es obligatorio y
su forma depende del runtime, asi que el script sin su manual no se puede usar. El script es
autocontenido —CommonJS, solo builtins de Node— asi que descargar ese unico archivo basta.

**Y el manifiesto ya dice como usarlo, y que la configuracion se pregunta.** Publicarlo no basto.
Un cliente real de opencode lo pidio el 2026-08-15 sobre el proyecto "tickets" y respondio que no
existe ningun conductor: el conductor solo se nombraba en la ficha de sus dos artefactos y en un
paso recomendado, y un cliente que mira `bootstrap.agent_runtime_adapters` —que es lo que el propio
manifiesto le manda instalar— no pasa por ahi. Descubrirlo dependia de leer la lista entera de
artefactos.

Ahora hay una sexta regla en `method_conduction`, `loop_conductor_rule`, y dice tres cosas que el
cliente no puede deducir: que se bajan los DOS artefactos (el manual no es opcional, porque
`--agent-cmd` es obligatorio y su forma es del runtime), que las precondiciones se comprueban antes
de molestar a nadie (iniciativa en `implementation`, rol dev en el roster, epica con hijos), y sobre
todo que **la configuracion no se elige: se pregunta al operador**. Runtime, modelo y escalera son
del proyecto y de la maquina, y el servidor no ve ninguno de los dos.

Va en `method_conduction` y no en un bloque nuevo por una propiedad que ya existia:
`METHOD_CONDUCTION_FIELDS` se deriva de `Object.keys`, asi que un campo nuevo hereda gratis el
override por proyecto (`PUT /api/dashboard/projects/:url/method-conduction`). Preguntar es el
defecto; un proyecto que ya tiene decidido su runtime y su modelo los sirve ahi y no se pregunta
nada. Esa es exactamente la forma del problema —opencode con un LLM en un repositorio, Claude con
Opus 5 en otro— y no hizo falta mecanismo nuevo.

Las lineas `--agent-cmd` se publican ademas como DATO, en
`registration_by_runtime.<runtime>.loop_agent_cmd`, al lado del registro MCP del mismo runtime
porque son la misma clase de cosa: lo que cambia de un programa cliente a otro. Asi el agente puede
ofrecer las opciones antes de descargar nada. La fuente unica es
`backend/scripts/lib/loop_conductor_invocations.js` —vive en `scripts/lib/` para poder comprobarse
sin levantar el servidor, como `contract_check.mjs`— y el README del conductor conserva su copia
porque tiene que leerse suelto. Esa copia es lo que ata el **segundo auto-chequeo del arranque**:
comprueba que cada linea publicada aparece literalmente en el README y aborta con `exit 3` si se
separan. Vuelve a haber dos, y este existe por la misma razon que el que se retiro con VS Code: una
segunda copia del mismo texto que nadie vigila se separa en silencio.

La guia HTML dejo de tener la suya. Renderizaba a mano la linea de Claude Code —una tercera copia,
justo lo que su cabecera prohibe— y ahora saca de `loop_agent_cmd` una tabla por runtime, con la
variante de Windows y la escalera de ejemplo de cada uno.

Queda una tercera copia con motivo, la del README del repositorio, para quien clona APTS. Esa NO
entra en el auto-chequeo del arranque —no se sirve a ningun cliente, y negarse a arrancar por una
doc interna seria un radio equivocado— sino en el test, y al atarla salio un hueco que llevaba ahi
desde el principio: el README raiz nunca habia dicho la escalera de opencode, la unica que lleva
`proveedor/modelo`.

De paso, la variante de Windows gana `--permission-mode acceptEdits`, que le faltaba: copiada tal
cual, la CLI pedia permiso y una corrida desatendida se plantaba esperando a nadie. El README sube a
`artifact_version` **1.8.0** (solo texto; el conductor se queda en 1.7.1) y `schema_version` a
**1.1.3**, por las dos claves nuevas —misma regla que 1.1.1 y 1.1.2—.

El coste esta medido, porque el manifiesto lo lee todo cliente en el arranque: **+3.389 caracteres**
(2.944 la regla, 445 los dos bloques de invocacion) sobre 39.307, un **8,6%**. Es el precio de que
el bucle deje de ser descubrible solo por casualidad.

En PROD desde el 2026-08-15 (`dee0746`), comprobado contra `apts.informaticos.ar`.

**Un agente que ni falla ni termina ya no deja el ciclo plantado.** Todos los frenos del
conductor median ENTRE vueltas —`--max-stalls` compara el estado del motor de una vuelta con
el de la anterior, y para eso la vuelta tiene que terminar—, asi que dentro de una vuelta no
habia nada. Lo encontro un cliente de opencode el 2026-08-15 en el proyecto "tickets": el
agente implemento la story entera (dos suites verdes, commit hecho), lanzo las tres capas de
la revision adversaria en subagentes paralelos y se quedo esperando un retorno que no llego.
Veinticinco minutos despues las tres seguian mudas, el proceso gastaba cuatro segundos de CPU
y los latidos del conductor seguian frescos sosteniendo el claim. Solo se salio matando a
mano, dos veces, con dos variantes de modelo distintas.

Ahora `--agent-silence` corta el arbol del agente que pasa N minutos **sin escribir una sola
linea**. Se mide el silencio y no la duracion: una story legitima puede tardar cuarenta
minutos, asi que un tope duro de duracion mataria corridas sanas sin distinguir nada, pero las
dos CLIs publicadas emiten NDJSON mientras trabajan, de modo que una sesion viva habla mucho
antes de veinte minutos. Cuenta cualquier byte por cualquiera de los dos flujos, que es lo que
hace que la señal no dependa de que la CLI escriba por el que esperabamos.

Cortado asi, el intento cuenta como fallido y **gasta la escalera**, al reves que los codigos
21 a 23: alli reintentar no puede salir distinto —el limite de uso es de la cuenta, el binario
que no existe sigue sin existir— y aqui si. Si el ultimo intento tambien queda mudo se para
con codigo propio, **24** (`agente_mudo`), y no con el 20, que manda a buscar el problema en la
story. Y un intento cortado por mudo no se somete a los patrones del entorno: su cola es la de
hace veinte minutos, y sin esa guarda un agente colgado justo despues de imprimir un mensaje
de limite de uso pararia la corrida con el motivo de al lado.

Va **PUESTO por defecto**, 20 minutos, unico freno que se estrena encendido. La asimetria
decide, como con `--session-stream` pero al reves: olvidarse de encenderlo cuesta la corrida
desatendida entera —que es el caso que esto viene a cerrar— y olvidarse de apagarlo cuesta,
como mucho, un intento cortado que la escalera vuelve a lanzar. `--agent-silence 0` lo apaga.

**Y la revision adversaria deja de exigir paralelismo.** Lo innegociable siempre fue el
contexto limpio de cada capa —el hilo que acaba de escribir el codigo no puede hacerse el
ciego— y no que las tres fueran a la vez: son independientes por construccion, ninguna lee lo
que encontro otra, y el paralelismo solo compraba tiempo de reloj. La plantilla
(`loop_prompt_code_review` 1.2.0) pide la tanda paralela **si el runtime la sostiene**,
recomienda la fila para opencode nombrando lo que se vio, y cierra la unica salida falsa que
quedaba: revisar en el hilo principal no cuenta, y sin subagentes se declara `HALT`.

**Tres cosas mas de la misma corrida, y las tres eran defectos de APTS.** La linea de opencode
que publica el manifiesto, `opencode run --format json -m {model} -f {prompt_file} "Implementa
la unidad…"`, **no funciona**: `-f/--file` es un flag de tipo array y se traga el positional
que venga detras, asi que la CLI muere con «Error: File not found: Implementa la unidad
descrita en el archivo adjunto» antes de resolver el modelo y el conductor lo anota como
`agente_fallo` (exit 20). Reproducido aqui contra opencode 1.18.18. El mensaje pasa a ir ANTES
de `-f`, y de paso la linea gana `--auto`, que es el hermano de `--permission-mode
acceptEdits` y le faltaba por el mismo motivo por el que le faltaba a la variante de Windows:
sin el, `opencode run` en headless auto-rechaza los permisos que su config deja en `ask` y la
sesion muere en el primer comando de shell. Una linea publicada para una corrida DESATENDIDA
que se planta esperando una aprobacion que nadie va a dar no sirve de nada. El auto-chequeo del
arranque ya ataba las tres copias, asi que las tres se movieron juntas; el test gana ademas una
comprobacion de que el mensaje va delante de `-f`, que es lo que ninguna copia podia detectar
por si sola.

Y un `.env` con **BOM UTF-8** ya se lee. `process.loadEnvFile` no lo ignora —medido en Node
24.11.1—, asi que la primera clave del archivo pasa a llamarse `﻿APTS_API_KEY` y el
conductor abortaba con «falta configuracion: --api-key / APTS_API_KEY» teniendo la clave
delante, escrita bien, en el archivo que acababa de leer. Lo escriben el Bloc de notas y el
`Set-Content` de PowerShell sin avisar, y el plugin de opencode si lo toleraba, asi que la
misma copia del archivo funcionaba para media corrida y no para la otra media. Se resuelve
copiando el archivo sin BOM a un temporal de solo-dueño y cargando ESE, en vez de parsear a
mano: el formato tiene comillas, escapes y valores multilinea, y una segunda implementacion se
separaria de la de Node en el primer caso raro.

De ese mismo caso sale una mejora que no depende de ninguna CLI: la parada con codigo 20 se
lleva ahora la **ultima linea en prosa** que escribio el agente. Cuando el fallo no encaja en
ninguna condicion reconocida, eso es lo unico que separa «el agente fallo» de la causa, y se
quedaba en la consola de la maquina que lanzo el bucle sin llegar al diario ni al aviso —el
operador tuvo que leerla a mano para descubrir lo del `-f`—. Se saltan las lineas JSON a
proposito: con `stream-json` la ultima es siempre el objeto `result`, que ya se lee por otro
camino, asi que lo que queda es el stderr, que es donde una CLI escribe sus errores fatales.

Descartado, en cambio, validar la linea de `--agent-cmd` al arrancar, que era lo que pedia el
informe: el conductor trata ese comando como opaco a proposito —«no sabe que hay al otro
lado»— y meterle conocimiento de la sintaxis de yargs de opencode lo convertiria en algo que
hay que actualizar cada vez que una CLI cambie sus banderas. La linea publicada arreglada, el
auto-chequeo que ata sus tres copias y la ultima linea en prosa cubren el caso sin eso.

El eco del agente pasa a escribir el TEXTO decodificado y no el Buffer. Antes era byte a byte y
eso partia caracteres en la frontera de trozo —un acento cuyos dos bytes caen en lecturas
distintas llegaba como dos escrituras rotas—, con un decodificador por flujo porque compartirlo
mezclaria los bytes a medias de uno con los del otro. Lo que **no** arregla, y se dice: un
terminal con la pagina de codigos en OEM sigue enseñando mal el resto, y eso no se puede
arreglar desde dentro del conductor (`chcp 65001`).

Cubierto ampliando `test_conductor_agent_env.js`, que ya levantaba un APTS de mentira y lanzaba
el conductor de verdad: 32 comprobaciones, y las que importan son que el agente mudo sale con
24 y no con 20, que se le corta el arbol **de verdad** —el falso agente no llega a despertar—,
que `--agent-silence 0` deja de vigilar, y que el BOM ya no esconde la primera clave.

En PROD desde el 2026-08-15 (`d7498ba`), sin migraciones, comprobado contra
`apts.informaticos.ar`: el manifiesto sirve los tres artefactos en 1.9.0, 1.10.0 y 1.2.0 con la
linea de opencode corregida dentro de `registration_by_runtime`, y las descargas de
`apts-loop.js?v=1.9.0` y `README.md?v=1.10.0` coinciden byte a byte con el repositorio
—normalizando CRLF a LF, que es lo que checkoutea el servidor—.

**La sesion del agente ya se ve mientras pasa, y se puede consultar despues.** De una
ejecucion de media hora APTS guardaba lo que se puede medir DESDE FUERA —modelo, intento,
duracion, codigo de salida y, desde la lectura del JSON de la CLI, lo que costo—. El detalle
de lo que el agente hizo vivia solo en el terminal de la maquina que lanzo el bucle y
desaparecia al cerrarlo. Ahora `--session-stream` lo copia a APTS y el panel lo enseña en
vivo.

El obstaculo no estaba a la vista: `--output-format json`, que es lo que pedian los comandos
publicados, imprime **un solo objeto al terminar**. Sirve para la contabilidad y es inutil
para cualquier cosa en vivo. Las tres copias atadas por el auto-chequeo pasan a
`--output-format stream-json --verbose`, y eso ademas apaga un coste que el README ya
documentaba como pagado: la consola dejaba de escribir durante veinte minutos. **El lector
de coste no se toco**, y no por suerte: la ultima linea de `stream-json` sigue siendo el
mismo objeto `type:"result"`, comprobado contra la salida capturada de la CLI real, y
`LECTORES[0]` exige `type === 'result'`, asi que los `assistant` intermedios —que tambien
llevan `usage`— no lo confunden. Opencode no cambia: su `--format json` ya era NDJSON.

**Tabla nueva y no `agent_logs`** (migracion 025, `conductor_agent_events`). Reusar
`agent_logs` fue la decision razonada del diario del conductor y sigue siendo la correcta
alli, pero aqui se rompe por tres sitios: son dos registros distintos —`agent_logs` es el
del METODO, lo que un agente reporto; esto es el de la EJECUCION, lo que paso dentro de un
proceso—, el volumen es de dos a tres ordenes de magnitud mayor —unas 400 filas por story
contra las 5 o 6 del diario, que ahogarian la pestaña Logs y su filtro por `action_type`—, y
sobre todo la purga: separarlas es lo unico que permite tirar el registro de la ejecucion sin
tocar el del metodo. La FK va a `tasks` y no a `backlog_items` porque la tarea ES la
ejecucion (una por unidad y por pasada), con `ON DELETE CASCADE`. El `seq` lo pone el
conductor y no el servidor: es lo que hace que el cursor del panel no dependa de relojes
—`created_at` empata entre los veinticinco eventos de un mismo lote— y lo que hace el lote
idempotente contra `UNIQUE (task_id, seq)`, que es lo que permite que el envio sea
best-effort sin arriesgarse a duplicar una sesion. Puede tener HUECOS a proposito, y quien lo
lea no puede suponer que sea denso.

**El filtrado vive en el conductor**, no en el servidor: mandar el stream crudo seria pagar
el ancho de banda y el parseo de lo que se va a tirar. La mitad del ahorro es una sola
estructura: cada `tool_result` viaja **dos veces** en el stream de Claude Code —en
`message.content[]` y otra vez entero en `tool_use_result`, con la ruta absoluta y el archivo
completo dentro—, y esa segunda copia es la unica que crece con el tamaño del repositorio en
vez de con lo que el agente hizo. No viaja. Del `init` sobrevive lo que cambia por corrida y
no las listas de herramientas y comandos, que son estaticas. Un tipo de evento que ningun
lector reconozca **se conserva** reducido, que es la unica forma de enterarse de que una CLI
cambio su salida sin sospecharlo antes. De opencode solo se normaliza lo que hay capturado
—`text` y `step_finish`—: sus eventos de herramienta caen en ese cubo en vez de inventarles
una forma que nadie ha visto.

**Y va APAGADO por defecto**, unica excepcion a la convencion del repositorio. Esa convencion
—«una ejecucion sin rastro es el problema, no una preferencia neutral»— cubre el registro de
las DECISIONES, que ya existe y sigue puesto. Esto añade el CONTENIDO de la sesion: trozos de
archivos, rutas absolutas de la maquina y lo que a un mensaje de error se le ocurra traer.
La asimetria decide: olvidarse de encenderlo cuesta la vista de una corrida, y olvidarse de
apagarlo mete el codigo de un cliente en la base de APTS, que no se despersiste. Hay
redaccion por patrones (`sk-…`, `ghp_…`, `AKIA…`, `Bearer`, claves privadas, JWT y
asignaciones tipo `password=`) y se documenta como lo que es: **segunda** linea, porque un
patron no reconoce el secreto que no conoce. La frase del README del conductor —«el diario no
contiene secretos»— **no se corrige porque sigue siendo cierta**: el contenido de la sesion no
pasa por el diario local, que solo anota cuantos eventos se mandaron. Se dice explicitamente
para que nadie arrastre esa promesa al sitio equivocado.

**Sondeo con cursor y no SSE.** El README del conductor argumenta que para las ORDENES diez
segundos son indistinguibles de instantaneo, y ese argumento no aplica aqui: ver a un agente
trabajar si quiere latencia baja, asi que el panel pregunta cada dos segundos con
`?after_seq=` y solo mientras mira la ejecucion en curso. Lo que no compra un socket es el
salto que queda —de dos segundos a instantaneo no lo nota nadie mirando pensar a un modelo— a
cambio de conexion, reconexion, autenticacion por sesion y un intermediario que puede
bufferear un flujo que nunca cierra.

**El envio es best-effort con una diferencia respecto al diario.** Agrupa (25 eventos o 1,5 s,
una peticion en vuelo, cola con tope que tira lo mas viejo y lo dice), no reintenta y se traga
los errores; pero **si mira el codigo de respuesta**, y solo para el cortacircuitos: el
conductor es un artefacto descargable que va a hablar con APTS anteriores a esta ruta, y sin
el se comeria un 404 cada segundo y medio durante media hora. A los dos 404 deja de intentarlo
**durante toda la corrida** —cuenta de la corrida y no de la unidad, para no pagar el
descubrimiento una vez por story— y lo dice una vez.

**Cuantas filas, que las purga, y que pasa si no.** Unas 400 por story y unas 8.000 por una
corrida de veinte, con unos 12 MB. Sin purga la respuesta honesta a «que las borra» seria
«nada»: el `ON DELETE CASCADE` solo se dispara al borrar una tarea, y APTS no borra tareas por
ningun camino. Asi que se purga por antiguedad de forma perezosa desde la propia ingesta, como
mucho una vez por hora —el mismo patron de poda que ya usa la presencia del conductor, sin
cron ni proceso nuevo—: `CONDUCTOR_SESSION_RETENTION_DAYS`, 30 por defecto, `0` la desactiva.
Si no se purgara, el panel no se enteraria (todas sus consultas van por el indice) y lo
pagarian el disco y la copia de la base que el despliegue hace antes de migrar.

**El contrato no se toca**, y se comprobo en vez de suponerlo: `contract_check.mjs` compara la
lista de herramientas MCP contra `apts_skills.json` y nada mas, y las rutas HTTP del conductor
—diario, buzon y ahora sesion— estan fuera a proposito por la misma razon que las otras dos:
no son del metodo y no las llama un agente. `schema_version` tampoco sube: cambia el VALOR de
`loop_agent_cmd`, no aparece ninguna clave nueva, que es la regla con la que subieron 1.1.1,
1.1.2 y 1.1.3. Los dos artefactos si suben: el conductor a **1.8.0** y su README a **1.9.0**.

Cubierto por dos pruebas, una por lado. `test_conductor_session_stream.js` levanta un APTS de
mentira en puerto efimero y lanza el conductor de verdad con la salida **capturada** de Claude
Code 2.1.233: 50 comprobaciones, y las que mas importan son que la contabilidad del coste sale
identica con `stream-json` (la unica regresion que esto podia causar en algo que ya
funcionaba), que `tool_use_result` no llega nunca, y que sin la bandera no se manda ni una
peticion. `test_conductor_session_endpoint.js` prueba las dos rutas contra servidor y base de
verdad: idempotencia del `seq`, que el cursor ni relee ni se salta, y que el proyecto es
frontera —sabiendo el UUID de una tarea de otro proyecto, la ruta del panel no la sirve—.

Las dos encontraron fallos reales antes de que llegaran a ninguna parte. El que mas importa
era ironico: la guarda que apagaba el envio al tocar el tope por unidad tambien impedia
entregar el evento `recorte` que anuncia ese tope, o sea que el mecanismo puesto para que el
truncado no fuera silencioso lo volvia silencioso. Son dos estados y no uno: dejar de ACEPTAR
eventos y dejar de MANDARLOS.

En PROD desde el 2026-08-15 (`3dcb797`), comprobado contra `apts.informaticos.ar`: el
manifiesto sirve los dos artefactos del conductor en 1.8.0 y 1.9.0 con las lineas
`stream-json` dentro de `registration_by_runtime`, la descarga de `apts-loop.js?v=1.8.0`
coincide byte a byte con el repositorio —normalizando CRLF a LF, que es lo que checkoutea el
servidor—, `POST /api/conductor/session` responde 401 en vez de 404, y la tabla esta creada
con su FK en cascada y su UNIQUE. Con migracion, asi que hubo copia previa.

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

**La epica ya no se puede quedar vacia, y si lo esta, se dice y se repara.** Un cliente real lo
encontro el 2026-08-14 (proyecto "tickets"): 21 items en el backlog, `backlog: {total: 0}` para el
motor, y el ciclo respondiendo `wait: sin unidades de trabajo libres` una vuelta tras otra. Tres
defectos encadenados, y ninguno de los tres era el que parecia.

El primero es la causa. La completitud de `bmad-create-epics-and-stories` es `artifact-exists` del
doc `epics`, y las historias eran un `extra` sin marca —"se captura si viene y se ignora si no"—:
un submit con el documento y sin `out.stories` cerraba la planificacion con la epica vacia. El
segundo es que ese estado no tiene salida: `implementation` no cierra nunca porque
`all-children-status` con cero hijos es false a proposito, y `claimDevStory` no reparte de un
conjunto vacio. El tercero es que ese callejon se anunciaba con el MISMO `wait` que el compas de
espera legitimo —todas las historias reclamadas por otro agente—, asi que ni el agente ni el
conductor podian distinguir esperar de estar plantado.

Ahora el `extra` es `required_for_close`, como la revision adversaria. La compuerta se comprueba
contra el ESTADO y no contra la forma del payload: rechaza solo si, tras el submit, la epica seguiria
sin un solo hijo, de modo que un re-submit legitimo no rebota. Y `apts_next` distingue las dos
causas: epica sin hijos es `blocked` —no `wait`—, y el `why` cuenta cuantos items sueltos hay en el
backlog del proyecto y nombra la herramienta que los adopta.

Esa herramienta es la operacion 23, `adopt_backlog_items`, y existe porque no habia ninguna. Las dos
vias de alta del backlog estaban fracturadas: `create_backlog_item` no acepta jerarquia —su esquema
no tiene `epic_id` ni `initiative_id`— y el motor solo liga las historias que crea el en el submit.
Un proyecto podia entonces tener el backlog lleno y la epica vacia, y salir de ahi exigia un `UPDATE`
a mano en la base. La operacion adopta en la epica de la iniciativa activa los items que no estan en
ninguna; sin `backlog_item_ids` barre todos los huerfanos (los bugs fuera, salvo `include_bugs`), y
con la lista manda el ORDEN de la lista, porque el `sort_order` no se hereda: los huerfanos comparten
prioridad y orden por defecto, y adoptarlos tal cual dejaria el reparto en el desempate por UUID, que
es el fallo que ya se pago en produccion el 2026-08-08.

Y la captura tambien adopta: si una historia de `out.stories` coincide por titulo con un item suelto
del proyecto, se liga ese en vez de crear otro. La deduplicacion miraba solo `initiative_id = esta
iniciativa`, y los huerfanos lo tienen nulo, asi que re-generar el plan clonaba el backlog entero y
dejaba dos copias de cada historia: una visible para el motor y otra no.

El wiring per-step se deriva de `WORKFLOW_OUTPUTS` al sembrar, y las librerias ya sembradas no
vuelven a pasar por el seed, asi que el descriptor nuevo lo escribe la migracion 024 —hardcodeado,
como la 018—. `schema_version` no cambia: no hay clave nueva en el manifiesto, solo prosa nueva en
`method_conduction` (el `generative_step_rule` ya avisaba de este fallo; ahora ademas el motor lo
impide, y el `drive_loop` dice que un `blocked` que nombra su reparacion se repara y se sigue).

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
vigilancia de latidos diciendo «perdi contacto» y el agente diciendo «esto no se puede todavia»).

**El estado del proyecto ya no es un flag: se deriva del backlog en cada lectura.**
`projects.status` tenia un escritor —`report_blocker`, que marcaba el proyecto ENTERO por una sola
unidad— y un limpiador —`/api/tasks/:id/resolve`, o sea una persona pulsando un boton—. Nada lo
apagaba solo: ni cerrar la story, ni pasar la unidad a `done`, ni avanzar de fase. fm-synth se
quedo en rojo desde el 2026-08-08 y cerro diez stories con el flag puesto, sin una sola tarea ni
unidad bloqueada. Un limpiador nuevo no lo habria arreglado, solo movido: habria que recalcular
desde cada sitio que mueve un `backlog_item` —submit del motor, `update_backlog_item`,
`report_blocker`, vigilancia de latidos, resolve— y el que se olvide reintroduce el mismo defecto.

Ahora se calcula al servirlo, en `deriveProjectStatuses`, con los cuatro valores que el enum ya
tenia: `blocked` si queda alguna unidad viva en `blocked`, `active` si queda alguna no terminal,
`completed` si las hay y todas son `done`/`archived`, y `pending` si no hay ninguna. La columna
sigue en la tabla y ya no se escribe ni se lee. Cambio de radio: derivarlo tambien apago dos
mentiras de al lado —un proyecto que nunca se bloqueo nunca habia estado `active`, porque el
default es `pending` y solo el boton escribia `active`, asi que la columna mostraba `pending` en
proyectos que llevaban meses trabajando— y arreglo el contador del panel, que contaba como activo
«todo lo que no esta bloqueado».

La señal es `backlog_items.status = 'blocked'` y **no** `tasks.status = 'stalled'`, que es la otra
candidata obvia. `stalled` tampoco tiene limpiador —lo escriben `report_blocker` y la vigilancia de
latidos, y solo el boton lo deshace—, asi que usarlo reproduciria este mismo defecto un nivel mas
abajo: fm-synth arrastra seis tareas `stalled` que son residuo de paradas del conductor y daria un
proyecto bloqueado para siempre. El estado del backlog si se limpia por caminos normales. Queda
pendiente, y es el mismo defecto en otra columna: `tasks.status = 'stalled'` sigue siendo pegajoso
y sigue inflando el contador de agentes estancados.

**Y desatascar una tarea ya no puede reabrir trabajo terminado.** El boton «Resolver» del panel
salia por el estado del PROYECTO ademas del de la tarea (`task.status === 'stalled' ||
isProjectBlocked(...)`), o sea en todas las tareas de un proyecto marcado, sanas incluidas; y el
handler reponia a `ready` la unidad que la tarea poseyera, sin mirar en que estado estaba. En
fm-synth eso habria devuelto al reparto «Las 32 topologias», ya `done`, porque su tarea seguia
poseyendola. Son dos fallos distintos y llevan dos guardas distintas:

- la ruta responde **409** si la tarea no esta `stalled` —resolver es una operacion de desatasco y
  sobre una tarea sana devolverla a `todo` le destruye el estado; mismo trato que el precedente de
  al lado, `/api/method/pointers/:agent/release`, ante un puntero que no sostiene nada—;
- y la reposicion de la unidad se acota a las **no terminales**, que es la guarda que muerde en el
  caso real: la tarea se desatasca igual y la story cerrada no vuelve.

La guarda vive en el servidor y no en el panel porque el panel no puede ponerla: `/api/dashboard/overview`
sirve las tareas sin ningun dato del backlog, asi que no sabe que unidad posee cada una. Del lado
del cliente solo se retira la disyuncion, que dejaba el radio del boton en el proyecto en vez de en
la tarea.

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

**De esas dos correcciones, en el borde solo llega una.** Comprobado el 2026-08-08 contra
produccion: el origen si manda `no-cache` —se ve en `README.md` y en `skills.json`, los dos con
`cf-cache-status: DYNAMIC`— pero Cloudflare lo **reescribe** para el `.js`, que vuelve con
`max-age=14400` y `cf-cache-status: REVALIDATED`. La directiva no alcanza justamente al unico
artefacto por el que se puso. Lo que sostiene la entrega es la otra mitad: la descarga de
`?v=1.6.0` coincidio byte a byte con el archivo del repo. La consecuencia practica es que subir
`artifact_version` deja de ser cortesia y pasa a ser la unica defensa —editar `apts-loop.js` sin
bumpear puede dejar al borde sirviendo los bytes viejos cuatro horas—, y que la promesa de
`no-cache` no se puede dar por buena leyendo el codigo del origen: hay que medirla desde fuera.

**El conductor ya distingue que el agente falle de que no llegue a trabajar.** Un intento
fallido puede serlo por la story —para eso esta la escalera de modelos— o porque su CLI no
arranco. El limite de uso es el caso que lo motivo, y es del segundo tipo: es de la CUENTA
y no del modelo, asi que una escalera `sonnet -> opus` gastaba el segundo intento en cero
segundos y dejaba escrito `agente_fallo`, que manda a buscar el problema en la story. Paro
dos corridas de fm-synth en dos dias —el 2026-08-08 a las 10:24 y el 09 de madrugada— y las
dos veces el diario dijo que habia fallado el agente cuando la CLI habia impreso la causa
exacta y hasta la hora a la que se restablecia.

Ahora hay tres condiciones del entorno con motivo y codigo propios —`limite_de_uso` (21),
`agente_no_ejecutable` (22) y `agente_sin_credenciales` (23)—, se para al primer intento sin
gastar el resto de la escalera, y la hora de reset viaja como campo `reset` del evento
`parada`: al diario, a la consola y al aviso de Telegram. Es lo unico accionable del mensaje
y estaba tirandose.

Se reconocen por la SALIDA del agente y no por su codigo, porque las tres terminan en 1
igual que un bug. Eso obligo a dejar de heredar la salida (`stdio: 'inherit'`): ahora el
conductor hace de eco —reescribe cada trozo tal cual, asi que en consola se ve lo mismo— y
se queda con los ultimos 4 KB. El efecto secundario, documentado: desde el punto de vista
del agente su salida ya no es un terminal, de modo que una CLI que coloree escribira texto
plano.

Dos cerrojos contra el falso positivo, porque los dos errores no cuestan igual —confundir
esto con `agente_fallo` gasta un reintento; confundir un fallo de la story con esto aborta
una corrida que podia seguir—: solo se mira cuando el intento ya fallo y solo contra la cola,
y el 22 y el 23 exigen ademas que el proceso muriera pronto (60 s, `APTS_LOOP_STARTUP_MAX_MS`),
porque un binario que no existe no tarda veinte minutos en no existir. El 21 no lleva ese
cerrojo a proposito: el limite llega justo cuando el agente lleva rato trabajando.

Cubierto por `backend/scripts/test_conductor_agent_env.js`, que levanta un APTS de mentira en
un puerto efimero y lanza el conductor de verdad contra el con un agente falso: 19
comprobaciones, y entre ellas la que mas importa es que el camino normal no cambio —un fallo
de verdad sigue gastando la escalera entera y saliendo con 20—. Los dos artefactos del
conductor suben a `artifact_version` **1.7.0**.

**El punto de entrada publico ya tiene una puerta para personas.** `/api/public/integrar` esta
escrito para agentes —JSON, en ingles, con la prosa en forma de reglas ejecutables— y era lo
unico que habia: quien llegaba por primera vez y queria conectar su repositorio no tenia por
donde entrar. El README del repo lo explica, pero exige clonar APTS, que es justo lo que un
cliente no hace.

`GET /api/public/integrar/guia` devuelve esa guia en HTML: los cuatro valores que hacen falta,
los tres pasos —registrar el endpoint, generar los adaptadores, comprobar que responde—, como
se conduce el metodo y como se lanza el bucle, mas la referencia de operaciones, artefactos y
sintomas. Autocontenida: el CSS va embebido y no pide nada a otro host, porque tiene que verse
igual sin red.

No es un artefacto y no tiene `artifact_version`: **no guarda contenido propio**. Se renderiza
en cada peticion desde el manifiesto y desde `apts_skills.json`, de modo que la URL del
endpoint, las cabeceras, los bloques de registro por runtime, las 23 operaciones, los
artefactos con su version y las cinco reglas de `method_conduction` salen de la misma fuente
que consume el agente. Lo unico escrito a mano es lo que esas dos fuentes no pueden llevar: en
que orden se hacen las cosas y por que. Una tercera copia de la superficie se separaria en
silencio, que es exactamente lo que costo retirar las cuatro plantillas de agente.

`schema_version` sube a **1.1.2** por `human_guide`, hermano de `entrypoint`: clave nueva que no
quita ni cambia la forma de nada, el mismo caso que 1.1.1. Se anuncia porque si no, no hay
forma de descubrirla. Cubierto por `backend/scripts/test_integration_guide.js`, que llama a la
funcion de render con un manifiesto de mentira: 25 comprobaciones, y las primeras son de
escapado, porque por la pagina pasa texto que no escribio la plantilla.

**El sondeo del buzon ya no ahoga el log.** El conductor en marcha pregunta por ordenes cada diez
segundos, y cada vuelta escribia una linea HTTP a nivel `info`: 8.640 al dia por conductor, todas
diciendo lo mismo. Mirar el log durante una implementacion no enseñaba nada del trabajo real —en
media hora de una corrida de fm-synth, 38 de cada 40 lineas eran el sondeo—, que es el modo exacto
en que un log deja de servir: no por perder informacion, por sepultarla. Ahora la ruta marca la
respuesta cuando vuelve sin orden (`res.locals.emptyConductorPoll`) y el middleware la deja en
`debug`. Se marca en la ruta y no por la URL en el middleware porque lo que separa el ruido de la
señal no es el camino sino si habia algo en el buzon: la **entrega** de una orden sigue en `info`,
que es la mitad que interesa mirar. No se pierde nada —con `LOG_LEVEL=debug` vuelve a verse
entero— y los 4xx y 5xx no se tocan, porque los niveles de error se resuelven antes.

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

**Una sola fuente por cosa.** Dos auto-chequeos corren al arrancar, antes de escuchar, y abortan con
`exit 3` si algo se ha separado: el contrato, contra `apts_skills.json`
(`backend/scripts/lib/contract_check.mjs`); y las lineas `--agent-cmd` que publica el manifiesto,
contra el README del conductor (`backend/scripts/lib/loop_conductor_invocations.js`).

Hubo antes otro segundo, retirado: comparaba las cuatro plantillas publicadas —cuerpo y cabecera—
contra `apts-surface.json`, y existia porque eran una segunda copia del mismo texto que ya se habia
separado del spec sin que nadie lo notara. Al retirarlas con VS Code desaparece la copia, y con la
copia el cerrojo: ahora el spec tiene un solo consumidor, el generador, y lo que este emite se
comprueba regenerando. El del conductor entra por la misma razon por la que existia aquel, y esta es
la regla: una copia se admite cuando tiene motivo —el manual tiene que poder leerse suelto— y
entonces se ata.

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
lista las 23 operaciones.

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

Contra `APTS_test` (puerto 47301; la ronda del coste de los embeddings en 47399 y la del estado
derivado del proyecto en 47421, porque 47301 ya estaba ocupado), con el estado de partida `initiatives:2`, `epics:2`, `backlog_items:361`,
`tasks:263` restaurado al terminar.

- Un cliente que **no descarga nada** conduce el ciclo BMAD completo a `phase=done`: 7 workflows
  generativos, 2 unidades `dev-story` de 10 pasos, 5 cambios de rol, 3 elicitaciones, 52 submits.
- `initialize` y `tools/list` responden con 23 operaciones.
- **La epica vacia, por sus cuatro caminos** (`scripts/test_empty_epic_guard.js`, en la base de
  prueba y dentro de una transaccion que se revierte). El submit del documento de epicas sin
  `out.stories` se rechaza nombrando `output.stories` y no deja nada detras —sin documento escrito y
  con la fase quieta en `planning`—; con historias, adopta por titulo los dos huerfanos que ya
  existian, crea solo la tercera, y la epica queda con tres hijos de `sort_order` distinto (el bug
  que nadie nombro se queda fuera). Una iniciativa en `implementation` con la epica vacia da
  `blocked` —no `wait`— contando los items sueltos y nombrando `adopt_backlog_items`; la adopcion
  respeta el orden de la lista de ids, es idempotente al repetirla, informa en `skipped` lo que ya
  estaba ligado, y despues de ella el motor entrega `run_step` sobre la primera del plan adoptado.
- **`adopt_backlog_items` por MCP**, contra el servidor de prueba: `tools/list` la trae con su
  esquema, la llamada sin iniciativa activa da 400 `INVALID_ARGUMENT` diciendo que se corra
  `create_initiative` primero, un id mal formado da 400 nombrandolo, y el camino feliz —alta de
  iniciativa, dos `create_backlog_item` sueltos, adopcion— devuelve los dos items ligados a la epica
  del alta, en `ready_for_dev` y con `sort_order` 1 y 2.
- **El sembrado y la migracion 024 coinciden**: tras `npm run seed:method:test`, el paso terminal de
  `bmad-create-epics-and-stories` conserva `backlog_items` con `required_for_close`.
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
- **La regla del conductor y su fuente unica** (`scripts/test_loop_conductor_invocations.js`, nuevo;
  no necesita servidor ni base). Doce comprobaciones: la constante publica los dos runtimes y solo
  ellos, cada comando lleva `{prompt_file}` y `{model}` —sin el segundo, la escalera publicada al
  lado seria una pareja que el propio conductor rechaza—, solo Claude Code declara variante de
  Windows y esa variante no usa `$(cat …)` y conserva el modo de permisos. El auto-chequeo encuentra
  las cinco lineas en el README de verdad; con un comando editado en el README y no en la constante
  aborta nombrando runtime y campo, y lo mismo con un solo caracter cambiado (`--model` contra
  `--modelo`), porque la comparacion es literal a proposito; un README ilegible sale por su propio
  codigo y no por el de separacion.
- **Y el aborto de verdad**: con el README mutilado a mano, el servidor no llega a escuchar —`FATAL
  Loop conductor self-check failed`, `LOOP_CONDUCTOR_DRIFT`, `exit 3`— y el archivo se restauro con
  el mismo hash. Con el README intacto arranca y deja `runtimes: 2, invocations: 5`.
- **Las dos claves nuevas del manifiesto, contra el servidor de prueba**: `schema_version` 1.1.3,
  `method_conduction` con sus seis campos, y `loop_agent_cmd` dentro de los dos bloques de registro.
  El override por proyecto funciona **sin infraestructura nueva**: un `PUT` de `loop_conductor_rule`
  se acepta, `/api/public/integrar?project_url=…` sirve el texto pisado, el manifiesto sin
  `project_url` sigue dando el defecto que manda preguntar, y un `null` lo borra.
- **La guia HTML no conserva copia propia de la invocacion**: con una CLI de mentira en el
  manifiesto, en la pagina salen las dos lineas falsas y no queda rastro de `claude -p` ni de
  `opencode run` (`scripts/test_integration_guide.js`, ampliado a 6 comprobaciones nuevas).
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
- **Las ordenes del buzon, con el agente real en marcha.** `resume` sin corrida previa se
  rechaza con `cancelled` y su motivo; `start` con payload arranca; `pause` a mitad corta el arbol
  —cinco niveles, con `claude.exe` dentro, todos muertos y ningun huerfano— y devuelve el conductor
  a la espera; `resume` sin payload retoma con la MISMA configuracion y el motor sirve la story
  siguiente; y un `resume` que llega mientras el agente corre queda `done` con «ya estaba
  corriendo», sin reiniciar nada.
- **La señal de vida del conductor**, con `backend/scripts/test_conductor_presence.js` (nuevo;
  necesita el servidor levantado, porque la presencia vive en la memoria de ESE proceso y no
  hay forma de mirarla sin el; crea su proyecto y lo borra). Treinta y dos comprobaciones en
  verde con `CONDUCTOR_PRESENCE_TTL_MS=3000`, que es lo que permite ver caducar una señal sin
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
- **La retirada de `stop`**, contra el servidor de prueba en 47399. El panel encola `stop` y
  recibe **400** nombrando los tres que valen —`start, pause, resume`— en vez de colarlo como un
  `pause` en silencio; con `pause` el buzon se comporta exactamente igual que antes, y las dos
  pruebas del buzon pasan enteras (32 y 20 comprobaciones) con las suyas reescritas a `pause`. La
  fila `stop` escrita directamente en la base, la unica que queda, se lee, se lista y caduca por
  los dos caminos. El manifiesto publica el conductor en 1.6.0 y su README en 1.6.1, cada uno con
  su URL versionada, y esa URL sirve el texto nuevo. El frontend compila y su chunk
  `ProjectDetails` ya no contiene «Detener» ni una sola vez.
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
- **El estado derivado del proyecto y las dos guardas del resolve**, con
  `backend/scripts/test_project_blocked_derivation.js` (nuevo; necesita el servidor levantado
  porque las tres lecturas y el resolve viven en rutas de panel; crea su proyecto y lo borra).
  Veintidos comprobaciones. La columna se deja a proposito diciendo una cosa mientras el panel dice
  otra, asi que si algo la leyera se veria: sin backlog sale `pending`, con unidades abiertas
  `active`, con una bloqueada `blocked`, y con todo terminal `completed`. La que importa es que
  **cerrada la unidad el proyecto deja de estar bloqueado SOLO** —y con su tarea todavia `stalled`,
  que es lo que separa la señal buena de la mala—. Las tres rutas de panel devuelven el mismo
  valor, y ni `report_blocker` ni el resolve escriben ya la columna. Del resolve: 409 sobre una
  tarea que no esta `stalled`, sin devolverla a `todo` por el camino; sobre la tarea `stalled` que
  posee una unidad ya `done` —el estado copiado de fm-synth— responde 200, la tarea queda en `todo`
  y **la unidad sigue `done`**; y sobre una unidad viva si repone a `ready`, que es el caso para el
  que la ruta existe. Comprobado ademas que la prueba no es vacua: con el codigo anterior caen
  siete, y una de ellas es el daño literal —la unidad terminada volviendo a `ready`—.
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
| Detener | el arbol muerto otra vez —y de ahi salio la unificacion: hacia lo mismo que Pausar. Ese boton ya no existe |

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

**Comprobado despues del undecimo despliegue del 2026-08-08** (`cf675c0`, **sin migraciones**:
`stop` sale de la lista de la API y el CHECK de la tabla se queda como estaba). Entraron cuatro
commits, la unificacion de Detener y Pausar y tres notas de ESTADO. El frontend se compilo en el
servidor —`dist.new` intercambiado, 16 ficheros— y se comprobo **contra contenido**: el chunk
`ProjectDetails` que sirve nginx (53.745 bytes) no contiene «Detener» **ni una sola vez**, trae el
parrafo nuevo («Apagar el proceso no se puede desde el panel») y ni una aparicion de `stop`.

**Y funcionalmente vivo, por la URL publica y con sesion de panel**: `stop` responde **400
diciendo «command must be one of: start, pause, resume»** —igual que un comando inventado— y los
tres que quedan responden 200 escribiendo su fila. Las tres filas de la comprobacion se borraron
al terminar, asi que `conductor_orders` vuelve a estar **vacia** en PROD, que es como estaba.

El manifiesto publico sale con `schema_version` 1.1.1 y 8 artefactos, con el conductor en **1.6.0**
y su README en **1.6.1**, cada uno en su URL versionada: el README sirve el texto de los tres
botones, y el script sigue siendo el mismo de siempre —75.567 bytes, con su linea
`['stop', 'pause']` intacta—, que es la prueba de que la retirada no lo toco. pm2 quedo `online`
con **un** reinicio (23 acumulados contra 22). Las seis comprobaciones del desplegador pasaron y el
aviso de `/mcp` no salio.

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

**Y ya no hay dos botones que hagan lo mismo.** Detener y Pausar eran la misma orden con dos
nombres: contra el conductor las dos cortaban el arbol del agente, terminaban esa corrida y lo
devolvian a la espera, y lo unico que cambiaba era la etiqueta del motivo en el diario
(`orden:stop` frente a `orden:pause`). No era un defecto del daemon: `stop` y `pause` aparecen
**una sola vez** en `apts-loop.js`, juntos en la misma condicion, y `ordenDeParada` solo se lee
despues para componer ese motivo. No habia ni una linea que los separase en ningun modo. Se vio
pulsando los dos contra PROD el 2026-08-08.

Se unifico en **Pausar** y no al reves. El panel no arranca conductores —los arranca una persona
en la maquina donde vive el `--agent-cmd`—, asi que un boton que apagara el proceso dejaria el
buzon sin nadie al otro lado y sin forma de volver a levantarlo desde el panel: justo lo que la
señal de vida vino a hacer visible. El texto de ayuda de la pestaña lo dice ahora, porque con un
solo boton de parada hay que decir que **no** apaga el conductor.

`CONDUCTOR_COMMANDS` pasa a tener **tres** valores. El CHECK de `conductor_orders.command`
conserva los cuatro **a proposito**: es suelo de la tabla y no contrato publicado —ningun cliente
lo ve—, asi que estrecharlo seria una migracion para no dejar pasar nada que la lista de la API ya
no deja pasar, y convertiria un despliegue sin migraciones en uno con copia previa de la base. La
asimetria tiene su testigo: el caso 6 de `test_conductor_order_expiry.js` escribe su fila `stop`
directamente en la base, de modo que una orden anterior a la retirada se sigue leyendo, listando y
caducando igual, y el dia que alguien estreche el CHECK sin mirar, esa prueba lo dira.

Y **el conductor no se toco**: sigue entendiendo `stop` por si habla con un APTS anterior, asi que
se queda en **1.6.0**. Sube solo el README, a **1.6.1**, porque describia cuatro botones. La
premisa de partida —que habia ordenes `stop` historicas en PROD que una migracion romperia— resulto
falsa al comprobarla: `conductor_orders` esta **vacia** en produccion (las cinco del fixture se
fueron con el proyecto), y `command` no es un tipo enum de Postgres sino un CHECK, es decir un
`drop`/`add constraint` sin reescritura de tabla. Aun asi la migracion no compra nada, y por eso no
se hizo.

De paso, la pestaña Conductor **se refresca sola** cada diez segundos, el mismo intervalo que
sondea el conductor: mirar mas seguido no adelantaria nada, porque el buzon no se mueve entre
sus preguntas. Solo corre con esa pestaña delante y la ventana visible, el boton Actualizar
sigue estando, y el refresco automatico no enciende el indicador de carga —quien esta mirando
no pidio nada—.

## Los agentes de Claude Code salian sin la superficie que se les exige usar

Lo reporto un cliente, `fm-synth`, el 2026-08-09. `/apts-next` delegaba en el orquestador y el
subagente arrancaba **sin una sola herramienta `mcp__apts__*`**: no podia llamar a
`list_backlog_items`, ni a `register_task`, ni a nada. Como la superficie es MCP-only y la regla 1
prohibe bootstrapear un cliente HTTP crudo, al agente no le quedaba camino admisible. Los cuatro
archivos generados declaraban `tools: Task, Read, Glob, Grep, Edit, Write, Bash` mientras su propio
cuerpo les exigia usar las herramientas de APTS como unica via: la contradiccion vivia **dentro del
mismo archivo generado**, y ninguno de los cuatro podia ejecutar su mision.

La causa es una divergencia entre los dos runtimes que el generador trataba igual. En Claude Code,
`tools:` del frontmatter es lista blanca **exclusiva**: si la clave esta, lo que no se nombra se
filtra, herramientas MCP incluidas. En opencode el mapa `tools:` es **aditivo** —lo que no se nombra
se queda en su valor por defecto, y para las MCP ese valor es habilitado—, asi que el mismo campo
neutral del spec significa «habilita estas» en un runtime y «solo estas» en el otro. Por eso
opencode nunca sufrio **esto** —tenia lo suyo, en la seccion siguiente— y su frontmatter no se toca.

No es red, ni credenciales, ni registro: desde la sesion principal del mismo cliente —que no pasa
por el frontmatter de subagente— `list_backlog_items` devolvia `ok: true`. Y **la lista `allow` de
`.claude/settings.json` no repone nada**: es capa de permisos, otra distinta, y ambas tienen que
coincidir. Ver las 22 herramientas ahi listadas hace suponer, al operador y al que depura, que el
agente las tiene.

El arreglo enumera las `mcp__<server>__*` en la lista blanca en vez de omitir la clave `tools:`.
Omitirla tambien desbloquea —el agente heredaria todo—, pero se llevaria por delante el limite por
agente que el spec declara: `apts-bugfix-intake` es de solo lectura a proposito, sin `edit`, y
heredarlo todo le daria `Edit` y `Write`. El prefijo sale de `spec.mcp.server`, el mismo nombre con
el que este generador escribe `.mcp.json`, asi que no puede desincronizarse; los nombres de
operacion salen del contrato, igual que la lista `allow`. Van las 22 a los cuatro agentes: quien
puede hacer que lo fija el cuerpo del agente, no un recorte por archivo que habria que mantener al
dia en cada cambio de contrato.

El generador sube a **1.2.0**: un cliente que cachee por version no se entera de otra forma y sus
cuatro agentes siguen rotos. Del arreglo solo, regenerar movia cuatro lineas de frontmatter y nada
mas.

Con el mismo viaje van las tres versiones de la prosa del bloqueo irreportable de mas abajo:
`surface_spec` a **1.0.3** (regla 7 de la seccion gestionada), `skills_json` a **1.0.3** (la
descripcion de `report_blocker`, que es lo que el agente lee en `tools/list`) y `agent_guidelines`
a **1.1.1** (paso 7 del camino feliz). Ningun esquema cambia; el contrato sigue derivando 22
herramientas y el chequeo pasa al importar. Correr el generador dos veces no mueve nada: sigue
siendo idempotente.

## El adaptador de opencode era ininstalable, y las tres causas eran del generador

Lo reporto un cliente el 2026-08-14 (opencode 1.14.33, Windows). Las tres fallan en cadena, cada
una tapando a la siguiente, y ninguna es de opencode: son tres suposiciones del generador sobre
como funciona ese runtime.

**Una clave de adorno invalidaba el archivo entero.** El generador escribia el banner «GENERADO —
no editar» como clave `_generated` porque JSON no tiene comentarios. opencode valida su
configuracion contra un esquema **estricto** y rechaza claves desconocidas: `Unrecognized key:
_generated`, y con eso descarta el `opencode.json` **completo**. El servidor MCP no llegaba a
intentarse. La anotacion es inocua en `.mcp.json` y en `.claude/settings.json` —Claude Code no
valida asi— y por eso el generador la escribia igual en los tres sitios. Ahora opencode recibe el
banner como comentario: su configuracion se parsea como **JSONC**, asi que cabe.

**La url interpolada no es equivalente a la url literal.** La url salia como
`{env:APTS_MCP_URL}`. En opencode esa sintaxis no es una expansion del campo sino una sustitucion
de **texto** sobre el archivo entero, hecha al leer la configuracion, y una variable que no este en
el entorno del proceso se convierte en **cadena vacia**. En una cabecera eso da una llamada sin
credencial, que es un error legible de APTS; en la url da `""`, que no parsea, y opencode marca el
servidor `failed` con `Invalid MCP URL` antes de intentar nada. Ahora va la url literal, del campo
nuevo `mcp.defaultUrl` del spec, y `APTS_MCP_URL` queda como escape para apuntar a otro despliegue.
El manifiesto ya publicaba la url literal en su bloque de registro: el generador era el unico sitio
donde estaba interpolada.

**Y las instrucciones prometian un `.env` que nadie leia.** La seccion gestionada dice «define las
variables en un `.env` en la raiz del proyecto». opencode no lee ninguno: `{env:VAR}` mira el
entorno del **proceso**, y punto. El operador tenia que exportarlas a mano antes de abrir la
herramienta o no habia integracion, y la promesa del archivo generado era falsa. Ahora el adaptador
trae un quinto artefacto, `.opencode/plugin/apts-env.js`, que lee ese `.env` y reescribe la url y
las cuatro cabeceras del servidor MCP ya en memoria. No es un truco: opencode inicializa los
plugins **antes que nada mas** precisamente porque pueden mutar la configuracion, y el gancho
`config` recibe el objeto vivo que despues lee el registro MCP. Se descubre solo en
`.opencode/{plugin,plugins}/*.{ts,js}`, asi que no hay nada que declarar ni que instalar.

Tres decisiones del plugin que no son obvias. Va en `.js` y sin tipos: en `.ts` acabaria dentro del
`tsconfig` del proyecto cliente y su comprobacion de tipos fallaria por unos parametros que no
puede tipar. El entorno del proceso **gana** al `.env`, como cualquier dotenv. Y una variable sin
valor **borra** su cabecera en vez de mandarla vacia, para que APTS conteste nombrando el campo que
falta en vez de tomar la cadena vacia por identidad.

Comprobado de punta a punta contra opencode 1.18.18 con un servidor MCP de mentira que anota las
cabeceras: `opencode mcp list` dice `✓ apts connected`, la url es la del `.env` y las cuatro
cabeceras llegan con sus valores —incluidos el prefijo `export `, las comillas y el `# comentario`
al final de linea—. Con un `.env` sin credenciales, conecta igual y no llega ninguna de las cuatro.

El generador sube a **1.3.0** y el spec a **1.1.0**: un cliente que cachee por version no se entera
de otra forma, y el spec crece el campo `defaultUrl` del que depende el generador nuevo —emparejar
un spec viejo con el aborta nombrandolo, que es justo lo que se quiere en vez de emitir una url
vacia—. La guia en HTML ya no dice que ningun runtime lee el `.env`: dice la excepcion y de que
paso depende. Correr el generador dos veces sigue sin mover nada.

## Una iniciativa del metodo no se podia cerrar sin entrar en la base

Ninguna de las 23 operaciones cierra, archiva ni resetea una iniciativa, y `create_initiative` es
idempotente por `(project_url, status='active')`: mientras esa fila siga activa, un cliente que
quiere re-planificar desde cero recibe SIEMPRE la vieja, resumida en su fase. El panel tampoco
ayudaba, porque la capa del metodo entera —iniciativa, fase, epicas, artefactos— no tenia pantalla:
la ficha del proyecto enseñaba backlog, conductor, restricciones, roster, reglas de conduccion,
tareas y logs, y nada del motor.

Se vio en `tickets` el 2026-08-15. Le redefinieron el producto, el agente comprobo el estado, encontro
la iniciativa vieja en `implementation` con 21 historias obsoletas y **paro en preflight** en vez de
improvisar la re-planificacion por otro camino. Acerto: dijo que no existia herramienta para
resetear y que era accion de operador. El unico camino fue un SSH a la base de PROD.

Ahora es la pestaña **Metodo** de la ficha del proyecto, con dos acciones. **Archivar** es el camino
blando y el que resuelve el caso comun: basta con que la fila deje de estar `active` para que el
siguiente `create_initiative` de de alta una NUEVA en `analysis`, y los artefactos viejos quedan de
historico sin contaminar porque su `scope_key` es `initiative:<id-viejo>:<doc_type>` y la nueva no
los alcanza. Pregunta que hacer con las historias —retirarlas es borrado blando— porque las que se
quedan se duplican con el plan nuevo.

**Purgar** es el duro, y no es un DELETE con adornos. Borrar la iniciativa no limpia el proyecto:
solo `epics` y `project_state` cuelgan por CASCADE, mientras `backlog_items` (por `initiative_id` y
por `epic_id`), `semantic_documents.initiative_id` y `action_items` son SET NULL, de modo que las
historias sobreviven vivas y huerfanas —visibles en `list_backlog_items`, invisibles para el motor—,
que es un estado peor que el de partida. Por eso es una secuencia: los `agent_logs` de las tareas de
sus historias (esa tabla no tiene `project_url`, cuelga de `task_id`), esas tareas, los documentos de
las historias (`scope_key` `backlog_item:<id>`, sin FK que los ate), las historias, los artefactos de
la iniciativa —que arrastra `semantic_document_embeddings`— y por fin la iniciativa. La fila de
`projects` se conserva a proposito: el re-bootstrap necesita esa url. Las tareas sin historia
tampoco se tocan, porque no hay forma de atribuirselas.

La mecanica vive en `backend/scripts/lib/method_lifecycle.js` (patron de servidor puro, como
`method_bootstrap.js`) y las rutas finas en `index.js`, bajo
`/api/dashboard/projects/:url/initiatives`: una de lectura y dos POST, `archive` y `purge`. Purgar
exige teclear el nombre del proyecto, y esa compuerta vive en el modulo y no en la ruta, para que
viaje con la mecanica si algun dia se expone por otra superficie. **No** es operacion de agente y no
esta en el manifiesto: cerrar la propia iniciativa es decision de operador —el agente que se topo con
esto acerto al pararse—, y el contrato no se toca, con lo que `schema_version` no se mueve.

Comprobado con `backend/scripts/test_method_lifecycle.js`, 32 aserciones contra la base de prueba
dentro de una transaccion que se revierte. La que importa de verdad no es ninguna de las cuentas:
es que tras archivar, `create_initiative` da de alta una **nueva** en `analysis` en vez de resumir la
vieja, que era el bloqueo entero. Y la que cierra la purga: que no queden historias con
`initiative_id` en NULL. Ademas, las tres rutas por HTTP contra el servidor de prueba —401 sin
sesion, 400 sin confirmacion— y el ciclo completo pulsando los botones.

## Abierto

**El camino de Cloudflare no se ha visto devolver un vector.** El `CLOUDFLARE_API_TOKEN` del `.env`
es valido y esta activo (`/user/tokens/verify` responde 200) pero no alcanza ninguna cuenta
—`/accounts` devuelve la lista vacia—, asi que cada embedding responde `401 Authentication error`.
Falta un token con permiso **Workers AI: Read** sobre `8816b3e0…`; con el, queda por confirmar de
primera mano la forma de la respuesta del punto compatible con OpenAI —vector en
`data[0].embedding` y `usage` con tokens—, que es lo unico que se dio por bueno leyendo la
documentacion. Si ese punto contestara con el sobre nativo de Workers AI, el lector ya acepta
`result.data[0]` y no haria falta tocar nada.

**Editar `workflow_steps` sigue fuera de alcance**, declarado. Las instrucciones paso a paso
del metodo se editan sembrando el corpus, no desde el panel.

**Un bloqueo anterior al registro de tarea sigue sin poder registrarse en APTS**, y ahora se dice.
`report_blocker` exige `task_id` —esta en `MCP_REQUIRED_IDENTITY_FIELDS` y el remoto no lo resuelve
nunca—, pero el unico sitio de donde sale un `task_id` es `register_task`: si lo que esta roto
impide llegar ahi, el bloqueo no cabe. La clase mas grave —superficie inalcanzable, entorno mal
configurado, credenciales rotas— es justo la que no deja constar. Lo que se arreglo es la mentira,
no el hueco: la descripcion decia «pass `task_id` […] unless your integration layer supplies it» y
sugeria que la identidad podia suplirlo. Ahora dice que no lo suple nadie, que un bloqueo anterior
no es reportable, y que **no** se registre una tarea contra una unidad ajena para conseguir un id
—eso marca bloqueada una unidad que no lo esta, y es peor que no reportar—. Lo mismo en la regla 7
de la seccion gestionada y en el paso 7 de las guidelines.

Cerrar el hueco de verdad si es decision, y no esta tomada. Un bloqueo **a nivel proyecto** hoy no
tiene donde vivir: `agent_logs` no tiene columna de proyecto —se ata al proyecto solo a traves de
`tasks`— y el rojo del panel se **deriva** de `backlog_items.status`, que fue el arreglo de
e94a4b5. Un `report_blocker` sin unidad ni tarea, para que se vea, pediria columna nueva, camino de
lectura y sobre todo **quien lo apaga**: sin ciclo de vida se reintroduce el flag pegado que se
acaba de quitar. La variante sin ese coste es aceptar `backlog_item_id` sin `task_id` —la unidad ya
tiene ciclo de vida—, que sirve cuando hay unidad y no cuando lo roto es el tooling, que era el
caso.

Todo lo anterior esta **desplegado**: entro en produccion con `1da2d92` el 2026-08-14, sin
migraciones —siguen siendo 23— y con el frontend recompilado en el mismo viaje. El manifiesto
publico anuncia `adapter_generator 1.3.0`, `surface_spec 1.1.0`, `skills_json 1.0.3` y
`agent_guidelines 1.1.1`; el generador que se descarga de PROD trae las `mcp__*` y emite el
adaptador de opencode instalable, y el spec trae `mcp.defaultUrl`. Un cliente que ya tenga los
adaptadores viejos no se entera solo: tiene que volver a bajar generador y spec y regenerar.

Las seis comprobaciones del desplegador pasaron y el aviso de `/mcp` **no salio** —nginx ya lo
proxya—. El frontend desplegado es el nuevo: el `index.html` que sirve nginx pide
`assets/index-DtQKkcdH.js`, que esta en el dist recien compilado. El backend volvio `online` con
**un** reinicio (30 acumulados contra 29), asi que ninguno de los auto-chequeos de arranque abortó.

**Produccion corre `8f14bf8` desde el 2026-08-15**, el despliegue de la pestaña «Metodo». Sin
migraciones nuevas, asi que no hubo copia previa de la base. Las seis comprobaciones del desplegador
pasaron, el aviso de `/mcp` no salio, el `index.html` publicado pide `assets/index-_forGAHd.js` —que
esta en el dist recien compilado— y el backend volvio `online` con **un** reinicio (32 acumulados
contra 31). Comprobado ademas por la URL publica que la ruta nueva esta registrada en el backend que
corre: `/api/dashboard/projects/<url>/initiatives` responde **401** sin sesion y una ruta inventada
del mismo prefijo responde **404**. Ese par es la comprobacion: con `try_files` un 200 no probaria
nada, y un bundle nuevo con un backend viejo daria 404 en la buena.

**El `.env` de PROD no necesita ninguna clave nueva.** Tiene diez y ninguna de las que llegaron
despues es obligatoria: `EMBEDDING_DEFAULT_MODEL` no hace falta porque
`OPENROUTER_DEFAULT_EMBEDDING_MODEL` se sigue leyendo detras y ya vale
`openai/text-embedding-3-small`; `METHOD_CLAIM_TTL_MS` (1 h) y `METHOD_MAX_STEP_REVISITS` (3) traen
valor por defecto; `PUBLIC_APP_URL` cae en `CORS_ORIGIN`, que apunta al sitio bueno; y las tres
`CLOUDFLARE_*` solo hacen falta el dia que el modelo por defecto pase a ser un `@cf/...`.


**Comprobado despues del despliegue del 2026-08-14** (`d1c18c4`, **con migracion**: la 024, la
segunda que corre en PROD desde el arranque de cero). La copia previa quedo en
`/root/apts-backup-20260814-213603-1da2d92a6.dump` (648 KB). En la base del servidor, el paso
terminal de `bmad-create-epics-and-stories` (`bmad:v6.8.0`, el 2) trae los dos descriptores con
`backlog_items` marcado `required_for_close`, asi que el recableado alcanzo a la libreria ya sembrada
sin re-sembrar. Por la URL publica, `skills.json` trae **23 operaciones** con `adopt_backlog_items`
entre ellas, y el manifiesto publica `skills_json` en 1.1.0 y `surface_spec` en 1.1.1 con
`schema_version` **1.1.2** (sin cambios: no hay clave nueva). Las seis comprobaciones del desplegador
pasaron, el aviso de `/mcp` no salio, y el `index.html` publicado pide `assets/index-DtQKkcdH.js`,
que esta en el dist recien compilado.

**El estado de los dos proyectos vivos, leido en PROD despues de desplegar.** (Lo de `tickets`
quedo **superado el 2026-08-15**: le redefinieron el producto y esa iniciativa se purgo entera —1
iniciativa, 1 epica, 8 punteros de roster, 21 historias, 29 documentos, 2 tareas—, asi que el
proyecto existe sin ninguna iniciativa y el cliente dara de alta la suya en `analysis`. Se hizo por
la base, que era el unico camino que habia; hoy es la pestaña «Metodo» del panel.) `tickets` era el
caso que motivo el arreglo y seguia como estaba —el despliegue no repara datos—: iniciativa
`f6e6e4e5` en `implementation`, epica `af4d8e88` con **0 hijos**, y **21 items sueltos**, todos
`feature`, con prioridad y orden ya puestos (p1 `US-01`…`US-13` mas la historia `1.1`, p2 `US-14`…
`US-17`, p3 `US-18`…`US-20`), asi que un barrido de `adopt_backlog_items` sin ids los adopta en el
orden del plan. Los siete punteros del roster estan registrados —`opencode` entre ellos, como
`bmad-agent-dev`— y los ocho artefactos del metodo escritos hasta `story_spec`. `fm-synth` tiene su
epica con 25 hijos y 29 sueltos que **no** son plan: 23 `feature` y 2 `chore` archivados y 4 bugs en
`review`. Ahi un barrido sin ids adoptaria los 25 archivados —los bugs quedan fuera por defecto—, que
no es lo que nadie quiere: en ese proyecto la adopcion va con `backlog_item_ids` explicitos, si es
que hace falta.
