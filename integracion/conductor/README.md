# apts-loop — conductor secuencial de implementación

Ejecuta en bucle la fase de implementación de una iniciativa APTS: pregunta al motor qué
toca, lanza **un agente por story** con el contexto limpio, y repite hasta que el motor
dice `done` o algo lo frena.

La memoria entre vueltas **no vive en el conductor**: vive en el servidor
(`initiatives.phase`, `project_state.cursor`, el backlog). El conductor no guarda estado
propio; el diario que escribe es evidencia, nunca fuente de verdad. Por eso matarlo y
relanzarlo es seguro: el puntero del motor sigue sosteniendo la story y la siguiente
vuelta la retoma donde estaba.

## Alcance

Conduce **sólo** unidades iterables (`bmad-dev-story`). No hace intake de bugs, no da de
alta funcionalidades y no conduce las fases generativas —analysis, planning,
solutioning—, que son interactivas, tienen elicitación y paran por otros motivos. Si el
motor recomienda algo fuera de alcance, el conductor **para y lo dice** en vez de
improvisar. La comprobación está en código (`--workflows`), no en la documentación.

Para el ciclo completo desde una spec existe el agente `APTS Method Orchestrator`. El
reparto natural es: el orquestador (o una persona) lleva la iniciativa hasta
`implementation`, y a partir de ahí este conductor mastica las stories.

## Uso

```bash
node integracion/conductor/apts-loop.js \
  --agent-cmd 'claude -p "$(cat {prompt_file})" --model {model} --permission-mode acceptEdits' \
  --model-escalation 'claude-sonnet-5,claude-opus-5' \
  --max-iterations 20
```

La identidad cae al entorno si no se pasa por bandera: `APTS_MCP_URL`, `APTS_API_KEY`,
`APTS_PROJECT_URL`, `APTS_AGENT_NAME`, `APTS_AGENT_EMAIL`.

El entorno, a su vez, cae a un archivo: `--dotenv RUTA`, y por defecto `.env` del
directorio actual. Que falte no es error; que falte uno señalado a mano, sí. **No pisa
lo que ya esté en el entorno del shell**, así que la precedencia es bandera > shell >
archivo. Se llama `--dotenv` y no `--env-file` porque ese nombre lo reserva Node y lo
intercepta aunque venga detrás del script — y de forma asimétrica, además: si el
archivo existe deja pasar la bandera sin cargar nada, y si falta mata el proceso con
`exit 9`.

`--agent-name` debe ser la identidad **registrada como rol dev en el roster**
(`set_agent_role`) y tiene que ser estable entre vueltas: es el puntero que sostiene el
claim de la story. Si no lo es, el motor devuelve `wait` nombrando el rol que falta y el
conductor para con código 11.

`--agent-cmd` es obligatorio y debe contener `{prompt_file}`. El prompt viaja **por
archivo**, nunca interpolado en la línea de shell. Admite además `{story_id}`,
`{model}`, `{agent_name}`, `{project_url}`, `{iteration}`, `{attempt}` y
`{max_attempts}`.

Si hay política de modelo configurada, el comando **debe** contener `{model}`, o el
conductor no arranca. Sin esa comprobación se puede montar una escalera `sonnet→opus`,
no pasarle el modelo al agente, y ver un diario que dice que escaló mientras los tres
intentos corrían contra el modelo por defecto de la CLI.

## Qué CLI conduce

`--agent-cmd` **es** la elección. El conductor no sabe qué hay al otro lado: escribe el
prompt en un archivo, sustituye los marcadores en una línea de shell y mira el código de
salida. Cualquier CLI que sepa hablar MCP contra APTS sirve, y elegir otra es cambiar esa
línea — por bandera o por `APTS_LOOP_AGENT_CMD` en el `.env`, para que cada desarrollador
fije la suya sin tocar el comando de nadie.

```bash
# Claude Code
APTS_LOOP_AGENT_CMD='claude -p "$(cat {prompt_file})" --model {model} --permission-mode acceptEdits'
APTS_LOOP_MODEL_ESCALATION='claude-sonnet-5,claude-opus-5'

# Opencode — `-f` adjunta el archivo, así que el prompt no pasa por el shell
APTS_LOOP_AGENT_CMD='opencode run -m {model} -f {prompt_file} "Implementa la unidad descrita en el archivo adjunto"'
APTS_LOOP_MODEL_ESCALATION='anthropic/claude-sonnet-5,anthropic/claude-opus-5'
```

