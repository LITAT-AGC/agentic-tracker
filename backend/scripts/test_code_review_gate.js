#!/usr/bin/env node
// Prueba dirigida de la compuerta de revision por unidad (`required_for_close`).
//
// Uso:  cd backend && node scripts/test_code_review_gate.js
// Corre contra la base de PRUEBA (knexfile.test, PG_TEST_CONNECTION_STRING) y todo
// ocurre dentro de una transaccion que se revierte: no deja residuo. No necesita el
// servidor levantado — llama a `aptsSubmitStep` directamente, que es donde vive la
// compuerta.
//
// Existe porque `test_agent_api*.js` cubren la API de agente y no tocan el motor de
// metodo: sin esto, la unica forma de comprobar que una story no cierra sin su
// revision era conducir una iniciativa entera a mano.

const knex = require('knex')(require('../knexfile').test);
const { aptsSubmitStep } = require('./lib/method_resolver');

const URL = 'https://example.invalid/prueba-compuerta-revision';
const AGENTE = 'prueba-compuerta-dev';

let fallos = 0;
const ok = (cond, etiqueta, detalle) => {
  console.log(`${cond ? '  OK  ' : ' FALLA'} ${etiqueta}${detalle ? ` — ${detalle}` : ''}`);
  if (!cond) fallos += 1;
};

(async () => {
  await knex.transaction(async (trx) => {
    // ---- montaje minimo: proyecto -> iniciativa -> epic -> story -> puntero ----
    await trx('projects').insert({ url: URL, name: 'prueba compuerta' }).onConflict('url').ignore();

    const wf = await trx('workflow_definitions').where({ key: 'bmad-dev-story' })
      .first('id', 'default_entity_id', 'source_ref');
    if (!wf) throw new Error('la base de prueba no tiene sembrado bmad-dev-story');
    const terminal = await trx('workflow_steps').where({ workflow_id: wf.id })
      .orderBy('step_order', 'desc').first('id', 'key', 'outputs');
    console.log(`paso terminal: '${terminal.key}' outputs=${JSON.stringify(terminal.outputs)}`);

    const [ini] = await trx('initiatives').insert({
      project_url: URL, title: 'prueba compuerta', phase: 'implementation',
      status: 'active', track: 'method', source_ref: wf.source_ref,
    }).returning(['id']);
    const [epic] = await trx('epics').insert({
      initiative_id: ini.id, project_url: URL, title: 'epic de prueba',
    }).returning(['id']);
    const [story] = await trx('backlog_items').insert({
      project_url: URL, title: 'story de prueba', item_type: 'feature',
      status: 'in_progress', initiative_id: ini.id, epic_id: epic.id,
    }).returning(['id']);

    await trx('project_state').insert({
      initiative_id: ini.id, project_url: URL, agent_name: AGENTE,
      entity_id: wf.default_entity_id, current_workflow_id: wf.id,
      current_step_id: terminal.id, step_status: 'running',
      cursor: JSON.stringify({ story_id: story.id }),
    });

    // ---- 1. submit terminal SIN revision: tiene que rebotar ----
    const sinRevision = await aptsSubmitStep(trx, {
      project_url: URL, agent_name: AGENTE,
      output: { status: 'done', code_ref: 'deadbeef' },
    });
    ok(sinRevision.ok === false, 'submit sin revision rechazado', sinRevision.why || '');
    ok(/code_review/.test(sinRevision.why || ''), 'el rechazo nombra el artefacto que falta');

    const trasRechazo = await trx('backlog_items').where({ id: story.id }).first('status');
    ok(trasRechazo.status === 'in_progress', 'la story NO se cerro con el submit rechazado', `status=${trasRechazo.status}`);
    const docsTrasRechazo = await trx('semantic_documents').where({ initiative_id: ini.id }).count('* as n').first();
    ok(Number(docsTrasRechazo.n) === 0, 'el rechazo no dejo artefactos escritos', `n=${docsTrasRechazo.n}`);
    const punteroTrasRechazo = await trx('project_state')
      .where({ initiative_id: ini.id, agent_name: AGENTE }).first('current_step_id');
    ok(punteroTrasRechazo.current_step_id === terminal.id, 'el cursor no avanzo');

    // ---- 2. submit terminal CON revision: cierra ----
    const conRevision = await aptsSubmitStep(trx, {
      project_url: URL, agent_name: AGENTE,
      output: {
        status: 'done', code_ref: 'deadbeef',
        title: 'Revision adversaria — story de prueba',
        content: '## Confirmados\n- src/x.js:42 — con buffer vacio divide por cero.\n\n## Anotados\n- nombres',
      },
    });
    ok(conRevision.ok === true, 'submit con revision aceptado', conRevision.why || '');
    ok(conRevision.workflow_complete === true && conRevision.iterable_unit_done === true, 'unidad cerrada');
    const clases = (conRevision.captured || []).map((c) => c.kind).sort().join(',');
    ok(clases === 'artifact,status', 'capturo las dos declaraciones', `captured=${clases}`);

    const trasCierre = await trx('backlog_items').where({ id: story.id }).first('status', 'code_ref');
    ok(trasCierre.status === 'done', 'la story quedo done', `status=${trasCierre.status}`);
    // El hash viajaba en `captured[]` y no se escribia en ningun sitio: se pedia, se
    // transportaba y se tiraba.
    ok(trasCierre.code_ref === 'deadbeef', 'y con el commit que la cerro escrito', `code_ref=${trasCierre.code_ref}`);

    const doc = await trx('semantic_documents')
      .where({ initiative_id: ini.id, doc_type: 'code_review' }).first('scope_key', 'content');
    ok(Boolean(doc), 'la revision quedo escrita como semantic_document');
    const esperada = `initiative:${ini.id}:code_review:story:${story.id}`;
    ok(doc && doc.scope_key === esperada, 'con la clave de ESTA unidad', doc ? doc.scope_key : '(sin fila)');
    ok(doc && /divide por cero/.test(doc.content || ''), 'y con el texto de la revision');

    // ---- 3. otra story de la misma iniciativa no hereda esa revision ----
    // Es el fallo mudo que costo `story_spec`: una sola fila por iniciativa servida
    // despues a todas las unidades como si fuera suya.
    const [story2] = await trx('backlog_items').insert({
      project_url: URL, title: 'segunda story', item_type: 'feature',
      status: 'in_progress', initiative_id: ini.id, epic_id: epic.id,
    }).returning(['id']);
    const propias = await trx('semantic_documents')
      .where({ scope_key: `initiative:${ini.id}:code_review:story:${story2.id}` }).count('* as n').first();
    ok(Number(propias.n) === 0, 'otra story de la misma iniciativa no ve esa revision como suya');

    throw new Error('__rollback__');
  }).catch((e) => {
    if (e.message !== '__rollback__') throw e;
    console.log('\n(transaccion revertida: la base de prueba queda como estaba)');
  });

  console.log(fallos === 0 ? '\nTODO VERDE' : `\n${fallos} COMPROBACIONES EN ROJO`);
  await knex.destroy();
  process.exit(fallos === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
