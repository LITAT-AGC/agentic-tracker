// F0-T2 — Artefactos tipados sobre semantic_documents + action_items (retros).
// Decision: extension in-place, una fila por scope (unique existente intacto),
// version = contador monotonico (sin historial multi-version en F0).

exports.up = async (knex) => {
  await knex.schema.alterTable('semantic_documents', (t) => {
    t.enu('doc_type', ['prd', 'architecture', 'epics', 'story_spec', 'retro']); // nullable: docs previos no son artefactos
    t.integer('version').notNullable().defaultTo(1);
    t.uuid('initiative_id').references('id').inTable('initiatives').onDelete('SET NULL');
  });

  await knex.schema.alterTable('semantic_documents', (t) => {
    t.index(['initiative_id', 'doc_type']);
  });

  // Ahora que semantic_documents existe estable, cerramos la FK diferida de initiatives.
  await knex.schema.alterTable('initiatives', (t) => {
    t.foreign('prd_artifact_id').references('id').inTable('semantic_documents').onDelete('SET NULL');
  });

  await knex.schema.createTable('action_items', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.string('project_url').notNullable()
      .references('url').inTable('projects').onDelete('CASCADE');
    t.uuid('initiative_id').references('id').inTable('initiatives').onDelete('SET NULL');
    t.uuid('epic_id').references('id').inTable('epics').onDelete('SET NULL');
    t.uuid('source_artifact_id').references('id').inTable('semantic_documents').onDelete('SET NULL');
    t.text('action').notNullable();
    t.string('owner');
    t.enu('status', ['open', 'in_progress', 'done']).notNullable().defaultTo('open');
    t.timestamps(true, true);

    t.index(['initiative_id', 'status']);
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('action_items');

  await knex.schema.alterTable('initiatives', (t) => {
    t.dropForeign('prd_artifact_id');
  });

  await knex.schema.alterTable('semantic_documents', (t) => {
    t.dropIndex(['initiative_id', 'doc_type']);
    t.dropColumn('doc_type');
    t.dropColumn('version');
    t.dropColumn('initiative_id');
  });
};