Los nombres de modelo son de la CLI, no de APTS: el conductor los trata como texto opaco
y los sustituye sin validarlos. Por eso la escalera de Opencode lleva `proveedor/modelo`
y la de Claude Code no.

**En Windows el `$(cat ...)` no existe**: `shell: true` resuelve a `cmd.exe`, así que la
forma equivalente es `type {prompt_file} | claude -p --model {model} --permission-mode acceptEdits`.
La vía de Opencode no tiene ese problema porque nunca mete el prompt en la línea, así que
vale igual en los dos sistemas y no necesita variante.

**Estas líneas también las publica el manifiesto**, en
`mcp_endpoint.registration_by_runtime.<runtime>.loop_agent_cmd`, para que un agente que
llega por la URL pueda ofrecerte las opciones antes de bajarse este archivo. La fuente es
la del servidor y esta copia existe sólo para que el manual se lea suelto; un auto-chequeo
del arranque comprueba que las dos dicen lo mismo y aborta con `exit 3` si se separan. Si
editas un comando aquí, edítalo también allí.

**El agente hereda el entorno del conductor**, incluido lo que cargó `--dotenv`. De ahí
saca su identidad APTS (`APTS_MCP_URL`, `APTS_API_KEY`, `APTS_PROJECT_URL`,
`APTS_AGENT_NAME`, `APTS_AGENT_EMAIL`) la configuración MCP de la CLI, sin que haya que
repetirla en el comando ni exponerla en los argumentos del proceso.

Empieza siempre con `--dry-run`: resuelve la primera decisión e informa qué lanzaría,
sin ejecutar nada.

## Frenos

| freno | por defecto | qué detecta |
|---|---|---|
| `--max-iterations` | 50 | tope duro; red de seguridad contra un bucle desbocado |
| `--max-stalls` | 2 | vueltas seguidas sin que cambie **nada** del estado del método |
| guarda de alcance | `bmad-dev-story` | el motor pide un paso que este conductor no conduce |
| código del agente | 1 intento | el proceso del agente terminó distinto de 0 en **todos** sus intentos |

La huella de estancamiento se compone en el cliente con lo que `apts_status` ya
devuelve —fase, `next`, rol, `workflow_key`, `step_key`, `target_id` y el reparto del
backlog por estado—, así que no hace falta ningún contador nuevo en el servidor.

`apts_status` es de sólo lectura: computa la misma recomendación que `apts_next` dentro
de una transacción que se rollbackea. El conductor por tanto **nunca reclama una story**;
el claim lo hace el agente al arrancar, que es quien va a sostenerlo.

Con una excepción, al final: cuando la recomendación es `done`, el conductor llama una
vez a `apts_next`. Ese rollback también descarta el **avance de fase** que el motor hace
al cerrar el ciclo, así que sin esa llamada el trabajo termina de verdad pero
`initiatives.phase` se queda clavado en la última fase trabajada y el panel enseña a
medias un proyecto que ya está hecho. Con la recomendación en `done` no queda nada que
reclamar: esa llamada sólo persiste el recorrido.

## Registro de la ejecución en APTS

El conductor abre **una tarea por unidad** (`register_task`), titulada con el nombre de la
historia —cuesta una llamada de más y es la diferencia entre una lista legible y una
columna de UUIDs—, y la va moviendo con lo único que se puede medir desde fuera de la
sesión del agente: modelo, intento, duración y código de salida. `--no-task-log` lo apaga.

Esa tarea viaja al agente en el prompt (`{task_id}`) para que use ésa y no registre otra.
Sin eso salen dos filas por historia, y la segunda es peor que redundante: la que registra
el agente pasa a ser la **tarea activa** del backlog item, y el item sigue los cambios de
estado de su tarea activa.

Existe porque el conductor es lo único que ve la ejecución entera. El agente vive dentro
de su sesión y el motor sólo guarda lo que el método *produjo*, así que media hora de
trabajo cabía en APTS como un `UPDATE` de estado, y el detalle sólo estaba en el diario
JSONL de la máquina que lanzó el bucle.

Los estados dicen lo que pasó, y no más:

