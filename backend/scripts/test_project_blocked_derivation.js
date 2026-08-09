#!/usr/bin/env node
// Prueba dirigida de que el estado del proyecto se DERIVA y de que desatascar una tarea
// no puede reabrir trabajo terminado.
//
// Uso:  cd backend && APTS_BASE_URL=http://localhost:474xx/api node scripts/test_project_blocked_derivation.js
// Necesita el servidor de prueba levantado (las tres lecturas y el resolve viven en rutas
// de panel) y la base de prueba, para mirar la columna por dentro y limpiar. Crea su
// propio proyecto y lo borra entero.
//
// Existe por un caso de produccion del 2026-08-08: fm-synth quedo con
// `projects.status = 'blocked'` durante un dia entero, cerro diez stories con el flag
// puesto y ninguna de sus tareas ni de sus unidades seguia bloqueada. `report_blocker`
// marcaba el proyecto ENTERO y nada lo desmarcaba nunca salvo una persona pulsando
// «Resolver». Y ese boton, que el panel ofrecia en TODAS las tareas del proyecto marcado,
// devolvia a `ready` la unidad que la tarea poseyera aunque estuviera cerrada: en fm-synth
// habria resucitado «Las 32 topologias», ya `done`, y la habria reintroducido en el
// reparto.
//
// Lo que se comprueba, en orden: que la columna ya no manda (se deja a proposito diciendo
// una cosa y el panel dice otra), que el rojo aparece y —lo que faltaba— DESAPARECE SOLO
// al cerrarse la unidad, que las tres rutas de panel cuentan lo mismo, y las dos guardas
// del resolve.

const knex = require('knex')(require('../knexfile').test);

const BASE = (process.env.APTS_BASE_URL || 'http://localhost:47414/api').replace(/\/$/, '');
const API_KEY = process.env.APTS_API_KEY || 'default-dev-key';
const CLAVE_PANEL = process.env.DASHBOARD_PASSWORD || 'admin';
const PROYECTO = 'https://example.invalid/prueba-estado-derivado';
const AGENTE = 'prueba-derivado-dev';
const EMAIL = 'prueba-derivado@example.invalid';

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

// El estado tal y como lo ve el panel, por las tres rutas que lo publican. Se piden las
// tres a la vez a proposito: tres vistas del mismo proyecto que discrepen es justo el
// modo en que un estado derivado se estropea sin que nadie lo note.
const estadoEnPanel = async (galleta) => {
  const [overview, listado, detalle] = await Promise.all([
    pedir('GET', '/dashboard/overview', undefined, galleta),
    pedir('GET', '/dashboard/projects', undefined, galleta),
    pedir('GET', `/dashboard/projects/${encodeURIComponent(PROYECTO)}`, undefined, galleta),
  ]);
  return {
    overview: (overview.datos.projects || []).find((p) => p.url === PROYECTO)?.status,
    listado: (listado.datos.projects || []).find((p) => p.url === PROYECTO)?.status,
    detalle: detalle.datos.project?.status,
  };
};

const enColumna = async () => (await knex('projects').where({ url: PROYECTO }).first('status')).status;
const item = (id) => knex('backlog_items').where({ id }).first('id', 'status', 'active_task_id');
const tarea = (id) => knex('tasks').where({ id }).first('id', 'status');

