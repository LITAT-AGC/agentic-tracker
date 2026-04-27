exports.up = async (knex) => {
  await knex.schema.alterTable('backlog_items', (t) => {
    t.timestamp('deleted_at').nullable();
  });

  await knex.schema.alterTable('backlog_items', (t) => {
    t.index(['project_url', 'deleted_at']);
  });
};

exports.down = async (knex) => {
  await knex.schema.alterTable('backlog_items', (t) => {
    t.dropIndex(['project_url', 'deleted_at']);
    t.dropColumn('deleted_at');
  });
};