| estado | qué significa |
|---|---|
| `in_progress` | el agente está corriendo (`register_task` ya la devuelve así) |
| `review` | el proceso del agente terminó bien; el motor todavía no ha confirmado el cierre |
| `done` | el motor dejó de apuntar a esa unidad, o el ciclo entero terminó |
| `stalled` | el conductor paró sin que el agente entregara |

`review` no se convierte en `done` por si acaso: quien puede decir que una unidad cerró es
el motor, y lo dice en la vuelta siguiente al pasar a otra. Un `done` de cortesía haría del
registro un sitio donde todo sale bien siempre.

**La tarea se asocia a la unidad y no la posee.** Son dos cosas distintas y hasta la
versión 1.4.0 venían juntas: pasar `backlog_item_id` a `register_task` grababa la
asociación *y* convertía la tarea en la tarea activa del item, que es el puntero por el que
`update_task_status` propaga —una tarea en `done` pone la historia en `done`—. Poseerla
abriría una puerta trasera justo al lado de la compuerta de revisión: cerrar la tarea
cerraría la unidad sin pasar por el `code_review`. Así que el conductor manda
`owns_backlog_item: false`: la ejecución queda colgando de su historia, consultable y para
siempre, y sigue sin poder cerrarla. Antes el vínculo era el título y un JSON dentro de
`context`, que no es una relación y no se puede consultar.

Ese campo tampoco reanuda: la reanudación se busca por el puntero de propiedad, así que sin
propiedad no hay a quién reanudar. Es lo que se quiere aquí — cada pasada del conductor
sobre una unidad es una ejecución distinta.

Dos detalles del camino, por si aparecen en el diario:

- Todo el registro es **best-effort**. Si una de estas llamadas falla, se anota
  `tarea_fallo` y el bucle sigue: el registro de una ejecución no puede ser el motivo de
  que la ejecución pare.
- Una unidad puede tardar más que la ventana de frescura de APTS (15 minutos) y el
  conductor **no puede latir** mientras el agente corre, porque `spawnSync` bloquea el
  proceso entero. Así que la vigilancia de fondo puede haber marcado la tarea `stalled`
  antes de que se cierre; el conductor la reanima y reintenta la transición una vez.

## Reintentos de red

Cada llamada MCP reintenta **3 veces** con espera creciente —2 s, 6 s, 18 s— antes de
parar por red. No es configurable: que un parpadeo no tumbe el bucle no es una política
que haya que afinar, y si la red está caída de verdad la parada con código 2 sigue ahí
veintiséis segundos después.

Se reintenta sólo lo que puede salir distinto: el `fetch` que no llegó a hablar, un 429 y
los 5xx. Un 4xx es una llamada mal hecha y un error JSON-RPC es el servidor contestando
que no; repetirlos no cambia nada y esconde el motivo detrás de tres esperas.

Existe porque el bucle desatendido se paraba de verdad: tres caídas en cuatro vueltas el
2026-08-08, siempre en la llamada a `apts_status` inmediatamente después de cerrar una
unidad, y con el endpoint respondiendo 200 un minuto más tarde. Cada una exigía que una
persona relanzara el conductor, que es justo el trabajo que el bucle vino a ahorrar.

Cada reintento deja línea en el diario (`evento: "reintento_red"`, con la herramienta, el
número de intento, la espera y el motivo). Un servidor que se degrada se ve como
reintentos que aparecen y se multiplican; esconderlos convertiría la red de seguridad en
una forma de no enterarse.

## Elicitación

El paso de entrada de `bmad-dev-story` llega en `mode: "await_input"` con las preguntas
de BMAD del tipo *"¿qué story quieres desarrollar?"*. Bajo APTS eso **ya lo decidió el
motor** al asignar el claim, así que el prompt por defecto instruye al agente a reanudar
por su cuenta (`apts_workflow_step` con `answers`) apuntando a la story asignada, sin
parar a preguntar. La licencia es estrecha a propósito: sólo para lo que la asignación ya
determina. Si un paso posterior elicita algo que la asignación no decide, el agente debe
reportar bloqueo y detenerse en vez de inventar.

Esto ocurre **dentro de la sesión del agente**: el conductor no lo ve y no puede
responder por él.

## Plantillas de prompt

