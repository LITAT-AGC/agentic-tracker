#!/usr/bin/env node
// Prueba dirigida de la compuerta de compuertas: el paso terminal no cierra una unidad
// sin la evidencia de los comandos que el PROYECTO declara en `project_constraints`.
//
// Uso:  cd backend && node scripts/test_project_gates.js
// Corre contra la base de PRUEBA (knexfile.test) dentro de una transaccion que se
// revierte: no deja residuo. No necesita el servidor levantado.
//
// Existe porque el 2026-08-19 US-KAN-02 cerro en el cliente "tickets" con
// `npm run lint` en rojo. El agente no lo corrio en 561 turnos y su documento de
// revision enumera lo que si comprobo sin mencionarlo: no mintio, se lo salto, y nada
// se lo pidio. La compuerta del `code_review` estaba verde porque el artefacto existia.
//
// Lo que se fija aqui, y en este orden de importancia:
//   1. que un proyecto SIN comandos declarados no vea exigencia nueva ninguna —es la
//      propiedad que permite estrenar esto sin plantar el ciclo de nadie—;
//   2. que uno CON comandos no pueda cerrar sin acreditarlos;
//   3. que una compuerta en rojo rebote con un mensaje distinto al de una que falta,
//      porque se arreglan de formas distintas.

const knex = require('knex')(require('../knexfile').test);
const { aptsSubmitStep } = require('./lib/method_resolver');
const { revisarCompuertas, compuertasDeclaradas } = require('./lib/project_gates');

const AGENTE = 'prueba-compuertas-dev';
const REVISION = {
  title: 'Revision adversaria — story de prueba',
  content: '## Confirmados\n- src/x.js:42 — con buffer vacio divide por cero.',
};

let fallos = 0;
const ok = (cond, etiqueta, detalle) => {
  console.log(`${cond ? '  OK  ' : ' FALLA'} ${etiqueta}${detalle ? ` — ${detalle}` : ''}`);
  if (!cond) fallos += 1;
};

// Monta proyecto -> iniciativa -> epic -> story -> puntero en el paso terminal, y
// devuelve con que llamar a submit. `constraints` decide DONDE se declaran los comandos:
// `descripcion` usa `projects.description` y `config` la clave que escribe
// `set_project_constraints`, que son las dos fuentes que el lector mezcla.
const montar = async (trx, { url, constraints = null, fuente = 'config' }) => {
  await trx('projects').insert({
    url,
    name: 'prueba compuertas',
    description: constraints && fuente === 'descripcion' ? JSON.stringify(constraints) : null,
  }).onConflict('url').ignore();

  if (constraints && fuente === 'config') {
    await trx('config').insert({
      key: `project_constraints:${url}`, value: JSON.stringify(constraints),
    }).onConflict('key').merge();
  }

  const wf = await trx('workflow_definitions').where({ key: 'bmad-dev-story' })
    .first('id', 'default_entity_id', 'source_ref');
  if (!wf) throw new Error('la base de prueba no tiene sembrado bmad-dev-story');
  const terminal = await trx('workflow_steps').where({ workflow_id: wf.id })
    .orderBy('step_order', 'desc').first('id', 'key');

  const [ini] = await trx('initiatives').insert({
    project_url: url, title: 'prueba compuertas', phase: 'implementation',
    status: 'active', track: 'method', source_ref: wf.source_ref,
  }).returning(['id']);
  const [epic] = await trx('epics').insert({
    initiative_id: ini.id, project_url: url, title: 'epic de prueba',
  }).returning(['id']);
  const [story] = await trx('backlog_items').insert({
    project_url: url, title: 'story de prueba', item_type: 'feature',
    status: 'in_progress', initiative_id: ini.id, epic_id: epic.id,
  }).returning(['id']);

  await trx('project_state').insert({
    initiative_id: ini.id, project_url: url, agent_name: AGENTE,
    entity_id: wf.default_entity_id, current_workflow_id: wf.id,
    current_step_id: terminal.id, step_status: 'running',
    cursor: JSON.stringify({ story_id: story.id }),
  });

  return { ini, story, terminal, enviar: (output) => aptsSubmitStep(trx, { project_url: url, agent_name: AGENTE, output }) };
};

