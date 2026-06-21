// F1-T1 — Fixture de flujo (toy) para de-riesgar el resolver `apts_next`.
// Pobla los registros GLOBALES del método (entities / primitives_palette /
// workflow_definitions / workflow_steps) con un lifecycle de 4 fases, y una
// INSTANCIA de prueba (project / initiative / epic / stories / project_state)
// para que el resolver tenga estado runtime que recorrer.
//
// Idempotente: borra lo de la fixture por claves naturales y reinserta.
// Ejecutar contra APTS_test:  node seeds/f1_toy_fixture.js
//
// Contrato de formas JSON que esta fixture FIJA (T2/T3 dependen de esto):
//   needs:        ["initiative", "epic", "story", ...]  (refs simbólicas)
//   outputs:      [{ kind:"artifact", doc_type:"prd" } | { kind:"backlog_items" } | ...]
//   next_rules:   generative -> null (avanza por step_order)
//                 gate       -> { on_pass:{goto}, on_fail:{goto} }  ("__phase_done__" = fin de fase)
//   metadata.primitive_params: valores del gate (F0 no tiene columna dedicada; metadata es el flex field)

const knex = require('knex')(require('../knexfile').test);
const { reconcilePrimitiveRegistry } = require('../scripts/lib/method_primitives');

// pg/knex no serializa arrays JS a jsonb automáticamente; stringify explícito.
const j = (v) => (v === undefined || v === null ? null : JSON.stringify(v));

const FIXTURE_PROJECT_URL = 'apts://fixture/toy';
const WORKFLOW_KEYS = ['toy-analysis', 'toy-planning', 'toy-solutioning', 'toy-implementation'];
const ENTITY_KEYS = ['analyst', 'pm', 'architect', 'sm', 'dev'];
const PRIMITIVE_KEYS = ['artifact-exists', 'count-threshold', 'all-children-status',
  'entity-status', 'count-compare', 'next-sibling-exists'];

const ENTITIES = [
  { key: 'analyst', name: 'Analyst', kind: 'role',
    persona: 'Analista de producto. Enmarca el problema y el contexto.',
    principles: 'Empezar por el porqué. Evidencia antes que opinión.',
    communication_style: 'Inquisitivo, conciso.' },
  { key: 'pm', name: 'Product Manager', kind: 'role',
    persona: 'PM. Traduce el brief en un PRD accionable.',
    principles: 'Alcance claro. Criterios de aceptación verificables.',
    communication_style: 'Directo, orientado a decisiones.' },
  { key: 'architect', name: 'Architect', kind: 'role',
    persona: 'Arquitecto. Define la solución técnica.',
    principles: 'Simple primero. Decisiones reversibles.',
    communication_style: 'Preciso, con trade-offs explícitos.' },
  { key: 'sm', name: 'Scrum Master', kind: 'role',
    persona: 'SM. Descompone el épica en historias listas para dev.',
    principles: 'Historias pequeñas e independientes.',
    communication_style: 'Facilitador.' },
  { key: 'dev', name: 'Developer', kind: 'role',
    persona: 'Dev. Implementa una historia a la vez.',
    principles: 'Tests primero. Una historia, un foco.',
    communication_style: 'Pragmático.' },
];

const PRIMITIVES = [
  { key: 'artifact-exists', name: 'Artifact exists', category: 'gate',
    description: 'Verdadero si la iniciativa tiene un artefacto del doc_type dado (o cualquiera si se omite).',
    params_schema: { doc_type: 'string?' }, implemented: false },
  { key: 'count-threshold', name: 'Count threshold', category: 'gate',
    description: 'Verdadero si el conteo de hijos del parent alcanza min.',
    params_schema: { parent: 'string', min: 'integer' }, implemented: false },
  { key: 'all-children-status', name: 'All children status', category: 'aggregate',
    description: 'Verdadero si TODOS los hijos del parent están en el status dado.',
    params_schema: { parent: 'string', status: 'string' }, implemented: false },
  // F3-T1: primitivas nuevas del catálogo balde 3 (needs_new). implemented lo
  // resuelve reconcilePrimitiveRegistry desde el registro en código.
  { key: 'entity-status', name: 'Entity status equals', category: 'gate',
    description: 'Verdadero si UNA entidad (story/epic/initiative) está en el status dado.',
    params_schema: { target: 'string', status: 'string' }, implemented: false },
  { key: 'count-compare', name: 'Count comparison', category: 'gate',
    description: 'Comparación numérica (>, >=, <, <=, ==, !=) de una métrica de estado contra un umbral.',
    params_schema: { metric: 'string', op: 'string', value: 'number' }, implemented: false },
  { key: 'next-sibling-exists', name: 'Next sibling exists', category: 'router',
    description: 'Verdadero si existe el hermano siguiente/anterior en la secuencia (épica/historia).',
    params_schema: { sequence: 'string', direction: 'string' }, implemented: false },
];

