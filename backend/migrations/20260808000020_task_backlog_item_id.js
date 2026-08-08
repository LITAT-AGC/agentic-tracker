// `backlog_item_id` en tasks: de que unidad fue esta ejecucion.
//
// Hasta aqui el vinculo entre una tarea y su historia existia solo del otro lado y en
// singular: `backlog_items.active_task_id`. Eso mezclaba dos cosas distintas.
//
// La primera, que no habia historial. `register_task` con `backlog_item_id` pisa
// `active_task_id`, asi que la ejecucion anterior quedaba huerfana, sin ninguna
// asociacion. Se podia preguntar "la tarea de ahora", nunca "todas las ejecuciones de
// esta historia".
//
// La segunda, que ese mismo puntero es lo que dispara la propagacion de estado:
// `update_task_status` actualiza los items cuyo `active_task_id` sea esa tarea. Asociar
// implicaba, sin poder evitarlo, poder cerrar: una tarea ligada que pasa a `done` pone la
// historia en `done` saltandose la compuerta de revision del paso terminal de
// `bmad-dev-story`. Por eso el conductor no ligaba su tarea, y pagaba el precio de la
// primera.
//
// Esta columna es la mitad informativa, y solo esa: permanente, sin efectos, y ninguna
// escritura de `backlog_items` la mira. La propiedad sigue siendo `active_task_id` y sigue
// siendo lo unico que propaga.
//
// La referencia circular entre las dos tablas es legal porque las dos columnas son
// nulables. `SET NULL` es simetrico al que ya trae `active_task_id` (migracion 004) y casi
// nunca corre: el borrado de backlog es blando.

exports.up = async (knex) => {
  await knex.schema.alterTable('tasks', (t) => {
    t.uuid('backlog_item_id').references('id').inTable('backlog_items').onDelete('SET NULL');
    t.index(['backlog_item_id']);
  });

  // Backfill de lo unico reconstruible: las tareas que su historia todavia apunta. Las que
  // un `register_task` posterior desbanco no dejaron ningun rastro relacional, y no hay
  // forma honesta de recuperarlas. El recuento se imprime sin adornar: lo que queda en
  // NULL es historia perdida antes de esta migracion, no un fallo del backfill.
  const recovered = await knex('tasks')
    .update({
      backlog_item_id: knex('backlog_items')
        .select('id')
        .where('backlog_items.active_task_id', knex.ref('tasks.id'))
        .limit(1)
    })
    .whereNull('backlog_item_id')
    .whereExists(
      knex('backlog_items').select(knex.raw('1')).where('backlog_items.active_task_id', knex.ref('tasks.id'))
    );

  const [{ count: orphans }] = await knex('tasks').whereNull('backlog_item_id').count({ count: '*' });

  console.log(`[020] backlog_item_id recuperado en ${recovered} tarea(s); ${orphans} sin asociacion posible.`);
};

exports.down = async (knex) => {
  await knex.schema.alterTable('tasks', (t) => {
    t.dropColumn('backlog_item_id');
  });
};
