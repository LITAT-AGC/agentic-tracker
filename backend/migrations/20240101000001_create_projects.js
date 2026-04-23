exports.up = (knex) => knex.schema.createTable('projects', (t) => {
  t.string('url').primary();
  t.string('name').notNullable();
  t.text('description');
  t.enu('status', ['pending','active','blocked','stalled','completed'])
   .notNullable().defaultTo('pending');
  t.string('webhook_url');
  t.timestamps(true, true);
});

exports.down = (knex) => knex.schema.dropTable('projects');
