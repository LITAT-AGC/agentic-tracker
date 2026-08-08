Implementa UNA unidad de trabajo de una iniciativa BMAD conducida por APTS.

Actúa siempre como agent_name "{agent_name}". Esa identidad sostiene el claim de la
unidad: no la cambies ni la inventes en los payloads.

Unidad asignada: story {story_id} (proyecto {project_url}).

Tarea de ejecución en APTS: {task_id}. Si eso trae un identificador, ésa es tu tarea: úsala
para `log_agent_progress`, `heartbeat` y `report_blocker`, y NO registres otra. La abrió el
conductor asociada a la unidad pero SIN poseerla (`owns_backlog_item: false`), a propósito:
`update_task_status` arrastra al item cuya tarea activa sea ésa, así que cerrar una tarea
que lo posee pondría la historia en `done` sin pasar por la compuerta de revisión. Si
registrás otra, la tuya sí lo poseería. Manda `heartbeat` de vez en cuando —a los quince minutos sin señal
APTS la da por `stalled`—. Si dice `(ninguna)`, registrá la tuya como siempre.

Antes de nada, lee `method_conduction` del manifiesto público (GET /api/public/integrar)
y sigue `dev_story_completion_rule` al pie. Es autoritativo; si algo de este prompt lo
contradice, gana el manifiesto.

En resumen de lo que se espera de ti:
1. `apts_workflow_step` para que el servidor te sirva el paso actual.
2. Haz lo que el paso pide y entrégalo con `apts_submit_step`. Cada submit avanza un
   paso, salvo que declares una rama (ver CONTROL DE FLUJO).
3. Repite hasta que la unidad quede cerrada (`workflow_complete` / `iterable_unit_done`),
   entregando `output: { status: "done", code_ref: "<hash del commit>" }` en el paso que
   declara el output de estado.
4. Si no puedes continuar, reporta el bloqueo en APTS y detente. NO cierres la story
   como done.

ELICITACIÓN. El paso de entrada de dev-story llega con `mode: "await_input"` y preguntas
de BMAD del tipo "¿qué story quieres desarrollar?". Bajo APTS esa pregunta ya está
respondida: el motor te asignó la story {story_id}. Reanuda tú mismo llamando otra vez a
`apts_workflow_step` con `answers` apuntando a esa story; no pares a preguntarle a nadie.
Esa licencia es SÓLO para lo que la asignación ya determina. Si un paso posterior elicita
algo que la asignación no decide, no lo inventes: reporta el bloqueo y detente.

CONTROL DE FLUJO. El payload del paso puede traer `control_flow` con `branches` —las
ramas que el método declara— y `conditions`, las condiciones en prosa que las gobiernan.
Con `enforced: true` el cursor del motor las aplica, pero no las decide: el motor no
puede evaluar "ANY validation fails" porque no ve tu árbol de trabajo. Lo decides tú y
lo declaras al entregar:

  `output: { control: {"goto":"step:5"}, control_why: "los tests de X siguen rojos" }`
  `output: { control: "HALT", control_why: "no puedo resolver el conflicto de esquema" }`

Reglas:
- `control` debe ser un elemento LITERAL de `branches`, copiado tal cual. Cualquier otra
  cosa se rechaza con `ok:false` y no captura nada.
- Sin `control`, el cursor avanza al paso siguiente: es el camino normal y no hace falta
  declarar nada para tomarlo.
- `{"goto":"step:N"}` mueve el cursor a ese paso, también hacia atrás — así se vuelve a
  implementar cuando la validación falla, que es justo lo que el paso 8 de dev-story
  declara. Los saltos hacia atrás están topados por unidad: agotado el tope, el motor
  degrada el salto a HALT y responde `halted:true` diciéndolo.
- `HALT` NO avanza el cursor y conserva lo ya capturado. Declararlo es parar: reporta
  además el bloqueo en APTS y termina la sesión. No lo uses para hacer una pausa.
- Un paso puede traer `conditions` y ninguna rama honrable. Ahí no hay nada que declarar:
  son guía del método, no una promesa del motor.

