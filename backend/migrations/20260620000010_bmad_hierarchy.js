// F0-T1 — Jerarquía BMAD: initiatives -> epics -> backlog_items(stories).
// Decisiones aplicadas: enums en snake_case (ready_for_dev); backlog_items gana
// initiative_id Y epic_id (ambos nullable) para soportar backlog plano / Quick Flow / Method.

const BACKLOG_STATUSES_OLD = ['draft', 'needs_details', 'ready', 'in_progress', 'review', 'blocked', 'done', 'archived'];
const BACKLOG_STATUSES_NEW = ['draft', 'needs_details', 'ready', 'ready_for_dev', 'in_progress', 'review', 'blocked', 'done', 'archived'];

const swapStatusCheck = (knex, statuses) => knex.raw(`
  ALTER TABLE backlog_items DROP CONSTRAINT IF EXISTS backlog_items_status_check;
  ALTER TABLE backlog_items ADD CONSTRAINT backlog_items_status_check
    CHECK (status IN (${statuses.map((s) => `'${s}'`).join(', ')}));
`);

exports.up = async (knex) => {
  await knex.schema.createTable('initiatives', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.string('project_url').notNullable()
      .references('url').inTable('projects').onDelete('CASCADE');
    t.string('title').notNullable();
    t.text('description');
    t.enu('track', ['quick', 'method', 'enterprise']).notNullable().defaultTo('method');
    t.enu('phase', ['analysis', 'planning', 'solutioning', 'implementation', 'done'])
      .notNullable().defaultTo('analysis');
    t.enu('status', ['active', 'completed', 'archived']).notNullable().defaultTo('active');
    // prd_artifact_id apunta a semantic_documents; FK se agrega tras extenderla en F0-T2
    // para evitar acoplar el orden de migraciones. Por ahora columna libre.
    t.uuid('prd_artifact_id');
    t.timestamps(true, true);

    t.index(['project_url', 'status']);
    t.index(['project_url', 'phase']);
  });

  await knex.schema.createTable('epics', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('initiative_id').notNullable()
      .references('id').inTable('initiatives').onDelete('CASCADE');
    t.string('project_url').notNullable()
      .references('url').inTable('projects').onDelete('CASCADE');
    t.string('title').notNullable();
    t.text('goal');
    // status derivado de hijos (cache mantenido por el motor en F1; en F0 sólo existe).
    t.enu('status', ['planned', 'in_progress', 'done', 'archived']).notNullable().defaultTo('planned');
    t.integer('priority').notNullable().defaultTo(100);
    t.integer('sort_order').notNullable().defaultTo(0);
    t.timestamps(true, true);

    t.index(['initiative_id', 'status']);
    t.index(['project_url', 'priority', 'sort_order']);
  });

  await knex.schema.alterTable('backlog_items', (t) => {
    t.uuid('initiative_id').references('id').inTable('initiatives').onDelete('SET NULL');
    t.uuid('epic_id').references('id').inTable('epics').onDelete('SET NULL');
  });

  await knex.schema.alterTable('backlog_items', (t) => {
    t.index(['initiative_id', 'status']);
    t.index(['epic_id', 'status']);
  });

  if (knex.client.config.client === 'pg') {
    await swapStatusCheck(knex, BACKLOG_STATUSES_NEW);
  }
};

exports.down = async (knex) => {
  if (knex.client.config.client === 'pg') {
    await knex('backlog_items').where({ status: 'ready_for_dev' }).update({ status: 'ready' });
    await swapStatusCheck(knex, BACKLOG_STATUSES_OLD);
  }

  await knex.schema.alterTable('backlog_items', (t) => {
    t.dropIndex(['initiative_id', 'status']);
    t.dropIndex(['epic_id', 'status']);
    t.dropColumn('initiative_id');
    t.dropColumn('epic_id');
  });

  await knex.schema.dropTableIfExists('epics');
  await knex.schema.dropTableIfExists('initiatives');
};