// Pasos por workflow. entity = key de entidad; primitive = key de primitiva.
const WORKFLOWS = [
  {
    key: 'toy-analysis', name: 'Toy · Analysis', phase: 'analysis', default_entity: 'analyst',
    description: 'Enmarcar el problema y producir el brief.',
    steps: [
      { key: 'draft-brief', step_order: 1, kind: 'generative', entity: 'analyst',
        goal: 'Escribir el Product Brief de la iniciativa.',
        instruction_chunk: '[toy] Redactá un brief: problema, usuarios, objetivos.',
        needs: ['initiative'], outputs: [{ kind: 'artifact', doc_type: 'brief' }], next_rules: null },
      { key: 'brief-gate', step_order: 2, kind: 'deterministic', primitive: 'artifact-exists',
        goal: 'El brief existe → analysis lista.',
        needs: ['initiative'], outputs: [],
        next_rules: { on_pass: { goto: '__phase_done__' }, on_fail: { goto: 'draft-brief' } },
        metadata: { primitive_params: { doc_type: 'brief' } } },
    ],
  },
  {
    key: 'toy-planning', name: 'Toy · Planning', phase: 'planning', default_entity: 'pm',
    description: 'Producir el PRD a partir del brief.',
    steps: [
      { key: 'draft-prd', step_order: 1, kind: 'generative', entity: 'pm',
        goal: 'Escribir el PRD.',
        instruction_chunk: '[toy] Redactá el PRD: alcance, requisitos, criterios de aceptación.',
        needs: ['initiative', 'brief'], outputs: [{ kind: 'artifact', doc_type: 'prd' }], next_rules: null },
      { key: 'prd-gate', step_order: 2, kind: 'deterministic', primitive: 'artifact-exists',
        goal: 'El PRD existe → planning lista.',
        needs: ['initiative'], outputs: [],
        next_rules: { on_pass: { goto: '__phase_done__' }, on_fail: { goto: 'draft-prd' } },
        metadata: { primitive_params: { doc_type: 'prd' } } },
    ],
  },
  {
    key: 'toy-solutioning', name: 'Toy · Solutioning', phase: 'solutioning', default_entity: 'architect',
    description: 'Definir la arquitectura.',
    steps: [
      { key: 'draft-architecture', step_order: 1, kind: 'generative', entity: 'architect',
        goal: 'Escribir el documento de arquitectura.',
        instruction_chunk: '[toy] Definí la arquitectura: componentes, datos, decisiones.',
        needs: ['initiative', 'prd'], outputs: [{ kind: 'artifact', doc_type: 'architecture' }], next_rules: null },
      { key: 'arch-gate', step_order: 2, kind: 'deterministic', primitive: 'artifact-exists',
        goal: 'La arquitectura existe → solutioning lista.',
        needs: ['initiative'], outputs: [],
        next_rules: { on_pass: { goto: '__phase_done__' }, on_fail: { goto: 'draft-architecture' } },
        metadata: { primitive_params: { doc_type: 'architecture' } } },
    ],
  },
  {
    key: 'toy-implementation', name: 'Toy · Implementation', phase: 'implementation', default_entity: 'sm',
    description: 'Descomponer en historias e implementarlas.',
    steps: [
      { key: 'create-stories', step_order: 1, kind: 'generative', entity: 'sm',
        goal: 'Descomponer el épica en historias listas para dev.',
        instruction_chunk: '[toy] Creá historias pequeñas e independientes bajo el épica.',
        needs: ['initiative', 'epic', 'prd'], outputs: [{ kind: 'backlog_items' }], next_rules: null },
      { key: 'story-count-gate', step_order: 2, kind: 'deterministic', primitive: 'count-threshold',
        goal: 'Hay al menos una historia → se puede implementar.',
        needs: ['epic'], outputs: [],
        next_rules: { on_pass: { goto: 'dev-story' }, on_fail: { goto: 'create-stories' } },
        metadata: { primitive_params: { parent: 'epic', min: 1 } } },
      { key: 'dev-story', step_order: 3, kind: 'generative', entity: 'dev', iterable: true,
        goal: 'Implementar una historia ready_for_dev (iterable, multi-agente).',
        instruction_chunk: '[toy] Implementá UNA historia y marcala done.',
        needs: ['initiative', 'epic', 'story'],
        outputs: [{ kind: 'code_ref' }, { kind: 'status', value: 'done' }], next_rules: null },
      { key: 'epic-done-gate', step_order: 4, kind: 'deterministic', primitive: 'all-children-status',
        goal: 'Todas las historias done → épica done → implementation lista.',
        needs: ['epic'], outputs: [],
        next_rules: { on_pass: { goto: '__phase_done__' }, on_fail: { goto: 'dev-story' } },
        metadata: { primitive_params: { parent: 'epic', status: 'done' } } },
    ],
  },
];

const PROJECT_STATES = [
  { agent_name: 'agent-pm', entity: 'pm' },
  { agent_name: 'agent-dev-1', entity: 'dev' },
  { agent_name: 'agent-dev-2', entity: 'dev' },
];

