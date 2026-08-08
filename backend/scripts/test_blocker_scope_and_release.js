#!/usr/bin/env node
// Prueba dirigida de las dos salidas de un atasco: decir QUE unidad esta bloqueada, y
// devolver la unidad que sostiene un puntero de metodo.
//
// Uso:  cd backend && APTS_BASE_URL=http://localhost:474xx/api node scripts/test_blocker_scope_and_release.js
// Necesita el servidor de prueba levantado (las dos cosas viven en rutas) y la base de
// prueba, para mirar por dentro y limpiar. Crea su propio proyecto y lo borra entero.
//
// Las dos existen por lo mismo, visto en produccion el 2026-08-08: `report_blocker`
// marcaba el proyecto ENTERO —que no estaba bloqueado— y no la unidad —que si—, porque
// solo miraba la unidad que la tarea posee y la del conductor no posee ninguna; y soltar
// un claim atascado no se podia hacer por ninguna superficie, hubo que escribir
// `project_state` a mano.

const knex = require('knex')(require('../knexfile').test);

const BASE = (process.env.APTS_BASE_URL || 'http://localhost:47414/api').replace(/\/$/, '');
const API_KEY = process.env.APTS_API_KEY || 'default-dev-key';
const CLAVE_PANEL = process.env.DASHBOARD_PASSWORD || 'admin';
const PROYECTO = 'https://example.invalid/prueba-bloqueo-y-soltar';
const AGENTE = 'prueba-bloqueo-dev';
const EMAIL = 'prueba-bloqueo@example.invalid';

let fallos = 0;
const ok = (cond, etiqueta, detalle) => {
  console.log(`${cond ? '  OK  ' : ' FALLA'} ${etiqueta}${detalle ? ` — ${detalle}` : ''}`);
  if (!cond) fallos += 1;
};

