// F0-T3 — Registros del metodo (editable-by-design, multi-agente).
// entities / workflow_definitions / workflow_steps / primitives_palette: biblioteca GLOBAL
// (sin project_url), reutilizable entre flujos/proyectos (semilla BMAD).
// project_state: puntero de ejecucion POR AGENTE (la fase macro vive en initiatives.phase).

exports.up = async (knex) => {
  await knex.schema.createTable('entities', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.string('key').notNullable().unique();
    t.string('name').notNullable();
    t.enu('kind', ['role', 'persona', 'elicitation', 'other']).notNullable().defaultTo('role');
    t.text('persona');
    t.text('principles');
    t.text('communication_style');
    t.text('instruction');
    t.jsonb('metadata');
    t.string('source_ref');
    t.timestamps(true, true);
  });

  await knex.schema.createTable('primitives_palette', (t) => {
    t.string('key').primary();
    t.string('name').notNullable();
    t.text('description');
    t.enu('category', ['gate', 'router', 'aggregate']);
    t.jsonb('params_schema');
    t.boolean('implemented').notNullable().defaultTo(false);
    t.string('handler_ref');
    t.jsonb('metadata');
    t.timestamps(true, true);
  });

  await knex.schema.createTable('workflow_definitions', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.string('key').notNullable().unique();
    t.string('name').notNullable();
    t.text('description');
    t.enu('phase', ['analysis', 'planning', 'solutioning', 'implementation']);
    t.jsonb('tracks');
    t.uuid('default_entity_id').references('id').inTable('entities').onDelete('SET NULL');
    t.enu('status', ['active', 'draft', 'archived']).notNullable().defaultTo('active');
    t.jsonb('metadata');
    t.string('source_ref');
    t.timestamps(true, true);
  });

  await knex.schema.createTable('workflow_steps', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('workflow_id').notNullable()
      .references('id').inTable('workflow_definitions').onDelete('CASCADE');
    t.string('key').notNullable();
    t.integer('step_order').notNullable();
    t.text('goal');
    t.enu('kind', ['generative', 'deterministic']).notNullable();
    t.text('instruction_chunk'); // solo generative (prompt importado verbatim)
    t.text('template_slice');
    t.string('primitive_key').references('key').inTable('primitives_palette').onDelete('SET NULL');
    t.uuid('entity_id').references('id').inTable('entities').onDelete('SET NULL'); // rol que ejecuta
    t.jsonb('needs');
    t.jsonb('outputs');
    t.jsonb('next_rules');
    t.boolean('iterable').notNullable().defaultTo(false);
    t.jsonb('metadata');
    t.timestamps(true, true);

    t.unique(['workflow_id', 'key']);
    t.index(['workflow_id', 'step_order']);
  });

  await knex.schema.createTable('project_state', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('initiative_id').notNullable()
      .references('id').inTable('initiatives').onDelete('CASCADE');
    t.string('project_url').notNullable()
      .references('url').inTable('projects').onDelete('CASCADE');
    t.string('agent_name').notNullable();
    t.string('agent_email');
    t.uuid('entity_id').references('id').inTable('entities').onDelete('SET NULL'); // rol asignado
    t.uuid('current_workflow_id').references('id').inTable('workflow_definitions').onDelete('SET NULL');
    t.uuid('current_step_id').references('id').inTable('workflow_steps').onDelete('SET NULL');
    t.enu('step_status', ['idle', 'running', 'await_input', 'blocked', 'done'])
      .notNullable().defaultTo('idle');
    t.jsonb('cursor');
    t.datetime('last_heartbeat');
    t.timestamps(true, true);

    t.unique(['initiative_id', 'agent_name']); // un puntero por agente por iniciativa = sin colision
    t.index(['initiative_id', 'entity_id']);
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('project_state');
  await knex.schema.dropTableIfExists('workflow_steps');
  await knex.schema.dropTableIfExists('workflow_definitions');
  await knex.schema.dropTableIfExists('primitives_palette');
  await knex.schema.dropTableIfExists('entities');
};
