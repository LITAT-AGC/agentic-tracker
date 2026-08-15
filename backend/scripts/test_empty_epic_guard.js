#!/usr/bin/env node
// Prueba dirigida de la epica vacia: la compuerta que impide cerrar el plan sin
// historias, la adopcion de huerfanos en la captura, el veredicto `blocked` (no `wait`)
// cuando la epica no tiene hijos, y la operacion de reparacion `adopt_backlog_items`.
//
// Uso:  cd backend && node scripts/test_empty_epic_guard.js
// Corre contra la base de PRUEBA (knexfile.test, PG_TEST_CONNECTION_STRING) y todo
// ocurre dentro de una transaccion que se revierte: no deja residuo. No necesita el
// servidor levantado — llama a `aptsSubmitStep` / `aptsNext` / `adoptBacklogItems`
// directamente, que es donde vive todo lo que se comprueba.
//
// Existe por un cliente real (proyecto "tickets", 2026-08-14): 21 items en el backlog,
// `backlog: {total: 0}` para el motor, y el ciclo respondiendo `wait` para siempre.

const knex = require('knex')(require('../knexfile').test);
const { aptsSubmitStep, aptsNext } = require('./lib/method_resolver');
const { adoptBacklogItems } = require('./lib/method_bootstrap');

const URL = 'https://example.invalid/prueba-epica-vacia';
const AGENTE = 'prueba-epica-vacia-pm';

let fallos = 0;
const ok = (cond, etiqueta, detalle) => {
  console.log(`${cond ? '  OK  ' : ' FALLA'} ${etiqueta}${detalle ? ` — ${detalle}` : ''}`);
  if (!cond) fallos += 1;
};

const nuevoItem = (trx, titulo, extra = {}) => trx('backlog_items').insert({
  project_url: URL, title: titulo, item_type: 'feature', status: 'ready', ...extra,
}).returning(['id']).then(([row]) => row.id);

