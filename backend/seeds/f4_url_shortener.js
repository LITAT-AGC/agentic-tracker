// F4-T1 — Instancia de proyecto real para la validación end-to-end.
//
// Proyecto de prueba: un Acortador de URLs (greenfield, chico pero real). Corre el
// lifecycle completo (analysis → planning → solutioning → implementation) sobre la
// librería del método BMAD ya importada (source_ref 'bmad:v6.8.0'), con `apts_next`
// guiando y el goteo (apts_workflow_step / apts_submit_step) sirviendo, multi-agente.
//
// Este seed crea SOLO la INSTANCIA (project / initiative / epic / project_state);
// la librería del método (entities / workflow_definitions / workflow_steps /
// primitives_palette) la provee `node seeds/bmad_seed.js`. NO toca esa librería ni
// la fixture toy: limpieza idempotente acotada por project_url.
//
// Modelado acordado con el operador (2026-06-21):
//   · source_ref = 'bmad:v6.8.0' en la iniciativa → scopea el resolver a la librería bmad.
//   · 1 epic pre-creado VACÍO: no hay tool para crear epics (sólo create_backlog_item
//     para stories); las stories se crean DURANTE el flujo (implementation).
//   · Roster multi-agente = 1 analyst + 1 pm + 1 architect + 2 dev. BMAD v6.8 NO tiene
//     agente 'sm': el agente 'dev' posee todo el ciclo de implementation
//     (sprint-planning / create-story / dev-story / code-review / retrospective).
//     El 'sm' del toy queda subsumido en dev (divergencia toy→bmad documentada).
//
// Idempotente: re-run borra la instancia por project_url y reinserta.
// Ejecutar contra APTS_test:  cd backend && node seeds/f4_url_shortener.js

const knex = require('knex')(require('./../knexfile').test);

const PROJECT_URL = 'apts://f4/url-shortener';
const SOURCE_REF = 'bmad:v6.8.0';

// Roster → entity bmad (por key namespaced del corpus). El reparto sin colisión de
// dev-story (iterable) se ejercita con los 2 dev.
const ROSTER = [
  { agent_name: 'agent-analyst', entity_key: 'bmad-agent-analyst' },
  { agent_name: 'agent-pm', entity_key: 'bmad-agent-pm' },
  { agent_name: 'agent-architect', entity_key: 'bmad-agent-architect' },
  { agent_name: 'agent-dev-1', entity_key: 'bmad-agent-dev' },
  { agent_name: 'agent-dev-2', entity_key: 'bmad-agent-dev' },
];

async function run() {
  return knex.transaction(async (trx) => {
    // ---- 1. Pre-chequeo: la librería bmad debe estar seedeada (FK de project_state) ----
    const bmadDefs = Number(
      (await trx('workflow_definitions').where({ source_ref: SOURCE_REF }).count('* as c'))[0].c,
    );
    if (bmadDefs === 0) {
      throw new Error(
        `librería bmad ausente (source_ref ${SOURCE_REF}). Corré primero: node seeds/bmad_seed.js`,
      );
    }
    const entities = await trx('entities').where({ source_ref: SOURCE_REF }).select('id', 'key');
    const entityIdByKey = Object.fromEntries(entities.map((e) => [e.key, e.id]));
    for (const r of ROSTER) {
      if (!entityIdByKey[r.entity_key]) {
        throw new Error(`entity '${r.entity_key}' no encontrada en la librería bmad`);
      }
    }

    // ---- 2. Limpieza idempotente (instancia primero; NO toca la librería) ----
    await trx('project_state').where({ project_url: PROJECT_URL }).del();
    await trx('backlog_items').where({ project_url: PROJECT_URL }).del();
    await trx('epics').where({ project_url: PROJECT_URL }).del();
    await trx('initiatives').where({ project_url: PROJECT_URL }).del();
    await trx('projects').where({ url: PROJECT_URL }).del();

    // ---- 3. Instancia ----
    await trx('projects').insert({ url: PROJECT_URL, name: 'URL Shortener (F4 e2e)' });

    const [initRow] = await trx('initiatives').insert({
      project_url: PROJECT_URL,
      title: 'URL Shortener',
      description: 'Servicio para acortar URLs largas a enlaces cortos con redirección y métricas básicas.',
      track: 'method',
      phase: 'analysis',
      status: 'active',
      source_ref: SOURCE_REF, // scopea el resolver a la librería bmad
    }).returning('id');
    const initiativeId = initRow.id;

    const [epicRow] = await trx('epics').insert({
      initiative_id: initiativeId,
      project_url: PROJECT_URL,
      title: 'MVP del acortador de URLs',
      goal: 'Acortar, redirigir y contar visitas de enlaces.',
      status: 'planned',
      priority: 100,
      sort_order: 0,
    }).returning('id');
    const epicId = epicRow.id;

    for (const r of ROSTER) {
      await trx('project_state').insert({
        initiative_id: initiativeId,
        project_url: PROJECT_URL,
        agent_name: r.agent_name,
        entity_id: entityIdByKey[r.entity_key],
        step_status: 'idle',
      });
    }

    return { initiativeId, epicId };
  });
}

run()
  .then(async () => {
    const instCounts = {};
    for (const t of ['initiatives', 'epics', 'backlog_items', 'project_state']) {
      instCounts[t] = Number((await knex(t).where({ project_url: PROJECT_URL }).count('* as c'))[0].c);
    }
    console.log('OK — instancia F4:', JSON.stringify(instCounts));
    await knex.destroy();
  })
  .catch(async (err) => {
    console.error('F4 SEED FAILED:', err.message);
    await knex.destroy();
    process.exit(1);
  });

module.exports = { PROJECT_URL, SOURCE_REF, ROSTER };
