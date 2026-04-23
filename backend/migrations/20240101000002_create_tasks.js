exports.up = (knex) => knex.schema.createTable('tasks', (t) => {
  t.uuid('id').primary().defaultTo(knex.fn.uuid());
  t.string('project_url').notNullable()
   .references('url').inTable('projects').onDelete('CASCADE');
  t.string('title').notNullable();
  t.string('agent_name');
  t.string('agent_email');
  t.enu('status', ['todo','in_progress','review','done','stalled'])
   .notNullable().defaultTo('todo');
  t.text('context');
  t.datetime('last_heartbeat');
  t.timestamps(true, true);
});

exports.down = (knex) => knex.schema.dropTable('tasks');
