exports.up = async (knex) => {
  await knex.schema.createTable('semantic_documents', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.string('project_url').notNullable()
      .references('url').inTable('projects').onDelete('CASCADE');
    t.string('strategy_key').notNullable();
    t.string('scope_key').notNullable();
    t.string('source_type').notNullable();
    t.string('source_id');
    t.string('title');
    t.text('content').notNullable();
    t.jsonb('document_metadata');
    t.string('content_hash').notNullable();
    t.timestamps(true, true);

    t.unique(['project_url', 'strategy_key', 'scope_key']);
    t.index(['project_url', 'strategy_key']);
    t.index(['strategy_key', 'source_type']);
  });

  await knex.schema.createTable('semantic_document_embeddings', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('semantic_document_id').notNullable()
      .references('id').inTable('semantic_documents').onDelete('CASCADE');
    t.string('strategy_key').notNullable();
    t.string('embedding_model').notNullable();
    t.text('embedding').notNullable();
    t.float('embedding_norm').notNullable();
    t.string('generated_from_hash').notNullable();
    t.timestamp('embedded_at').notNullable().defaultTo(knex.fn.now());
    t.timestamps(true, true);

    t.unique(['semantic_document_id', 'embedding_model']);
    t.index(['strategy_key', 'embedding_model']);
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTable('semantic_document_embeddings');
  await knex.schema.dropTable('semantic_documents');
};