(async () => {
  await knex.transaction(async (trx) => {
    // ---- montaje: proyecto -> iniciativa (planning) -> epic VACIO -> puntero en el
    // paso terminal de bmad-create-epics-and-stories ----
    await trx('projects').insert({ url: URL, name: 'prueba epica vacia' }).onConflict('url').ignore();

    const wf = await trx('workflow_definitions').where({ key: 'bmad-create-epics-and-stories' })
      .first('id', 'default_entity_id', 'source_ref');
    if (!wf) throw new Error('la base de prueba no tiene sembrado bmad-create-epics-and-stories');
    const terminal = await trx('workflow_steps').where({ workflow_id: wf.id })
      .orderBy('step_order', 'desc').first('id', 'key', 'outputs');
    console.log(`paso terminal: '${terminal.key}' outputs=${JSON.stringify(terminal.outputs)}`);
    ok(
      (terminal.outputs || []).some((o) => o.kind === 'backlog_items' && o.required_for_close),
      'el paso terminal declara backlog_items como required_for_close',
      'si falla, falta correr `npm run migrate:test`',
    );

    const [ini] = await trx('initiatives').insert({
      project_url: URL, title: 'prueba epica vacia', phase: 'planning',
      status: 'active', track: 'method', source_ref: wf.source_ref,
    }).returning(['id']);
    const [epic] = await trx('epics').insert({
      initiative_id: ini.id, project_url: URL, title: 'epic de prueba',
    }).returning(['id']);

    await trx('project_state').insert({
      initiative_id: ini.id, project_url: URL, agent_name: AGENTE,
      entity_id: wf.default_entity_id, current_workflow_id: wf.id,
      current_step_id: terminal.id, step_status: 'running',
      cursor: null,
    });

    // ---- 1. submit del documento SIN historias: tiene que rebotar ----
    const sinHistorias = await aptsSubmitStep(trx, {
      project_url: URL, agent_name: AGENTE,
      output: { title: 'Epicas y historias', content: '# Epica 1\n- US-01...' },
    });
    ok(sinHistorias.ok === false, 'submit sin historias rechazado', sinHistorias.why || '');
    ok(/output\.stories/.test(sinHistorias.why || ''), 'el rechazo nombra output.stories');

    const docsTrasRechazo = await trx('semantic_documents').where({ initiative_id: ini.id }).count('* as n').first();
    ok(Number(docsTrasRechazo.n) === 0, 'el rechazo no dejo el documento escrito', `n=${docsTrasRechazo.n}`);
    const faseTrasRechazo = await trx('initiatives').where({ id: ini.id }).first('phase');
    ok(faseTrasRechazo.phase === 'planning', 'la fase no avanzo', `phase=${faseTrasRechazo.phase}`);

    // ---- 2. huerfanos: existen en el backlog y el motor no los ve ----
    // Es lo que deja `create_backlog_item`, cuyo esquema no tiene epic_id.
    const huerfano1 = await nuevoItem(trx, 'US-01 Alta de usuarios por invitacion');
    const huerfano2 = await nuevoItem(trx, 'US-02 Matriz de estados editable', { status: 'draft' });
    const bug = await nuevoItem(trx, 'Bug: el panel no refresca', { item_type: 'bug', status: 'ready' });

    const invisibles = await trx('backlog_items').where({ epic_id: epic.id }).count('* as n').first();
    ok(Number(invisibles.n) === 0, 'los items sueltos no cuentan como hijos de la epica', `n=${invisibles.n}`);

    // ---- 3. submit CON historias: adopta los huerfanos por titulo, no los clona ----
    const conHistorias = await aptsSubmitStep(trx, {
      project_url: URL, agent_name: AGENTE,
      output: {
        title: 'Epicas y historias',
        content: '# Epica 1\n- US-01\n- US-02\n- US-03',
        stories: [
          'US-01 Alta de usuarios por invitacion',
          { title: 'US-02 Matriz de estados editable', acceptance_criteria: 'CA-1' },
          { title: 'US-03 Email de novedades', description: 'nueva' },
        ],
      },
    });
    ok(conHistorias.ok === true, 'submit con historias aceptado', conHistorias.why || '');

    const capturaItems = (conHistorias.captured || []).find((c) => c.kind === 'backlog_items');
    ok(Boolean(capturaItems), 'capturo la declaracion de backlog_items');
    ok(capturaItems && capturaItems.adopted === 2, 'adopto los dos huerfanos por titulo', `adopted=${capturaItems && capturaItems.adopted}`);
    ok(capturaItems && capturaItems.created === 1, 'y creo solo la historia nueva', `created=${capturaItems && capturaItems.created}`);

    const totalConTitulo1 = await trx('backlog_items')
      .where({ project_url: URL, title: 'US-01 Alta de usuarios por invitacion' })
      .count('* as n').first();
    ok(Number(totalConTitulo1.n) === 1, 'US-01 no quedo duplicada', `n=${totalConTitulo1.n}`);

    const adoptado1 = await trx('backlog_items').where({ id: huerfano1 }).first('epic_id', 'initiative_id', 'status');
    ok(adoptado1.epic_id === epic.id && adoptado1.initiative_id === ini.id, 'US-01 quedo ligada a la epica y a la iniciativa');
    ok(adoptado1.status === 'ready_for_dev', 'y entro por la puerta de la maquina de metodo', `status=${adoptado1.status}`);

    const hijos = await trx('backlog_items').where({ epic_id: epic.id }).count('* as n').first();
    ok(Number(hijos.n) === 3, 'la epica quedo con las tres historias', `n=${hijos.n}`);

    const ordenes = await trx('backlog_items').where({ epic_id: epic.id }).orderBy('sort_order', 'asc').pluck('sort_order');
    ok(new Set(ordenes).size === ordenes.length, 'con sort_order distinto entre si (el reparto no lo decide el UUID)', `sort_order=${ordenes.join(',')}`);

    const bugSuelto = await trx('backlog_items').where({ id: bug }).first('epic_id');
    ok(bugSuelto.epic_id === null, 'el bug que nadie nombro sigue fuera de la epica');

    // ---- 4. apts_next con la epica vacia: blocked, no wait ----
    // Segunda iniciativa, en implementation y sin hijos, para ver el veredicto.
    const URL2 = `${URL}-2`;
    await trx('projects').insert({ url: URL2, name: 'prueba epica vacia 2' }).onConflict('url').ignore();
    const wfDev = await trx('workflow_definitions').where({ key: 'bmad-dev-story' })
      .first('id', 'default_entity_id');
    const [ini2] = await trx('initiatives').insert({
      project_url: URL2, title: 'prueba epica vacia 2', phase: 'implementation',
      status: 'active', track: 'method', source_ref: wf.source_ref,
    }).returning(['id']);
    const [epic2] = await trx('epics').insert({
      initiative_id: ini2.id, project_url: URL2, title: 'epic vacio',
    }).returning(['id']);
    await trx('project_state').insert({
      initiative_id: ini2.id, project_url: URL2, agent_name: 'prueba-epica-vacia-dev',
      entity_id: wfDev.default_entity_id, step_status: 'idle',
    });
    // La espina de 'implementation' es sprint-planning -> create-story -> dev-story, y
    // los dos primeros cierran por artifact-exists a nivel de iniciativa. Sin ellos el
    // resolver ni siquiera llega al paso iterable, que es lo que aca se mide.
    for (const doc_type of ['sprint_plan', 'story_spec']) {
      await trx('semantic_documents').insert({
        project_url: URL2, strategy_key: 'method_artifact', scope_key: `initiative:${ini2.id}:${doc_type}`,
        source_type: 'test_fixture', title: doc_type, content: 'x', content_hash: doc_type,
        doc_type, version: 1, initiative_id: ini2.id,
      });
    }
    // Los dos, con la misma prioridad y el mismo sort_order: es lo que deja
    // `create_backlog_item`, y por eso el orden hay que darlo al adoptar.
    const sueltoA = await nuevoItem(trx, 'US-A migrada del PRD', { project_url: URL2, priority: 100, sort_order: 0 });
    const sueltoB = await nuevoItem(trx, 'US-B migrada del PRD', { project_url: URL2, priority: 100, sort_order: 0 });

    const veredicto = await aptsNext(trx, { project_url: URL2, agent_name: 'prueba-epica-vacia-dev' });
    ok(veredicto.next === 'blocked', 'la epica vacia da blocked, no wait', `next=${veredicto.next}`);
    ok(/2 item/.test(veredicto.why || ''), 'y el porque cuenta los items huerfanos', veredicto.why || '');
    ok(/adopt_backlog_items/.test(veredicto.why || ''), 'y nombra la herramienta que lo repara');

    // ---- 5. adopt_backlog_items: la reparacion desde el cliente ----
    // Con ids explicitos y a proposito EN ORDEN INVERSO al de creacion: el llamante
    // dicta el plan, que es lo unico que puede hacerlo cuando los huerfanos comparten
    // prioridad y sort_order.
    const reparacion = await adoptBacklogItems(trx, { project_url: URL2, backlog_item_ids: [sueltoB, sueltoA] });
    ok(reparacion.adopted_count === 2, 'adopto los dos items sueltos', `adopted_count=${reparacion.adopted_count}`);
    ok(reparacion.epic_id === epic2.id, 'en la epica de la iniciativa activa');
    ok(
      reparacion.adopted[0].backlog_item_id === sueltoB
        && reparacion.adopted[0].sort_order < reparacion.adopted[1].sort_order,
      'respetando el orden de la lista',
      reparacion.adopted.map((a) => `${a.title}#${a.sort_order}`).join(' '),
    );
    const hijos2 = await trx('backlog_items').where({ epic_id: epic2.id }).count('* as n').first();
    ok(Number(hijos2.n) === 2, 'la epica dejo de estar vacia', `n=${hijos2.n}`);

    const ordenes2 = await trx('backlog_items').where({ epic_id: epic2.id }).orderBy('sort_order', 'asc').pluck('sort_order');
    ok(new Set(ordenes2).size === 2, 'con sort_order correlativo, no el 0 de todos', `sort_order=${ordenes2.join(',')}`);

    // Idempotente: repetir no vuelve a tocar nada.
    const repetida = await adoptBacklogItems(trx, { project_url: URL2 });
    ok(repetida.adopted_count === 0, 'repetirla no adopta nada', `adopted_count=${repetida.adopted_count}`);

    // Y con ids explicitos, un item ya ligado se informa y no se toca.
    const porId = await adoptBacklogItems(trx, { project_url: URL2, backlog_item_ids: [sueltoA] });
    ok(porId.adopted_count === 0 && porId.skipped.length === 1, 'un item ya ligado cae en skipped', JSON.stringify(porId.skipped));

    // ---- 6. y ahora el ciclo reparte ----
    const tras = await aptsNext(trx, { project_url: URL2, agent_name: 'prueba-epica-vacia-dev' });
    ok(tras.next === 'run_step', 'tras la adopcion, el motor entrega trabajo', `next=${tras.next} why=${tras.why || ''}`);
    ok(tras.target_id === sueltoB, 'y reparte la primera del plan adoptado, no una al azar', `target_id=${tras.target_id}`);

    throw new Error('__rollback__');
  }).catch((e) => {
    if (e.message !== '__rollback__') throw e;
    console.log('\n(transaccion revertida: la base de prueba queda como estaba)');
  });

  console.log(fallos === 0 ? '\nTODO VERDE' : `\n${fallos} COMPROBACIONES EN ROJO`);
  await knex.destroy();
  process.exit(fallos === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