const cabeceras = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${API_KEY}`,
  'X-APTS-Project-Url': PROYECTO,
  'X-APTS-Agent-Name': AGENTE,
  'X-APTS-Agent-Email': EMAIL,
};

const pedir = async (metodo, ruta, cuerpo, extra = {}) => {
  const r = await fetch(`${BASE}${ruta}`, {
    method: metodo,
    headers: { ...cabeceras, ...(extra.headers || {}) },
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  const texto = await r.text();
  let datos = null;
  try { datos = texto ? JSON.parse(texto) : null; } catch (_) { datos = { raw: texto }; }
  return { status: r.status, datos, cookie: r.headers.get('set-cookie') };
};

const item = (id) => knex('backlog_items').where({ id }).first('id', 'status', 'active_task_id');

(async () => {
  await knex('projects').insert({ url: PROYECTO, name: 'prueba bloqueo' }).onConflict('url').ignore();
  const filas = await knex('backlog_items').insert([
    { project_url: PROYECTO, title: 'la nombrada', item_type: 'feature', status: 'ready_for_dev' },
    { project_url: PROYECTO, title: 'la poseida', item_type: 'feature', status: 'ready_for_dev' },
    { project_url: PROYECTO, title: 'la ajena', item_type: 'feature', status: 'ready_for_dev' },
  ]).returning(['id']);
  const [uNombrada, uPoseida, uAjena] = filas.map((f) => f.id);

  try {
    // ---- 1. una tarea que no posee nada, nombrando su unidad ----
    const t1 = await pedir('POST', '/projects/tasks', {
      project_url: PROYECTO, title: 'tarea del conductor', agent_name: AGENTE, agent_email: EMAIL,
      backlog_item_id: uNombrada, owns_backlog_item: false,
    });
    const b1 = await pedir('POST', '/projects/blockers', {
      project_url: PROYECTO, task_id: t1.datos.task_id, agent_name: AGENTE,
      error_message: 'depende de cinco unidades que no existen todavia',
      backlog_item_id: uNombrada,
    });
    ok(b1.status === 200, 'report_blocker acepta la unidad nombrada', `HTTP ${b1.status}`);
    const i1 = await item(uNombrada);
    ok(i1.status === 'blocked', 'y marca ESA unidad, que es la que estaba bloqueada', i1.status);
    ok(i1.active_task_id === null, 'sin haberla poseido en ningun momento');

    // ---- 2. el camino de siempre no cambia: la unidad que la tarea posee ----
    const t2 = await pedir('POST', '/projects/tasks', {
      project_url: PROYECTO, title: 'tarea dueña', agent_name: AGENTE, agent_email: EMAIL,
      backlog_item_id: uPoseida,
    });
    const b2 = await pedir('POST', '/projects/blockers', {
      project_url: PROYECTO, task_id: t2.datos.task_id, agent_name: AGENTE,
      error_message: 'sin nombrar nada',
    });
    ok(b2.status === 200, 'report_blocker sin el campo sigue funcionando', `HTTP ${b2.status}`);
    const i2 = await item(uPoseida);
    ok(i2.status === 'blocked', 'y marca la unidad que la tarea posee, como hasta ahora', i2.status);

    // ---- 3. una unidad de otro proyecto se rechaza, no se marca ----
    const otro = 'https://example.invalid/prueba-bloqueo-otro';
    await knex('projects').insert({ url: otro, name: 'otro' }).onConflict('url').ignore();
    const [ajenaDeVerdad] = await knex('backlog_items')
      .insert({ project_url: otro, title: 'de otro proyecto', item_type: 'feature', status: 'ready' })
      .returning(['id']);
    const b3 = await pedir('POST', '/projects/blockers', {
      project_url: PROYECTO, task_id: t1.datos.task_id, agent_name: AGENTE,
      error_message: 'nombrando lo que no es suyo', backlog_item_id: ajenaDeVerdad.id,
    });
    ok(b3.status === 400, 'una unidad de otro proyecto da 400', `HTTP ${b3.status}`);
    const iAjena = await knex('backlog_items').where({ id: ajenaDeVerdad.id }).first('status');
    ok(iAjena.status === 'ready', 'y no se marco nada por el camino', iAjena.status);
    await knex('backlog_items').where({ project_url: otro }).del();
    await knex('projects').where({ url: otro }).del();

    // ---- 4. soltar el claim: hace falta sesion de panel ----
    const sinSesion = await pedir('POST', `/method/pointers/${encodeURIComponent(AGENTE)}/release`, {
      project_url: PROYECTO, instruction: 'sin sesion',
    });
    ok(sinSesion.status === 401, 'soltar el claim exige sesion de panel', `HTTP ${sinSesion.status}`);

    const login = await pedir('POST', '/login', { password: CLAVE_PANEL });
    ok(login.status === 200, 'sesion de panel abierta', `HTTP ${login.status}`);
    const galleta = { headers: { Cookie: (login.cookie || '').split(';')[0] } };

    const desconocido = await pedir('POST', '/method/pointers/no-existe/release',
      { project_url: PROYECTO, instruction: 'x' }, galleta);
    ok(desconocido.status === 404, 'un puntero que no existe da 404', `HTTP ${desconocido.status}`);

    // Un puntero sin unidad reclamada: no hay nada que soltar.
    const wf = await knex('workflow_definitions').where({ key: 'bmad-dev-story' })
      .first('id', 'default_entity_id', 'source_ref');
    const [ini] = await knex('initiatives').insert({
      project_url: PROYECTO, title: 'prueba', phase: 'implementation',
      status: 'active', track: 'method', source_ref: wf.source_ref,
    }).returning(['id']);
    await knex('project_state').insert({
      initiative_id: ini.id, project_url: PROYECTO, agent_name: AGENTE,
      entity_id: wf.default_entity_id, step_status: 'idle',
    });
    const vacio = await pedir('POST', `/method/pointers/${encodeURIComponent(AGENTE)}/release`,
      { project_url: PROYECTO, instruction: 'no sostiene nada' }, galleta);
    ok(vacio.status === 409, 'un puntero que no sostiene ninguna unidad da 409, no un 200 vacio', `HTTP ${vacio.status}`);

    // Y ahora sosteniendo una de verdad.
    await knex('project_state').where({ project_url: PROYECTO, agent_name: AGENTE }).update({
      step_status: 'running', current_workflow_id: wf.id,
      cursor: JSON.stringify({ story_id: uAjena }),
    });
    const suelta = await pedir('POST', `/method/pointers/${encodeURIComponent(AGENTE)}/release`,
      { project_url: PROYECTO, instruction: 'el plan cambio: la trabajamos despues' }, galleta);
    ok(suelta.status === 200, 'suelta la unidad que sostenia', `HTTP ${suelta.status}`);
    ok(suelta.datos.released_backlog_item_id === uAjena, 'y dice cual era');
    const puntero = await knex('project_state')
      .where({ project_url: PROYECTO, agent_name: AGENTE }).first('cursor', 'step_status');
    ok(puntero.cursor === null, 'el cursor queda vacio', JSON.stringify(puntero.cursor));
    ok(puntero.step_status === 'idle', 'y el puntero en idle, listo para reclamar otra', puntero.step_status);

    const rastro = await knex('agent_logs')
      .where({ agent_name: 'Human Supervisor' })
      .whereRaw('message like ?', [`%${uAjena}%`])
      .first('task_id', 'message');
    ok(Boolean(rastro), 'deja rastro firmado por el humano, como el desbloqueo de al lado');
    ok(rastro && rastro.task_id === null, 'sin tarea: lo que se solto es el puntero, no una tarea');
    ok(rastro && /el plan cambio/.test(rastro.message), 'y con el motivo que dio quien lo solto');

    // La unidad soltada no se toca: sigue disponible para el reparto.
    const iSoltada = await item(uAjena);
    ok(iSoltada.status === 'ready_for_dev', 'la unidad soltada vuelve al reparto sin cambiar de estado', iSoltada.status);
  } finally {
    const tareas = await knex('tasks').where({ project_url: PROYECTO }).pluck('id');
    if (tareas.length) await knex('agent_logs').whereIn('task_id', tareas).del();
    await knex('agent_logs').where({ agent_name: 'Human Supervisor' }).whereNull('task_id')
      .whereRaw('message like ?', ['%Method claim released%']).del();
    await knex('backlog_items').where({ project_url: PROYECTO }).update({ active_task_id: null });
    await knex('semantic_documents').where({ project_url: PROYECTO }).del();
    await knex('project_state').where({ project_url: PROYECTO }).del();
    await knex('tasks').where({ project_url: PROYECTO }).del();
    await knex('backlog_items').where({ project_url: PROYECTO }).del();
    await knex('initiatives').where({ project_url: PROYECTO }).del();
    await knex('projects').where({ url: PROYECTO }).del();
    console.log('\n(proyecto de prueba borrado)');
  }

  console.log(fallos === 0 ? '\nTODO VERDE' : `\n${fallos} COMPROBACIONES EN ROJO`);
  await knex.destroy();
  process.exit(fallos === 0 ? 0 : 1);
})().catch(async (e) => { console.error(e); await knex.destroy(); process.exit(1); });
