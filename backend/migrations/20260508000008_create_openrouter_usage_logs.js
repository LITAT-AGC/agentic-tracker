exports.up = async (knex) => {
  await knex.schema.createTable('openrouter_usage_logs', (t) => {
    t.increments('id');
    t.string('usage_type').notNullable();
    t.string('model').notNullable();
    t.string('project_url');
    t.uuid('backlog_item_id').references('id').inTable('backlog_items').onDelete('SET NULL');
    t.integer('prompt_tokens').notNullable().defaultTo(0);
    t.integer('completion_tokens').notNullable().defaultTo(0);
    t.integer('total_tokens').notNullable().defaultTo(0);
    t.float('cost').notNullable().defaultTo(0);
    t.boolean('is_byok');
    t.jsonb('raw_usage');
    t.timestamps(true, true);

    t.index(['created_at']);
    t.index(['usage_type', 'created_at']);
    t.index(['project_url', 'created_at']);
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTable('openrouter_usage_logs');
};