La de por defecto está en el propio `apts-loop.js` (`PROMPT_POR_DEFECTO`) y no reexplica
el ciclo: apunta a `method_conduction` del manifiesto, que es la fuente autoritativa.
`--prompt-file RUTA` la reemplaza entera. Los marcadores que se sustituyen son
`{story_id}`, `{agent_name}`, `{project_url}`, `{role}`, `{iteration}`, `{attempt}`,
`{max_attempts}` y `{task_id}`; lo que no case con ninguno se queda literal, así que un
`{"goto":"step:5"}` dentro del texto sobrevive intacto.

`{task_id}` es la tarea que el conductor abrió para esa unidad, o `(ninguna)` si no pudo.
Una plantilla propia **debería** pasársela al agente diciéndole que use ésa y no registre
otra: la que registra un agente por su cuenta pasa a ser la tarea activa del backlog item,
y `update_task_status` propaga por ese puntero, así que cerrarla pondría la historia en
`done` sin pasar por el paso terminal. La del conductor está asociada y no lo posee.

En `prompts/` viven las variantes versionadas:

| archivo | qué añade | artefacto |
|---|---|---|
| `dev-story-revision-adversaria.md` | una compuerta de revisión adversaria antes del paso 8 de `bmad-dev-story` | `loop_prompt_code_review`, en `…/integrar/conductor/prompts/` |

Se publican como artefactos por la misma razón que el conductor: si sólo estuvieran en el
repositorio, un cliente que arranca desde la URL leería aquí sobre un archivo que no puede
bajarse. Son opcionales de verdad —el conductor trae su plantilla por defecto dentro—, así
que no bajarlas no rompe nada.

**Revisión adversaria.** Reproduce dentro de la sesión del agente lo que
`bmad-code-review` describe y nunca ejecuta: tres capas en subagentes paralelos —Blind
Hunter (sólo el diff), Edge Case Hunter (los bordes) y Acceptance Auditor (sólo la story
y sus criterios)— con triage. Van en subagentes y no en el hilo principal porque ese hilo
acaba de escribir el código: una capa que hereda su contexto hereda sus puntos ciegos.
Un hallazgo cuenta sólo con `archivo:línea` y un escenario de fallo concreto; lo demás se
anota y no se corrige. Si queda alguno confirmado, la validación del paso 8 ha fallado y
el agente declara la rama que el propio método tiene, `{"goto":"step:5"}`, en vez de
parchear en silencio — con el tope de revisitas haciendo su trabajo si la unidad no
sobrevive a las pasadas.

La revisión se escribe una vez y viaja por dos caminos: `docs/reviews/<story_id>.md`
commiteado en el repositorio destino, y `output.content` del submit terminal, donde el
motor la guarda como artefacto `code_review` **de esa unidad**. El segundo camino es una
compuerta de verdad: el paso terminal lo declara `required_for_close`, así que un submit
sin él se rechaza con `ok:false` y la story no cierra. La plantilla vale también contra un
servidor que todavía no tenga la compuerta —ahí ese `content` simplemente no se captura—,
así que no hay que sincronizar el despliegue con el reinicio del conductor.

Cuesta: tres subagentes por story, y en reloj entre cuatro y ocho minutos más por vuelta.

## Avisos al parar

### Telegram

```env
APTS_LOOP_TELEGRAM_TOKEN=...        # sólo por entorno
APTS_LOOP_TELEGRAM_CHAT_ID=-100...  # o --telegram-chat-id
```

El **token se lee sólo del entorno**, nunca por bandera: los argumentos de un proceso los
ve cualquiera con `ps` o el administrador de tareas, y quedan en el historial del shell.
El chat id no es secreto y sí admite bandera.

Configurar **uno solo de los dos es error de arranque**, no de parada. Descubrir que el
notificador estaba mal justo cuando algo se rompe es el peor momento posible: es cuando
ya nadie mira la consola.

Mensaje tipo:

```
🚧 APTS · fuera_de_alcance

el motor pide 'bmad-prd/0' como paso generativo, fuera del alcance de este
conductor (bmad-dev-story). Condúcelo a mano o con el orquestador de método.

proyecto: https://github.com/org/repo
agente: dev-loop
fase: planning
vuelta: 1
salida: 12
```

Detalles que importan:

