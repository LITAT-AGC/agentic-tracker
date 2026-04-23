exports.up = (knex) => knex.schema.createTable('agent_logs', (t) => {
  t.increments('id');
  t.uuid('task_id').references('id').inTable('tasks').onDelete('SET NULL');
  t.enu('action_type', ['read','write','update','error','heartbeat']);
  t.string('agent_name');
  t.string('branch');
  t.text('message').notNullable();
  t.jsonb('technical_details');
  t.timestamps(true, true);
});

exports.down = (knex) => knex.schema.dropTable('agent_logs');
