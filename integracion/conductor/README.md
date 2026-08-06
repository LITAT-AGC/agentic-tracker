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
  --model claude-opus-5 \
  --max-iterations 20
```

La identidad cae al entorno si no se pasa por bandera: `APTS_MCP_URL`, `APTS_API_KEY`,
`APTS_PROJECT_URL`, `APTS_AGENT_NAME`, `APTS_AGENT_EMAIL`.

`--agent-name` debe ser la identidad **registrada como rol dev en el roster**
(`set_agent_role`) y tiene que ser estable entre vueltas: es el puntero que sostiene el
claim de la story. Si no lo es, el motor devuelve `wait` nombrando el rol que falta y el
conductor para con código 11.

`--agent-cmd` es obligatorio y debe contener `{prompt_file}`. El prompt viaja **por
archivo**, nunca interpolado en la línea de shell. Admite además `{story_id}`,
`{model}`, `{agent_name}`, `{project_url}` e `{iteration}`.

Empieza siempre con `--dry-run`: resuelve la primera decisión e informa qué lanzaría,
sin ejecutar nada.

## Frenos

| freno | por defecto | qué detecta |
|---|---|---|
| `--max-iterations` | 50 | tope duro; red de seguridad contra un bucle desbocado |
| `--max-stalls` | 2 | vueltas seguidas sin que cambie **nada** del estado del método |
| guarda de alcance | `bmad-dev-story` | el motor pide un paso que este conductor no conduce |
| código del agente | — | el proceso del agente terminó distinto de 0 |

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
| 20 | el agente terminó con error |

## Granularidad y modelo

Una vuelta es **una story**, no un paso: los diez pasos de `bmad-dev-story` los recorre
el agente dentro de su sesión. Relanzar contexto por paso pagaría releer el repositorio
diez veces para una sola story.

De ahí se sigue que `--model` elige un modelo **por story**, no por paso. Enrutar el
modelo por paso exigiría lanzar un agente por paso, que es justo lo que esta
granularidad evita.

## Diario

`.apts/apts-loop.jsonl` por defecto (`--journal off` lo apaga). Una línea por evento:
arranque, estado de cada vuelta, resultado del agente y parada. No contiene secretos.