- Se manda **en cada parada**, incluida la que no es ordenada: si el bucle muere porque
  APTS no responde, avisa con motivo `red`. Ése es precisamente el caso en el que no hay
  nadie delante.
- Va **sin `parse_mode`**. El detalle viene del servidor y puede traer `_ * [ \``, que
  Telegram interpretaría como formato y le harían rechazar el mensaje entero — justo el
  que más falta hace.
- Reintenta sólo lo que tiene sentido reintentar: red, `429` y `5xx`, dos veces. Un `400`
  (chat o token equivocados) no se reintenta, se reporta.
- **Un fallo del aviso nunca cambia el código de salida del bucle.** El notificador no
  puede convertirse en un modo de fallo nuevo.
- El token se tapa en cualquier mensaje de error antes de imprimirlo o escribirlo en el
  diario: viaja dentro de la URL y se colaría solo.

`APTS_LOOP_TELEGRAM_API` permite apuntar a otro servidor (se usa para probar sin token
real).

### Cualquier otra cosa

`--on-stop` recibe el motivo **por entorno**, no sustituido en la línea de comandos
(`detalle` trae texto del servidor con comillas y saltos de línea):

`APTS_LOOP_REASON`, `APTS_LOOP_DETAIL`, `APTS_LOOP_PHASE`, `APTS_LOOP_STORY_ID`,
`APTS_LOOP_ITERATION`, `APTS_LOOP_PROJECT_URL`, `APTS_LOOP_EXIT_CODE`.

Los dos conviven; el aviso de Telegram sale primero, porque el hook es un proceso del
operador que puede colgarse.

## Códigos de salida

| código | motivo |
|---|---|
| 0 | `done` — el ciclo terminó |
| 1 | configuración (falta un valor, `401`/`403`) |
| 2 | red o error del endpoint |
| 10 | `blocked` — el motor reportó un bloqueo |
| 11 | `wait` — el motor pide otro rol (en modo secuencial es una anomalía) |
| 12 | fuera de alcance — el paso recomendado no lo conduce este script |
| 13 | estancado — la huella no cambió en N vueltas |
| 14 | tope de iteraciones |
| 15 | detenido — alguien lo paró desde el panel |
| 20 | el agente terminó con error en todos sus intentos |
| 21 | la CLI del agente agotó su límite de uso |
| 22 | el comando de `--agent-cmd` no se pudo ejecutar |
| 23 | la CLI del agente rechazó sus credenciales |

No hay código nuevo para "falló incluso después de escalar": el motivo es el mismo y el
detalle lleva la historia — `el agente falló en los 3 intentos (1: sonnet → código 1;
2: sonnet → código 1; 3: opus → código 1)`, en consola, en el diario y en el aviso.

Del **21 al 23** sí lo hay, y el siguiente apartado explica por qué.

## Cuando el que falla es el entorno y no la story

Un intento fallido puede serlo por la story —para eso está la escalera de modelos— o
porque el agente **no llegó a trabajar**. Los tres casos de abajo son del segundo tipo y
comparten lo único que decide qué hacer: reintentar no puede salir distinto.

| motivo | código | qué lo delata |
|---|---|---|
| `limite_de_uso` | 21 | «hit your session/usage limit», «usage limit reached» |
| `agente_no_ejecutable` | 22 | «command not found», «is not recognized as an internal or external command» |
| `agente_sin_credenciales` | 23 | «invalid api key», «credit balance is too low», «please run … login» |

El que lo motivó fue el primero. El límite de uso es de la **cuenta**, no del modelo, así
que una escalera `sonnet → opus` gastaba su segundo intento en cero segundos y dejaba
escrito `agente_fallo`, que manda a buscar el problema en la story. Pasó dos veces en dos
días sobre una corrida real. Ahora se para al primer intento, con motivo y código propios,
y **la hora de reset que imprime la CLI viaja al diario** (campo `reset` del evento
`parada`), a la consola y al aviso de Telegram: es lo único accionable del mensaje.

Se reconocen leyendo la **salida** del agente y no su código, porque los tres terminan en 1
igual que un bug cualquiera. Por eso el conductor ya no hereda la salida a secas: hace de
eco —cada trozo se reescribe tal cual, así que en consola se ve lo mismo— y se queda con
los últimos 4 KB para poder leerlos si el intento falla. El efecto secundario a saber es
que la salida del agente deja de ser un terminal desde su punto de vista, de modo que una
CLI que coloree o dibuje barras de progreso escribirá texto plano.

