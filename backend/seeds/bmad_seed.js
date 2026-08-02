// F2-T2 — Loader idempotente del corpus BMAD (baldes 1–2 → DB).
// Vuelca la IR committeada (backend/importer/corpus/*.json) a los registros
// GLOBALES del método:
//   - entities            (BALDE 1: persona de cada agente)
//   - workflow_definitions (uno por workflow/agente-skill)
//   - workflow_steps       (BALDE 2: kind=generative, ADN verbatim por step)
//
// Separado de la fixture toy (source_ref distinto). Idempotente: borra-por
// source_ref `bmad:v6.8.0` y reinserta, SIN pisar la fixture (`fixture:f1-toy`)
// ni las primitivas implementadas (este loader NO toca primitives_palette = T3).
//
// Alcance: ADN generativo (baldes 1–2) + wiring per-step del goteo (F3-T2).
// Lo que queda explícitamente para fases posteriores (anotado en coverage/tracking):
//   - balde 3 (checks/routing → primitivas + next_rules deterministas) = T3
//   - entity_id POR-STEP (rol fino) sigue diferido; default_entity_id por workflow
//     se cableó en F3-T1.5 (desde menús de agente)
// F3-T2 cablea needs[]/outputs[]/iterable per-step vía scripts/importer/wiring.js
// (derivados de routing + la fuente única scripts/lib/method_outputs.js):
//   - outputs[]  → SOLO el paso terminal lleva el output del workflow (coherente con
//                  la completitud a nivel-workflow de T1.5, por construcción).
//   - needs[]    → artefactos upstream (routing.preceded_by); el goteo reinyecta un
//                  slice acotado por need en serve-time (costo-B).
//   - iterable   → ejecutor per-historia (dev-story).
// next_rules sigue null (generative avanza por step_order; gates/routing = T3).
// El routing y los checks/elicitación se preservan en metadata para no perder nada.
//
// Ejecutar contra APTS_test:  cd backend && node seeds/bmad_seed.js

const fs = require('fs');
const path = require('path');
const { methodSeedKnex } = require('../scripts/lib/seed_db');
const { deriveWiring } = require('../scripts/importer/wiring');

// Seed del MÉTODO: entorno por arg explícito o NODE_ENV (production/test/development).
// Producción:  node seeds/bmad_seed.js production    |    Test:  node seeds/bmad_seed.js test
// El entorno se toma del primer argumento que NO sea una bandera, para que
// `--force` pueda ir en cualquier posición sin acabar interpretado como entorno.
const ARGS = process.argv.slice(2);
const FORCE = ARGS.includes('--force');
const knex = methodSeedKnex('bmad_seed', ARGS.find((a) => !a.startsWith('--')));

const j = (v) => (v === undefined || v === null ? null : JSON.stringify(v));

const SOURCE_REF = 'bmad:v6.8.0';
const CORPUS_DIR = path.resolve(__dirname, '..', 'importer', 'corpus');

// Carga toda la IR del corpus (orden determinista por key).
const loadCorpus = () => {
  if (!fs.existsSync(CORPUS_DIR)) {
    throw new Error(`corpus no encontrado: ${CORPUS_DIR}. Corré: node scripts/import-bmad.js`);
  }
  return fs
    .readdirSync(CORPUS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(CORPUS_DIR, f), 'utf8')));
};

// Persona de agente (IR.entity) → fila de entities.
const entityRow = (ir) => {
  const e = ir.entity;
  return {
    key: ir.key, // ya namespaced: bmad-agent-pm
    name: e.name || ir.key,
    kind: 'role', // los agentes BMAD son los roles del lifecycle (analyst/pm/architect/dev/…)
    persona: e.persona_md || null,
    principles: e.principles && e.principles.length ? e.principles.map((p) => `- ${p}`).join('\n') : null,
    communication_style: e.communication_style || null,
    instruction: [e.role, e.identity].filter(Boolean).join('\n\n') || null,
    metadata: j({
      title: e.title,
      icon: e.icon,
      role: e.role,
      identity: e.identity,
      menu: e.menu,
      source_path: ir.source.path,
    }),
    source_ref: SOURCE_REF,
  };
};