(async () => {
  // ---- 0. La parte pura, sin base ----
  // Se prueba aparte porque es donde vive la decision y no necesita ni proyecto ni
  // transaccion: si esto se rompe, lo de abajo solo dice que se rompio mas tarde.
  console.log('\n== la funcion pura ==');
  const dos = [{ clave: 'lint', comando: 'npm run lint' }, { clave: 'test', comando: 'npm test' }];
  ok(revisarCompuertas(dos, undefined).faltan.length === 2, 'sin output.gates faltan las dos');
  ok(revisarCompuertas(dos, { lint: { exit_code: 0 } }).faltan.map((f) => f.clave).join() === 'test',
    'con una sola, falta exactamente la otra');
  ok(revisarCompuertas(dos, { lint: { exit_code: 0 }, test: { exit_code: 1 } }).fallan[0].clave === 'test',
    'un exit_code distinto de cero cae en fallan, no en faltan');
  ok(revisarCompuertas(dos, { lint: { exit_code: '0' }, test: { exit_code: 0 } }).faltan.length === 0,
    'el exit_code entrecomillado vale: "0" es un cero que se leyo de un shell');
  ok(revisarCompuertas(dos, { lint: { exit_code: 'verde' }, test: { exit_code: 0 } }).faltan[0].porque === 'sin exit_code entero',
    'una palabra en vez de un codigo NO vale');
  ok(revisarCompuertas(dos, { lint: { passed: true }, test: { exit_code: 0 } }).faltan.length === 1,
    'passed:true tampoco: es una opinion, no una observacion');
  ok(compuertasDeclaradas({ lint_command: 'npm run lint', test_command: null, typecheck_command: '  ' }).length === 1,
    'solo se exige lo declarado: null y el blanco no son comandos');

  await knex.transaction(async (trx) => {
    // ---- 1. Proyecto SIN comandos declarados: nada cambia ----
    console.log('\n== proyecto sin compuertas declaradas ==');
    const libre = await montar(trx, { url: 'https://example.invalid/compuertas-sin-declarar' });
    const cierraLibre = await libre.enviar({ status: 'done', code_ref: 'cafe1', ...REVISION });
    ok(cierraLibre.ok === true, 'cierra igual que antes, sin pedir evidencia', cierraLibre.why || '');
    const estadoLibre = await trx('backlog_items').where({ id: libre.story.id }).first('status');
    ok(estadoLibre.status === 'done', 'y la story queda done', `status=${estadoLibre.status}`);

    // ---- 2. Con comandos declarados y sin evidencia: rebota ----
    console.log('\n== con compuertas, sin evidencia ==');
    const url2 = 'https://example.invalid/compuertas-sin-evidencia';
    const g = await montar(trx, {
      url: url2,
      constraints: { lint_command: 'npm run lint', test_command: 'npm test', typecheck_command: null },
    });
    const sinEvidencia = await g.enviar({ status: 'done', code_ref: 'cafe2', ...REVISION });
    ok(sinEvidencia.ok === false, 'submit sin gates rechazado');
    ok(/npm run lint/.test(sinEvidencia.why || ''), 'el rechazo nombra el comando de lint literal');
    ok(/npm test/.test(sinEvidencia.why || ''), 'y el de test');
    ok(/output\.gates/.test(sinEvidencia.why || ''), 'y dice donde mandar la evidencia');
    ok(!/typecheck/.test(sinEvidencia.why || ''), 'y NO pide el typecheck, que el proyecto no declara');

    const tras2 = await trx('backlog_items').where({ id: g.story.id }).first('status');
    ok(tras2.status === 'in_progress', 'la story NO se cerro', `status=${tras2.status}`);
    const docs2 = await trx('semantic_documents').where({ initiative_id: g.ini.id }).count('* as n').first();
    ok(Number(docs2.n) === 0, 'el rechazo no dejo la revision escrita', `n=${docs2.n}`);
    const puntero2 = await trx('project_state')
      .where({ initiative_id: g.ini.id, agent_name: AGENTE }).first('current_step_id');
    ok(puntero2.current_step_id === g.terminal.id, 'y el cursor no avanzo');

    // Se filtra por regla y no se coge la primera fila: este mismo submit dispara
    // tambien el contador de las tres capas —la revision de prueba no las nombra—, y
    // un `.first()` a secas se traeria esa y diria verde por accidente.
    const desviaciones = await trx('agent_logs')
      .where({ action_type: 'deviation', agent_name: AGENTE }).select('technical_details');
    const reglas = desviaciones
      .map((d) => (typeof d.technical_details === 'string' ? JSON.parse(d.technical_details) : d.technical_details))
      .filter((d) => d && d.rule === 'compuertas-del-proyecto-acreditadas');
    ok(reglas.length === 1, 'quedo contada como desviacion', `filas=${reglas.length}`);
    ok(reglas[0]?.outcome === 'rejected', 'y de la clase que el servidor rechazo', reglas[0]?.outcome);

    // ---- 3. Con evidencia en rojo: rebota, y lo dice de otra forma ----
    console.log('\n== con una compuerta en rojo ==');
    const enRojo = await g.enviar({
      status: 'done', code_ref: 'cafe3', ...REVISION,
      gates: { lint: { command: 'npm run lint', exit_code: 1 }, test: { command: 'npm test', exit_code: 0 } },
    });
    ok(enRojo.ok === false, 'un lint en rojo no cierra la unidad');
    ok(/rojo/.test(enRojo.why || ''), 'y el mensaje habla de rojo, no de evidencia que falta', enRojo.why || '');
    const tras3 = await trx('backlog_items').where({ id: g.story.id }).first('status');
    ok(tras3.status === 'in_progress', 'la story sigue abierta', `status=${tras3.status}`);

    // ---- 4. Con todo en verde: cierra ----
    console.log('\n== con las dos en verde ==');
    const enVerde = await g.enviar({
      status: 'done', code_ref: 'cafe4', ...REVISION,
      gates: { lint: { command: 'npm run lint', exit_code: 0 }, test: { command: 'npm test', exit_code: 0 } },
    });
    ok(enVerde.ok === true, 'submit con las compuertas acreditadas aceptado', enVerde.why || '');
    const tras4 = await trx('backlog_items').where({ id: g.story.id }).first('status', 'code_ref');
    ok(tras4.status === 'done', 'la story quedo done', `status=${tras4.status}`);
    ok(tras4.code_ref === 'cafe4', 'y con el commit que la cerro', `code_ref=${tras4.code_ref}`);

    // ---- 5. Los comandos declarados en projects.description tambien mandan ----
    // Es la otra mitad del lector: si el motor solo mirara la clave de `config`, un
    // proyecto viejo —los que traen las constraints en la descripcion— se cerraria sin
    // compuertas y nadie lo notaria.
    console.log('\n== declarados en projects.description ==');
    const d = await montar(trx, {
      url: 'https://example.invalid/compuertas-en-descripcion',
      constraints: { lint_command: 'make lint' },
      fuente: 'descripcion',
    });
    const desdeDescripcion = await d.enviar({ status: 'done', code_ref: 'cafe5', ...REVISION });
    ok(desdeDescripcion.ok === false, 'tambien se exigen si viven en la descripcion');
    ok(/make lint/.test(desdeDescripcion.why || ''), 'y con su comando literal', desdeDescripcion.why || '');

    throw new Error('__rollback__');
  }).catch((e) => {
    if (e.message !== '__rollback__') throw e;
    console.log('\n(transaccion revertida: la base de prueba queda como estaba)');
  });

  console.log(fallos === 0 ? '\nTODO VERDE' : `\n${fallos} COMPROBACIONES EN ROJO`);
  await knex.destroy();
  process.exit(fallos === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