Dos cerrojos contra el falso positivo, porque los dos errores no cuestan lo mismo:
confundir esto con `agente_fallo` gasta un reintento, y confundir un fallo de la story con
esto aborta una corrida que podía seguir.

- Sólo se mira cuando el intento **ya falló**, y sólo contra la cola de la salida.
- El 22 y el 23 exigen además que el proceso haya muerto **pronto** (60 s; se ajusta con
  `APTS_LOOP_STARTUP_MAX_MS`). Un binario que no existe mata al proceso en segundos, así
  que un intento que estuvo veinte minutos trabajando no falló por eso, diga lo que diga su
  última línea: puede estar implementando el manejo de un ENOENT, o imprimiendo el error de
  una prueba. El 21 **no** lleva ese cerrojo, a propósito: el límite llega justo cuando el
  agente lleva rato trabajando, que es exactamente el caso que se vio.

Una orden de parada del panel gana sobre todo esto: lo que pide una persona no lo discute
un diagnóstico automático.

## Granularidad y modelo

Una vuelta es **una story**, no un paso: los diez pasos de `bmad-dev-story` los recorre
el agente dentro de su sesión. Relanzar contexto por paso pagaría releer el repositorio
diez veces para una sola story.

De ahí se sigue que el modelo se elige **por intento sobre una story**, no por paso.
Enrutar el modelo por paso exigiría lanzar un agente por paso, que es justo lo que esta
granularidad evita.

## Reintento y escalado

Un fallo pasajero del proceso del agente no debe matar la corrida entera. Reintenta el
conductor y no el agente, por tres razones que no son de gusto: el modo de fallo que
motiva esto es **el proceso muerto** —CLI caída, límite de contexto, rate limit— y un
agente que ya no existe no puede reintentarse a sí mismo; **no se puede cambiar de
modelo dentro de una sesión**, así que escalar exige proceso nuevo; y el reintento
*dentro* de la sesión ya existe y ya está delegado, que es lo que el prompt dice sobre
`control_flow`. El agente reintenta **decisiones**; el conductor, **procesos**.

Dos formas de escribir la política, y la escalera es la única fuente del modelo de cada
intento:

```bash
--model NOMBRE  --max-retries N        # N+1 intentos, todos con el mismo modelo
--model-escalation "sonnet,opus"       # 2 intentos: sonnet y, si falla, opus
```

La longitud de la escalera **es** el número de intentos, así que no hay un segundo mando
capaz de contradecirla. Por defecto: un intento, sin reintentos — sin ninguna de estas
banderas el conductor se comporta exactamente como antes de que existieran.

Las tres caen al entorno (`APTS_LOOP_MODEL`, `APTS_LOOP_MAX_RETRIES`,
`APTS_LOOP_MODEL_ESCALATION`) y de ahí al `.env`, para que cada desarrollador fije los
suyos sin tocar el comando.

**Las dos formas juntas son error de arranque, pero sólo dentro de una misma capa.** Si
la línea de comandos dice algo sobre modelos, la capa de entorno queda entera fuera; lo
contrario obligaría a editar el `.env` para probar una escalera desde la consola. Lo que
sí sería un fallo silencioso es no saber cuál ganó, así que la política se anuncia al
arrancar y va al diario:

```
[apts-loop] política de modelo: escalera sonnet → opus (2 intentos por story)
            [bandera; se ignora APTS_LOOP_MODEL del entorno]; techo de sesiones: 20 × 2 = 40
```

El techo se dice en voz alta porque es lo que cuesta dinero: cada intento es una sesión
de agente entera.

### El reintento reanuda, no repite

El claim es idempotente para el propio `agent_name` y el plazo de caducidad sólo se
evalúa sobre los punteros de **otros** agentes, así que el reintento recupera la misma
story. Y como el motor re-sirve el paso fijado mientras el puntero siga `running`, el
intento siguiente **vuelve al paso donde murió el anterior**: si murió en el 5, empieza
en el 5. Por eso reintentar es barato, y por eso escalar de modelo apunta justo a la
parte que resistió en vez de pagar otra vez los pasos que ya cerraron.

