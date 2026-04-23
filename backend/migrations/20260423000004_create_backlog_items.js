exports.up = (knex) => knex.schema.createTable('backlog_items', (t) => {
  t.uuid('id').primary().defaultTo(knex.fn.uuid());
  t.string('project_url').notNullable()
    .references('url').inTable('projects').onDelete('CASCADE');
  t.string('title').notNullable();
  t.text('description');
  t.text('acceptance_criteria');
  t.enu('item_type', ['feature', 'bug', 'chore', 'research'])
    .notNullable().defaultTo('feature');
  t.enu('status', ['draft', 'ready', 'in_progress', 'review', 'blocked', 'done', 'archived'])
    .notNullable().defaultTo('ready');
  t.integer('priority').notNullable().defaultTo(100);
  t.integer('sort_order').notNullable().defaultTo(0);
  t.string('source_kind');
  t.string('source_ref');
  t.uuid('active_task_id').references('id').inTable('tasks').onDelete('SET NULL');
  t.timestamps(true, true);

  t.index(['project_url', 'status']);
  t.index(['project_url', 'priority', 'sort_order']);
});

exports.down = (knex) => knex.schema.dropTable('backlog_items');