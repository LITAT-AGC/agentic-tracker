// Lo que el agente hace DENTRO de su sesión, mientras pasa.
//
// POR QUÉ NO ES `agent_logs`. Reusar esa tabla fue la decisión anterior para el diario del
// conductor y sigue siendo la correcta allí, pero aquí se rompe por tres sitios a la vez.
//
//   · Son dos registros distintos. `agent_logs` es el registro del MÉTODO —lo que un agente
//     reportó haber hecho, una fila por decisión— y esto es el registro de la EJECUCIÓN
//     —lo que pasó dentro de un proceso, cientos de filas por unidad—. Que las dos cosas
//     se escriban durante la misma media hora no las hace la misma cosa.
//   · El volumen. Esto son dos o tres órdenes de magnitud más filas: ~400 por story frente
//     a las 5 o 6 que deja hoy el diario. La pestaña Logs del panel carga los registros del
//     proyecto de una vez y ofrece un filtro por `action_type`; añadir esto ahogaría las
//     dos cosas —la tabla y su filtro— y el modo exacto en que un registro deja de servir
//     no es perder información, es sepultarla.
//   · La purga. Separarlas es lo único que permite tirar el registro de la ejecución sin
//     tocar el del método. Mezcladas, el borrado tendría que distinguir por `action_type`
//     dentro de la misma tabla, y un borrado que discrimina por una columna de texto es un
//     borrado que un día se lleva lo que no debía.
//
// FK A `tasks` Y NO A `backlog_items`. La tarea ES la ejecución: el conductor abre una por
// unidad y por pasada, así que dos corridas sobre la misma story son dos tareas y sus
// sesiones no se mezclan. La unidad se alcanza desde ahí por `tasks.backlog_item_id`, que
// existe justamente para eso. Es además el mismo `task_id` que exige el diario del
// conductor, por la misma razón: sin tarea no hay proyecto al que pertenecer, y una fila
// que nadie puede leer es peor que no escribirla.
//
// `ON DELETE CASCADE` porque el registro de la ejecución no sobrevive a la ejecución: si un
// día se borra una tarea, esto es residuo, no evidencia huérfana que valga la pena guardar.
//
// EL `seq` LO PONE EL CONDUCTOR, no el servidor. Es lo que hace que el panel pueda sondear
// con cursor (`?after_seq=`) sin depender de relojes ni de `created_at`, que empata cuando
// llegan veinticinco eventos en el mismo lote. Y hace el lote idempotente: reenviarlo choca
// contra el UNIQUE y no duplica nada. El `seq` puede tener HUECOS a propósito —el conductor
// descarta eventos por tope y por desbordón de su cola, y lo dice con un evento `recorte`—,
// así que quien lo lea no puede suponer que es denso.
//
// DOS RELOJES. `ts` es cuándo ocurrió, según la máquina que corre el agente; `created_at` es
// cuándo llegó, según el servidor. No se puede prescindir de ninguno: el primero es el único
// que ordena de verdad los eventos de una sesión, y el segundo es el único con el que se
// puede purgar sin fiarse del reloj de una máquina ajena.
//
// EL ÍNDICE ES EL UNIQUE. `(task_id, seq)` sirve exactamente la única consulta que hay
// —los eventos de una tarea a partir de un cursor, en orden— así que un segundo índice
// costaría escrituras sin contestar ninguna pregunta nueva.

exports.up = async (knex) => {
  await knex.schema.createTable('conductor_agent_events', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('task_id').notNullable().references('id').inTable('tasks').onDelete('CASCADE');
    t.integer('seq').notNullable();
    t.timestamp('ts', { useTz: true }).notNullable();
    t.string('kind').notNullable();
    t.jsonb('payload').notNullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.unique(['task_id', 'seq']);
    // Para la purga por antigüedad, que barre por fecha y no por tarea.
    t.index(['created_at']);
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('conductor_agent_events');
};