A partir del segundo intento el prompt lleva un bloque extra que se lo dice al agente y
le pide comprobar el árbol de trabajo antes de rehacer nada. En el camino feliz ese
bloque no se envía y no cuesta nada.

Lo que **no** se puede deshacer es un paso ya entregado: los submits sólo avanzan. Un
agente que entrega basura y muere después deja un caso que se arregla a mano; el
conductor no puede revertirlo y el agente tampoco.

### Antes de gastar un intento, se pregunta

Entre un fallo y el reintento el conductor vuelve a llamar a `apts_status`. Cuesta cero
tokens y evita los dos derroches obvios: quemar una sesión del modelo caro en una story
que el agente ya cerró antes de morir al salir, e insistir sobre un bloqueo que el
agente reportó correctamente. Si la recomendación ya no apunta a esa story, la vuelta
termina ahí y el bucle sigue con el código de siempre.

La espera entre intentos es de 15 s (`APTS_LOOP_RETRY_DELAY_MS`, que existe para poder
probar el bucle sin esperar de verdad).

### Con `--max-stalls` no se pisan

Los reintentos viven **dentro** de la vuelta, por debajo de la medición de la huella. De
ahí salen dos propiedades sin ninguna regla especial: no consumen `--max-iterations`
—una vuelta es una story, con todos sus intentos—, y un atasco no puede contar dos
veces, porque si los intentos se agotan la vuelta termina en `agente_fallo` y el bucle
para sin llegar a la comprobación de estancamiento de la vuelta siguiente.

### Lo que no se hace: enrutar por atributos de la story

Se consideró elegir el modelo inicial según `item_type` o `priority`. No entra, y no por
coste —serían cero tokens— sino porque se pelea con la escalera: quien enruta el modelo
desde `--agent-cmd` toma posesión de `{model}`, y entonces no hay respuesta coherente a
qué modelo usa el intento 2. Además, enrutar por atributos es *predecir* la dificultad y
escalar es *medirla*: empezar barato y subir ante evidencia domina a apostar por
adelantado.

## Diario

`.apts/apts-loop.jsonl` por defecto (`--journal off` lo apaga). Una línea por evento:
arranque, estado de cada vuelta, resultado de **cada intento** del agente y parada. No
contiene secretos.

El evento `arranque` lleva la política resuelta (`modelos`, `politica_fuente`,
`politica_ignorado`, `env_file`); cada evento `agente` lleva `intento`,
`intentos_totales` y el `modelo` con el que corrió; un reintento que no llegó a
gastarse deja un `reintento_innecesario` con lo que el motor respondió en su lugar; cada
reintento de red deja un `reintento_red` con la herramienta, el intento, la espera y el
motivo; y la tarea de cada unidad deja un `tarea` al abrirse y otro al cerrarse —o un
`tarea_fallo` si APTS no aceptó la llamada, que no detiene el bucle.

### El diario también se ve en APTS

El archivo local es la fuente de verdad y no cambia. Además, mientras haya una tarea
abierta, los eventos que se ven desde fuera —`arranque`, `estado`, `agente`,
`reintento_red`, `tarea_fallo`, `parada`, `cierre`— se copian a APTS como filas de log de
esa tarea, y aparecen en la pestaña **Logs** del proyecto con acción `journal`. El resto
de eventos es contabilidad interna del bucle y se queda en el archivo.

El envío es un intento y nada más: sin reintentos, con plazo de cinco segundos y
tragándose cualquier error. Si APTS no está, el bucle no se entera. `--no-journal-remote`
(o `APTS_LOOP_NO_JOURNAL_REMOTE=1`) lo apaga.

## Latido durante la ejecución

APTS da por `stalled` una tarea que lleva quince minutos sin señal, y una story tarda más
que eso. Mientras el agente trabaja, el conductor manda `heartbeat` cada cinco minutos.

Antes no podía: `spawnSync` bloqueaba el proceso entero, así que la vigilancia de fondo
marcaba la tarea y el conductor tenía que reanimarla al cerrarla. Ese remiendo sigue en el
código como red de seguridad, pero ya no es el camino normal.

## Órdenes desde el panel

La pestaña **Conductor** de un proyecto deja órdenes en un buzón —**Iniciar**, **Pausar**,
**Reanudar**— dirigidas al `--agent-name` con el que corre el conductor. El conductor
pregunta cada diez segundos, también mientras el agente trabaja.