REVISIÓN ADVERSARIA. El paso 8 de dev-story ("Validate and mark task complete ONLY when
fully done") no se entrega hasta que el trabajo de ESTA unidad haya pasado una revisión
adversaria. No es un repaso de cortesía ni un extra: es parte de esa validación, y sin
ella el paso 8 no está hecho.

Lanza las TRES capas A LA VEZ, cada una en su propio subagente, en una sola tanda de
llamadas paralelas. Van en subagentes y no en tu propio hilo por una razón concreta:
acabas de escribir este código, y aquí dentro ya no puedes hacerte el ciego. Una capa
que hereda tu contexto hereda también tus puntos ciegos, y entonces no revisa: te da la
razón.

- Blind Hunter. Dale SÓLO el diff de esta unidad (`git diff` contra el punto de partida,
  más los archivos nuevos). Nada de story, nada de criterios de aceptación, nada de
  intención. Que juzgue el código por lo que hace, no por lo que se suponía que hacía.
- Edge Case Hunter. Dale el diff y los archivos que toca. Que busque los bordes:
  entradas vacías o nulas, límites de índice y de buffer, tamaños o tasas distintos de
  los probados, NaN / infinitos / denormales, división por cero, reentrada y orden de
  inicialización, rutas de error que ningún test recorre, estado que sobrevive entre
  llamadas.
- Acceptance Auditor. Dale SÓLO la story y sus criterios de aceptación. Que recorra
  criterio por criterio contra el código real y diga cuáles no están implementados,
  cuáles lo están a medias y cuáles quedaron implementados en otro sitio del que dice
  la story.

Cada capa devuelve su lista de hallazgos y nada más: sin resumen de lo que leyó, sin
plan de trabajo, sin valoración general. Lo que no sea un hallazgo no hace falta.

TRIAGE. Un hallazgo cuenta como CONFIRMADO sólo si trae las dos cosas:
- `archivo:línea` donde está, y
- un escenario de fallo concreto: qué entrada o qué estado produce qué comportamiento
  incorrecto.

Lo que no llega a eso —gusto, nombres, estructura, "quedaría más limpio si"— es RUIDO:
se anota y NO se corrige. Estás cerrando una unidad, no reescribiendo el proyecto a tu
gusto. Si dos capas señalan lo mismo, es UN hallazgo, no dos.

QUÉ HACER CON LO CONFIRMADO. Si queda al menos un hallazgo confirmado, la validación del
paso 8 ha fallado y no se entrega limpia. Declara la rama que el propio método tiene
para eso, copiada literal de `branches`:

  `output: { control: {"goto":"step:5"}, control_why: "revisión adversaria: N hallazgos confirmados — <una línea>" }`

y vuelve a implementar corrigiéndolos. Los saltos hacia atrás están topados por unidad:
si se agota el tope el motor degrada a HALT, y eso es lo correcto — una unidad que no
sobrevive a las pasadas de revisión no se cierra como done, se reporta como bloqueo. No
esquives el tope corrigiendo en silencio para llegar al submit terminal. Si el paso 8 no
te sirve esa rama en `branches`, corrige antes de entregarlo y dilo en el archivo de
revisión.

Si no queda ningún hallazgo confirmado, entrega el paso 8 por el camino normal.

RASTRO. La revisión se escribe una vez y viaja por dos caminos. Corta y sin adornos:
- la story y el commit revisado;
- una línea por capa, con cuántos hallazgos confirmó;
- los CONFIRMADOS: `archivo:línea`, escenario de fallo, y qué se hizo con cada uno;
- los ANOTADOS, una línea cada uno, sin desarrollar.

Los dos caminos:
1. `docs/reviews/{story_id}.md` en el repositorio, commiteado junto con el trabajo de la
   unidad.
2. En el submit terminal, dentro del mismo `output` que cierra la unidad:
   `output: { status: "done", code_ref: "<hash>", title: "<título>", content: "<la revisión>" }`.
   El paso terminal declara ese artefacto como `code_review` de ESTA unidad, y donde el
   motor ya tiene la compuerta el submit sin `content` se rechaza con `ok:false` y la
   story no cierra. Mira los `outputs[]` que te sirve el paso: son la verdad sobre lo que
   ese paso espera.

Si volviste al paso 5, la revisión se rehace con la pasada nueva; el archivo se actualiza,
no se duplica ni se crea uno por vuelta.

No toques el ciclo más allá de esta unidad: no arranques iniciativas, no conduzcas
fases generativas y no cierres otras stories.
