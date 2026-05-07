exports.up = async (knex) => {
  await knex.schema.alterTable('backlog_items', (t) => {
    t.text('bug_embedding');
    t.string('bug_embedding_model');
    t.float('bug_embedding_norm');
    t.timestamp('bug_embedding_updated_at');
  });

  await knex.schema.alterTable('backlog_items', (t) => {
    t.index(['project_url', 'item_type', 'status']);
    t.index(['project_url', 'item_type', 'deleted_at']);
  });
};

exports.down = async (knex) => {
  await knex.schema.alterTable('backlog_items', (t) => {
    t.dropIndex(['project_url', 'item_type', 'status']);
    t.dropIndex(['project_url', 'item_type', 'deleted_at']);
    t.dropColumn('bug_embedding');
    t.dropColumn('bug_embedding_model');
    t.dropColumn('bug_embedding_norm');
    t.dropColumn('bug_embedding_updated_at');
  });
};