(async () => {
  // La columna arranca diciendo 'blocked' y no se toca en toda la prueba: si algo la
  // leyera, todas las comprobaciones de abajo cantarian 'blocked'.
  await knex('projects').insert({ url: PROYECTO, name: 'prueba estado derivado', status: 'blocked' })
    .onConflict('url').merge({ status: 'blocked' });

  try {
    const login = await pedir('POST', '/login', { password: CLAVE_PANEL });
    ok(login.status === 200, 'sesion de panel abierta', `HTTP ${login.status}`);
    const galleta = { headers: { Cookie: (login.cookie || '').split(';')[0] } };

    // ---- 1. sin backlog: no ha empezado, diga lo que diga la columna ----
    let vista = await estadoEnPanel(galleta);
    ok(vista.overview === 'pending', 'un proyecto sin ninguna unidad se sirve como pending', vista.overview);
    ok(await enColumna() === 'blocked', 'y la columna sigue diciendo blocked: ya no la lee nadie');

    // ---- 2. con unidades abiertas: active ----
    const filas = await knex('backlog_items').insert([
      { project_url: PROYECTO, title: 'la que se bloquea', item_type: 'feature', status: 'ready_for_dev' },
      { project_url: PROYECTO, title: 'la que ya cerro', item_type: 'feature', status: 'ready_for_dev' },
    ]).returning(['id']);
    const [uBloqueada, uCerrada] = filas.map((f) => f.id);

    vista = await estadoEnPanel(galleta);
    ok(vista.overview === 'active', 'con unidades abiertas se sirve como active', vista.overview);

    // ---- 3. un bloqueo real pinta el proyecto de rojo ----
    // La columna se baja a 'pending' justo antes: si `report_blocker` la siguiera
    // escribiendo, la comprobacion de mas abajo la encontraria en 'blocked'. Dejarla en
    // 'blocked' aqui haria pasar esa linea con el codigo viejo tambien, y entonces no
    // estaria comprobando nada.
    await knex('projects').where({ url: PROYECTO }).update({ status: 'pending' });
    const t1 = await pedir('POST', '/projects/tasks', {
      project_url: PROYECTO, title: 'tarea que se atasca', agent_name: AGENTE, agent_email: EMAIL,
      backlog_item_id: uBloqueada,
    });
    const bloqueo = await pedir('POST', '/projects/blockers', {
      project_url: PROYECTO, task_id: t1.datos.task_id, agent_name: AGENTE,
      error_message: 'depende de algo que no existe todavia',
    });
    ok(bloqueo.status === 200, 'report_blocker responde', `HTTP ${bloqueo.status}`);
    ok((await item(uBloqueada)).status === 'blocked', 'la unidad queda bloqueada, que es lo que si lo estaba');

    vista = await estadoEnPanel(galleta);
    ok(vista.overview === 'blocked', 'y el proyecto se sirve como blocked', vista.overview);
    ok(
      vista.overview === vista.listado && vista.listado === vista.detalle,
      'las tres rutas de panel dicen lo mismo',
      JSON.stringify(vista)
    );
    ok(await enColumna() === 'pending', 'report_blocker ya no escribe la columna: sigue en pending', await enColumna());

    // ---- 4. EL ARREGLO: cerrar la unidad apaga el rojo, sin que nadie pulse nada ----
    // Es exactamente lo que fm-synth no hacia: cerro diez stories con el flag puesto.
    await knex('backlog_items').where({ id: uBloqueada }).update({ status: 'done' });
    vista = await estadoEnPanel(galleta);
    ok(vista.overview === 'active', 'cerrada la unidad, el proyecto deja de estar bloqueado SOLO', vista.overview);
    ok(
      (await tarea(t1.datos.task_id)).status === 'stalled',
      'y eso pasa con la tarea todavia stalled: la señal es la unidad, no la tarea'
    );

    // ---- 5. todo terminal: completed ----
    await knex('backlog_items').where({ id: uCerrada }).update({ status: 'archived' });
    vista = await estadoEnPanel(galleta);
    ok(vista.overview === 'completed', 'con todo done/archived el proyecto se sirve como completed', vista.overview);

    // ---- 6. resolve sobre una tarea que no esta atascada: 409 ----
    const t2 = await pedir('POST', '/projects/tasks', {
      project_url: PROYECTO, title: 'tarea sana', agent_name: AGENTE, agent_email: EMAIL,
    });
    await knex('tasks').where({ id: t2.datos.task_id }).update({ status: 'done' });
    const sana = await pedir('POST', `/tasks/${t2.datos.task_id}/resolve`,
      { instruction: 'no hay nada que resolver' }, galleta);
    ok(sana.status === 409, 'resolver una tarea que no esta stalled da 409', `HTTP ${sana.status}`);
    ok((await tarea(t2.datos.task_id)).status === 'done', 'y no la devuelve a todo por el camino');

    // ---- 7. LA TRAMPA: resolver una tarea cuya unidad ya cerro no la resucita ----
    // Estado copiado de produccion: tarea stalled que sigue POSEYENDO una unidad `done`.
    await knex('backlog_items').where({ id: uBloqueada })
      .update({ status: 'done', active_task_id: t1.datos.task_id });
    const conCerrada = await pedir('POST', `/tasks/${t1.datos.task_id}/resolve`,
      { instruction: 'desatascar la tarea, la story ya la cerro otro' }, galleta);
    ok(conCerrada.status === 200, 'la tarea atascada si se puede resolver', `HTTP ${conCerrada.status}`);
    ok((await tarea(t1.datos.task_id)).status === 'todo', 'y queda en todo, que es lo que se pedia');
    const traidora = await item(uBloqueada);
    ok(traidora.status === 'done', 'pero su unidad TERMINADA sigue done: no vuelve al reparto', traidora.status);

    // ---- 8. y sobre una unidad viva si repone, que es el caso para el que existe ----
    const [uViva] = (await knex('backlog_items')
      .insert({ project_url: PROYECTO, title: 'la que si hay que reponer', item_type: 'feature', status: 'ready_for_dev' })
      .returning(['id'])).map((f) => f.id);
    const t3 = await pedir('POST', '/projects/tasks', {
      project_url: PROYECTO, title: 'tarea atascada de verdad', agent_name: AGENTE, agent_email: EMAIL,
      backlog_item_id: uViva,
    });
    await pedir('POST', '/projects/blockers', {
      project_url: PROYECTO, task_id: t3.datos.task_id, agent_name: AGENTE,
      error_message: 'atasco de verdad',
    });
    ok((await item(uViva)).status === 'blocked', 'la unidad viva queda bloqueada');
    const viva = await pedir('POST', `/tasks/${t3.datos.task_id}/resolve`,
      { instruction: 'ya esta la dependencia' }, galleta);
    ok(viva.status === 200, 'resolver responde', `HTTP ${viva.status}`);
    ok((await item(uViva)).status === 'ready', 'y la unidad viva SI vuelve a ready', (await item(uViva)).status);

    vista = await estadoEnPanel(galleta);
    ok(vista.overview === 'active', 'resuelto el atasco, el proyecto vuelve a active', vista.overview);
    ok(await enColumna() === 'pending', 'y el resolve tampoco escribe la columna', await enColumna());
  } finally {
    const tareas = await knex('tasks').where({ project_url: PROYECTO }).pluck('id');
    if (tareas.length) await knex('agent_logs').whereIn('task_id', tareas).del();
    await knex('backlog_items').where({ project_url: PROYECTO }).update({ active_task_id: null });
    await knex('semantic_documents').where({ project_url: PROYECTO }).del();
    await knex('tasks').where({ project_url: PROYECTO }).del();
    await knex('backlog_items').where({ project_url: PROYECTO }).del();
    await knex('projects').where({ url: PROYECTO }).del();
    console.log('\n(proyecto de prueba borrado)');
  }

  console.log(fallos === 0 ? '\nTODO VERDE' : `\n${fallos} COMPROBACIONES EN ROJO`);
  await knex.destroy();
  process.exit(fallos === 0 ? 0 : 1);
})().catch(async (e) => { console.error(e); await knex.destroy(); process.exit(1); });