Eran cuatro hasta el 2026-08-08: había además un **Detener** que encolaba `stop`. No era una
orden distinta —cortaba el árbol del agente, terminaba esa corrida y devolvía el conductor a
la espera, exactamente igual que `pause`, y lo único que cambiaba era la etiqueta del motivo
en el diario—, así que se unificó en Pausar. Se unificó en ese sentido y no en el otro porque
el panel no arranca conductores: apagar el proceso desde ahí dejaría el buzón sin nadie al
otro lado. El conductor **sigue entendiendo `stop`** —lo que sigue es este script, sin
cambios— por si habla con un APTS anterior a esa fecha; lo que ya no lo acepta es el panel.

No hay socket a propósito: para un botón que pulsa una persona, diez segundos son
indistinguibles de instantáneo, y un servidor de WebSocket sería una pieza más —conexión,
reconexión, autenticación— a cambio de una latencia que nadie nota.

Al recibir `stop` o `pause`, el conductor mata **el árbol de procesos** del agente y para
con código 15. En Windows eso es `taskkill /t`: `shell: true` interpone `cmd.exe`, así que
matar el pid del hijo dejaría al agente vivo escribiendo en APTS mientras el conductor cree
que lo detuvo. En POSIX el agente se lanza con grupo propio (`detached`) y se mata el grupo,
con diez segundos de gracia (`APTS_LOOP_KILL_GRACE_MS`) antes de forzar con `SIGKILL`.

**El conductor no para hasta que el árbol está muerto**, y esa espera es la parte que hace
falta escribir bien. Lo que se mira para saber si el corte terminó es si el **grupo** sigue
vivo (`kill(-pgid, 0)`), no si terminó el hijo directo: el hijo directo es el shell, y es
precisamente lo primero que se va con el `SIGTERM`, así que preguntarle a él daría por
rematado un corte que aún no lo está. Y la gracia se espera dentro del corte, no en un
temporizador suelto: un temporizador no retiene a un proceso que está a punto de salir. Un
agente que ignore `SIGTERM` sobrevive los diez segundos, ve la línea «el árbol del agente
sigue vivo tras 10 s; forzando» y muere; uno que coopere se va en menos de un segundo y no
paga la espera.

Cortar a mitad de una story no rompe nada: se comporta igual que un agente que muere. El
claim es idempotente y el motor vuelve a servir el mismo paso mientras el puntero siga
corriendo, así que la corrida siguiente retoma esa misma historia.

## Modo espera

`--daemon` —o invocar el script **sin ningún argumento**— no conduce nada todavía: se
conecta a APTS y espera una orden de `start`, que trae el proyecto, el comando del agente
y, si se quiere, los workflows y el escalado de modelo.

La identidad (`--mcp-url`, `--api-key`, `--agent-name`, `--agent-email`) sigue siendo
obligatoria: sin ella no hay a quién preguntar. Lo que se relaja es sólo lo que la orden
puede traer. Un `--project-url` sin `--agent-cmd` sigue siendo error de configuración, para
que una invocación mal escrita no se quede colgada en silencio.

Una parada en modo espera termina esa corrida, no el proceso: el conductor vuelve a
escuchar, y volver a arrancarlo desde el panel es la misma sesión.

### Reanudar

`resume` es un `start` que no trae configuración: repite la de la **última corrida de ese
proceso**. Es lo que hace que retomar un `pause` sea un botón y no volver a escribir el
comando del agente, que es la parte larga del formulario y la que se escribe mal.

Lo que recuerda es el proceso, no APTS, y eso es deliberado: `--agent-cmd` invoca un
binario **de la máquina donde corre el conductor**, así que una configuración guardada en
el servidor podría llegarle a otra máquina donde ese comando no existe. Un conductor recién
arrancado no tiene nada que reanudar aunque el proyecto sí tenga historia: rechaza la orden
(`cancelled`, «no hay corrida anterior que reanudar») y lo dice por el diario.

Se recuerda la configuración al componerla y no al terminar bien, así que una corrida que
murió a mitad —agente fallido, tope de vueltas, estancamiento— también se reanuda. Un
`resume` que llega **mientras el agente trabaja** no es nada: se acusa y se descarta, en
vez de quedarse en el buzón por delante de la orden de parar.