// Fase de IR → enum de workflow_definitions (anytime/null no está en el enum).
const defPhase = (phase) =>
  ['analysis', 'planning', 'solutioning', 'implementation'].includes(phase) ? phase : null;

// ---- 0. Guardia: este seed tira del bucle a quien esté conduciendo ----
// La limpieza del paso 1 borra las filas `bmad:v6.8.0` y las reinserta con UUID
// nuevos. `project_state` apunta al método con tres FK `ON DELETE SET NULL`
// (entity_id, current_workflow_id, current_step_id), así que el borrado no falla:
// deja los punteros en NULL sin tocar `step_status`. Un agente que estaba en
// `running` queda en `running` apuntando a nada. Medido en APTS_test.
//
// Se cuentan solo los punteros que este seed va a destruir de verdad —los que
// caen en `bmad:v6.8.0`—; los de la fixture toy sobreviven y no son motivo de
// aborto. Con `--force` se sigue adelante, pero diciendo a quién se lleva por
// delante.
const agentesEnRiesgo = async (connection) => {
  const hasTable = await connection.schema.hasTable('project_state');
  if (!hasTable) return [];

  return connection('project_state as ps')
    .leftJoin('entities as e', 'e.id', 'ps.entity_id')
    .leftJoin('workflow_definitions as wd', 'wd.id', 'ps.current_workflow_id')
    .where((q) => q.where('e.source_ref', SOURCE_REF).orWhere('wd.source_ref', SOURCE_REF))
    .select('ps.agent_name', 'ps.step_status', 'ps.initiative_id');
};