async function run() {
  await knex.transaction(async (trx) => {
    // ---- 1. Limpieza idempotente (instancia primero, luego registros) ----
    await trx('project_state').where({ project_url: FIXTURE_PROJECT_URL }).del();
    await trx('backlog_items').where({ project_url: FIXTURE_PROJECT_URL }).del();
    await trx('epics').where({ project_url: FIXTURE_PROJECT_URL }).del();
    await trx('initiatives').where({ project_url: FIXTURE_PROJECT_URL }).del();
    await trx('projects').where({ url: FIXTURE_PROJECT_URL }).del();
    await trx('workflow_definitions').whereIn('key', WORKFLOW_KEYS).del(); // cascade -> workflow_steps
    await trx('entities').whereIn('key', ENTITY_KEYS).del();
    await trx('primitives_palette').whereIn('key', PRIMITIVE_KEYS).del();

    // ---- 2. Entities ----
    const entityId = {};
    for (const e of ENTITIES) {
      const [row] = await trx('entities')
        .insert({ ...e, source_ref: 'fixture:f1-toy' }).returning('id');
      entityId[e.key] = row.id;
    }

    // ---- 3. Primitives ----
    await trx('primitives_palette').insert(PRIMITIVES.map((p) => ({ ...p, params_schema: j(p.params_schema) })));
    // Opción A: el registro en código es la fuente de verdad de qué está
    // implementado; reconciliamos implemented=true + handler_ref para las del registro.
    await reconcilePrimitiveRegistry(trx);

    // ---- 4. Workflow definitions + steps ----
    const workflowId = {};
    for (const w of WORKFLOWS) {
      const [wrow] = await trx('workflow_definitions').insert({
        key: w.key, name: w.name, description: w.description, phase: w.phase,
        tracks: j(['method']), default_entity_id: entityId[w.default_entity],
        status: 'active', source_ref: 'fixture:f1-toy',
      }).returning('id');
      workflowId[w.key] = wrow.id;

      for (const s of w.steps) {
        await trx('workflow_steps').insert({
          workflow_id: wrow.id, key: s.key, step_order: s.step_order, goal: s.goal,
          kind: s.kind, instruction_chunk: s.instruction_chunk || null,
          primitive_key: s.primitive || null, entity_id: s.entity ? entityId[s.entity] : null,
          needs: j(s.needs), outputs: j(s.outputs), next_rules: j(s.next_rules),
          iterable: s.iterable || false, metadata: j(s.metadata),
        });
      }
    }

    // ---- 5. Instancia de prueba ----
    await trx('projects').insert({ url: FIXTURE_PROJECT_URL, name: 'APTS Fixture · Toy Method' });

    const [initRow] = await trx('initiatives').insert({
      project_url: FIXTURE_PROJECT_URL, title: 'Toy Initiative',
      description: 'Iniciativa de juguete para de-riesgar apts_next.',
      track: 'method', phase: 'analysis', status: 'active',
      source_ref: 'fixture:f1-toy', // F3-T1.5: scopea el resolver a la librería toy
    }).returning('id');
    const initiativeId = initRow.id;

    const [epicRow] = await trx('epics').insert({
      initiative_id: initiativeId, project_url: FIXTURE_PROJECT_URL,
      title: 'Toy Epic', goal: 'Implementar las historias de juguete.',
      status: 'planned', priority: 100, sort_order: 0,
    }).returning('id');
    const epicId = epicRow.id;

    for (const title of ['Story A', 'Story B', 'Story C']) {
      await trx('backlog_items').insert({
        project_url: FIXTURE_PROJECT_URL, title, status: 'ready_for_dev',
        initiative_id: initiativeId, epic_id: epicId,
      });
    }

    for (const ps of PROJECT_STATES) {
      await trx('project_state').insert({
        initiative_id: initiativeId, project_url: FIXTURE_PROJECT_URL,
        agent_name: ps.agent_name, entity_id: entityId[ps.entity], step_status: 'idle',
      });
    }

    return { initiativeId, epicId };
  });
}

run()
  .then(async () => {
    // Resumen de verificación
    const counts = {};
    for (const t of ['entities', 'primitives_palette', 'workflow_definitions', 'workflow_steps']) {
      counts[t] = Number((await knex(t).count('* as c'))[0].c);
    }
    const instCounts = {};
    for (const t of ['initiatives', 'epics', 'backlog_items', 'project_state']) {
      instCounts[t] = Number((await knex(t).where({ project_url: FIXTURE_PROJECT_URL }).count('* as c'))[0].c);
    }
    console.log('OK — registros globales:', JSON.stringify(counts));
    console.log('OK — instancia fixture:', JSON.stringify(instCounts));
    await knex.destroy();
  })
  .catch(async (err) => {
    console.error('SEED FAILED:', err.message);
    await knex.destroy();
    process.exit(1);
  });
