// Órdenes para el conductor del bucle.
//
// Hasta ahora, detener una corrida era matar el proceso a mano en la máquina donde
// corriera: el panel podía ver lo que pasaba y no podía tocarlo. Esta tabla es el buzón
// —el conductor pregunta cada diez segundos si hay algo para él— y no un canal en vivo,
// porque para un botón que pulsa una persona diez segundos son indistinguibles de
// instantáneo y un WebSocket sería una pieza más de infraestructura a cambio de nada.
//
// `agent_name` es el destinatario: identifica al conductor igual que en el resto de la
// API de agente. `project_url` es nullable porque la orden de arranque puede dirigirse a
// un conductor en espera, que todavía no está en ningún proyecto —de hecho el proyecto se
// lo dice esta misma orden, dentro de `payload`.

exports.up = async (knex) => {
  await knex.schema.createTable('conductor_orders', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.string('project_url').references('url').inTable('projects').onDelete('SET NULL');
    t.string('agent_name').notNullable();
    t.enu('command', ['start', 'stop', 'pause', 'resume']).notNullable();
    t.jsonb('payload');
    t.enu('status', ['pending', 'acked', 'done', 'cancelled']).notNullable().defaultTo('pending');
    t.text('detail');
    t.timestamp('acked_at');
    t.timestamps(true, true);

    // Por lo único que se consulta: la más vieja pendiente de un conductor.
    t.index(['agent_name', 'status', 'created_at']);
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('conductor_orders');
};