async function run() {
  const corpus = loadCorpus();
  const agents = corpus.filter((ir) => ir.kind === 'agent');
  const workflows = corpus.filter((ir) => ir.kind === 'workflow');

  const enRiesgo = await agentesEnRiesgo(knex);
  if (enRiesgo.length) {
    const lista = enRiesgo
      .map((r) => `  - ${r.agent_name} (step_status=${r.step_status}, iniciativa ${r.initiative_id})`)
      .join('\n');

    if (!FORCE) {
      throw new Error(
        `${enRiesgo.length} agente(s) están conduciendo el método sobre la biblioteca ${SOURCE_REF}.\n`
        + `Volver a sembrar los dejaría sin rol, sin workflow y sin paso, conservando su step_status:\n`
        + `${lista}\n`
        + 'Si aun así querés sembrar, repetí el comando con --force.'
      );
    }

    console.warn(`AVISO — --force: se van a anular los punteros de ${enRiesgo.length} agente(s):\n${lista}`);
  }

  return knex.transaction(async (trx) => {
    // ---- 1. Limpieza idempotente por source_ref (no toca fixture ni primitivas) ----
    await trx('workflow_definitions').where({ source_ref: SOURCE_REF }).del(); // cascade → workflow_steps
    await trx('entities').where({ source_ref: SOURCE_REF }).del();

    // ---- 2. BALDE 1 — entities (personas de agentes) ----
    const entityIdByKey = {};
    for (const ir of agents) {
      const [row] = await trx('entities').insert(entityRow(ir)).returning('id');
      entityIdByKey[ir.key] = row.id;
    }

    // ---- 2b. F3-T1.5 — rol por workflow (default_entity_id) desde los menús de agente ----
    // El corpus mapea workflow→agente como dato: entity.menu[].skill lista los
    // workflows que cada agente posee. Derivación determinista; tie-break por agente
    // alfabéticamente menor (p.ej. check-implementation-readiness → architect, no pm).
    const ownerAgentKeyByWf = {};
    for (const ir of agents) {
      const menu = (ir.entity && ir.entity.menu) || [];
      for (const m of menu) {
        if (!m.skill) continue;
        const cur = ownerAgentKeyByWf[m.skill];
        if (!cur || ir.key < cur) ownerAgentKeyByWf[m.skill] = ir.key;
      }
    }

    // ---- 3. workflow_definitions + BALDE 2 workflow_steps (todas las skills) ----
    // Los agentes también se cargan como workflow_definition (su SKILL.md tiene el
    // Overview como step generativo) para no perder el ADN; su persona ya está en entities.
    let stepTotal = 0;
    for (const ir of corpus) {
      const [wrow] = await trx('workflow_definitions')
        .insert({
          key: ir.key,
          name: ir.frontmatter.name || ir.key,
          description: ir.frontmatter.description || null,
          phase: defPhase(ir.phase),
          tracks: j(['method']),
          // F3-T1.5: rol del workflow. Agente = su propia entity; workflow = el agente
          // dueño (menú). entity_id POR-STEP sigue diferido; este default basta al resolver.
          default_entity_id: ir.kind === 'agent'
            ? entityIdByKey[ir.key]
            : (entityIdByKey[ownerAgentKeyByWf[ir.key]] || null),
          status: 'active',
          metadata: j({
            kind: ir.kind,
            dialect: ir.dialect,
            phase_raw: ir.phase, // conserva 'anytime'
            routing: ir.routing || null, // balde 3 (CSV): DAG inter-fase, lo consume T3
            workflow_critical: ir.workflow_critical || [],
            source_path: ir.source.path,
            source_tag: ir.source.tag,
          }),
          source_ref: SOURCE_REF,
        })
        .returning('id');

      // F3-T2 — wiring per-step derivado de la IR (needs/outputs/iterable).
      const wiring = deriveWiring(ir);

      let order = 1;
      let stepIdx = 0;
      for (const s of ir.steps) {
        const tmpl = (s.generative.template_outputs || []).map((t) => t.text).filter(Boolean).join('\n\n');
        await trx('workflow_steps').insert({
          workflow_id: wrow.id,
          key: String(s.n), // único por workflow_id (unique(workflow_id,key))
          step_order: order++, // secuencial: ordena aunque los n de BMAD no lo sean (0,20,30)
          goal: s.goal || null,
          kind: 'generative', // balde 2; los gates deterministas son T3
          instruction_chunk: s.generative.instruction_md || null,
          template_slice: tmpl || null,
          primitive_key: null, // T3
          entity_id: null, // rol por-step = T3
          needs: j(wiring.needs), // F3-T2: artefactos upstream (uniforme por workflow)
          outputs: j(wiring.outputsByIndex[stepIdx]), // F3-T2: solo el paso terminal lo lleva
          next_rules: null, // generative avanza por step_order; gates/routing = T3
          iterable: wiring.iterable, // F3-T2: ejecutor per-historia (dev-story)
          metadata: j({
            asks: s.generative.asks || [],
            template_outputs: s.generative.template_outputs || [],
            checks: s.checks || [], // balde 3 candidatas (preservadas para T3, NO como prompt)
            control: s.control || [],
            tag: s.tag || null,
          }),
        });
        stepIdx++;
        stepTotal++;
      }
    }

    return { agents: agents.length, workflows: workflows.length, defs: corpus.length, steps: stepTotal };
  });
}

run()
  .then(async (r) => {
    // Verificación: conteos importados (solo lo de source_ref bmad) + que la fixture sigue intacta.
    const cnt = async (t, where) => Number((await knex(t).where(where).count('* as c'))[0].c);
    const ent = await cnt('entities', { source_ref: SOURCE_REF });
    const defs = await cnt('workflow_definitions', { source_ref: SOURCE_REF });
    const steps = Number(
      (await knex('workflow_steps')
        .join('workflow_definitions', 'workflow_steps.workflow_id', 'workflow_definitions.id')
        .where('workflow_definitions.source_ref', SOURCE_REF)
        .count('* as c'))[0].c
    );
    const fixtureEnt = await cnt('entities', { source_ref: 'fixture:f1-toy' });
    const fixtureDefs = await cnt('workflow_definitions', { source_ref: 'fixture:f1-toy' });
    console.log('OK — importado bmad:', JSON.stringify({ entities: ent, workflow_definitions: defs, workflow_steps: steps }));
    console.log('OK — fixture intacta:', JSON.stringify({ entities: fixtureEnt, workflow_definitions: fixtureDefs }));
    await knex.destroy();
  })
  .catch(async (err) => {
    console.error('BMAD SEED FAILED:', err.message);
    await knex.destroy();
    process.exit(1);
  });

module.exports = { SOURCE_REF };
