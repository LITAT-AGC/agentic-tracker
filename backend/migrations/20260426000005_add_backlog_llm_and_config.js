const BACKLOG_ITEM_TYPES = ['feature', 'bug', 'chore', 'research'];
const BACKLOG_STATUSES = ['draft', 'needs_details', 'ready', 'in_progress', 'review', 'blocked', 'done', 'archived'];

const createBacklogItemsTable = (knex, tableName) => knex.schema.createTable(tableName, (t) => {
  t.uuid('id').primary().defaultTo(knex.fn.uuid());
  t.string('project_url').notNullable()
    .references('url').inTable('projects').onDelete('CASCADE');
  t.string('title').notNullable();
  t.text('description');
  t.text('acceptance_criteria');
  t.enu('item_type', BACKLOG_ITEM_TYPES)
    .notNullable().defaultTo('feature');
  t.enu('status', BACKLOG_STATUSES)
    .notNullable().defaultTo('ready');
  t.integer('priority').notNullable().defaultTo(100);
  t.integer('sort_order').notNullable().defaultTo(0);
  t.string('source_kind');
  t.string('source_ref');
  t.uuid('active_task_id').references('id').inTable('tasks').onDelete('SET NULL');
  t.string('llm_analysis_model');
  t.text('llm_analysis_summary');
  t.text('llm_missing_details');
  t.float('llm_confidence');
  t.string('llm_recommendation_status');
  t.timestamp('llm_last_analyzed_at');
  t.timestamps(true, true);

  t.index(['project_url', 'status']);
  t.index(['project_url', 'priority', 'sort_order']);
});

const createLegacyBacklogItemsTable = (knex, tableName) => knex.schema.createTable(tableName, (t) => {
  t.uuid('id').primary().defaultTo(knex.fn.uuid());
  t.string('project_url').notNullable()
    .references('url').inTable('projects').onDelete('CASCADE');
  t.string('title').notNullable();
  t.text('description');
  t.text('acceptance_criteria');
  t.enu('item_type', BACKLOG_ITEM_TYPES)
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

const recreateBacklogTable = async (knex, createTableCallback, selectColumns) => {
  await knex.schema.renameTable('backlog_items', 'backlog_items_legacy');
  await knex.raw('DROP INDEX IF EXISTS backlog_items_project_url_status_index');
  await knex.raw('DROP INDEX IF EXISTS backlog_items_project_url_priority_sort_order_index');
  await createTableCallback(knex, 'backlog_items');
  await knex.raw(`
    INSERT INTO backlog_items (${selectColumns.join(', ')})
    SELECT ${selectColumns.join(', ')}
    FROM backlog_items_legacy
  `);
  await knex.schema.dropTable('backlog_items_legacy');
};

exports.up = async (knex) => {
  await knex.schema.createTable('config', (t) => {
    t.string('key').primary();
    t.text('value');
    t.timestamps(true, true);
  });

  const client = knex.client.config.client;

  if (client === 'pg') {
    await knex.raw("ALTER TABLE backlog_items DROP CONSTRAINT IF EXISTS backlog_items_status_check");
    await knex.raw("ALTER TABLE backlog_items ALTER COLUMN status TYPE text");
    await knex.raw(`ALTER TABLE backlog_items ADD CONSTRAINT backlog_items_status_check CHECK (status IN (${BACKLOG_STATUSES.map((status) => `'${status}'`).join(', ')}))`);
    await knex.schema.alterTable('backlog_items', (t) => {
      t.string('llm_analysis_model');
      t.text('llm_analysis_summary');
      t.text('llm_missing_details');
      t.float('llm_confidence');
      t.string('llm_recommendation_status');
      t.timestamp('llm_last_analyzed_at');
    });
    return;
  }

  await recreateBacklogTable(knex, createBacklogItemsTable, [
    'id',
    'project_url',
    'title',
    'description',
    'acceptance_criteria',
    'item_type',
    'status',
    'priority',
    'sort_order',
    'source_kind',
    'source_ref',
    'active_task_id',
    'created_at',
    'updated_at'
  ]);
};

exports.down = async (knex) => {
  const client = knex.client.config.client;

  if (client === 'pg') {
    await knex('backlog_items')
      .where({ status: 'needs_details' })
      .update({ status: 'draft' });
    await knex.schema.alterTable('backlog_items', (t) => {
      t.dropColumns(
        'llm_analysis_model',
        'llm_analysis_summary',
        'llm_missing_details',
        'llm_confidence',
        'llm_recommendation_status',
        'llm_last_analyzed_at'
      );
    });
    await knex.raw("ALTER TABLE backlog_items DROP CONSTRAINT IF EXISTS backlog_items_status_check");
    await knex.raw("ALTER TABLE backlog_items ALTER COLUMN status TYPE text");
    await knex.raw("ALTER TABLE backlog_items ADD CONSTRAINT backlog_items_status_check CHECK (status IN ('draft', 'ready', 'in_progress', 'review', 'blocked', 'done', 'archived'))");
  } else {
    await knex('backlog_items')
      .where({ status: 'needs_details' })
      .update({ status: 'draft' });
    await recreateBacklogTable(knex, createLegacyBacklogItemsTable, [
      'id',
      'project_url',
      'title',
      'description',
      'acceptance_criteria',
      'item_type',
      'status',
      'priority',
      'sort_order',
      'source_kind',
      'source_ref',
      'active_task_id',
      'created_at',
      'updated_at'
    ]);
  }

  await knex.schema.dropTable('config');
};