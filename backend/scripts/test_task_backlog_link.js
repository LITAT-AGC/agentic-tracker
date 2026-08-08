#!/usr/bin/env node
// Prueba dirigida de la separacion entre ASOCIAR y POSEER una unidad.
//
// Uso:  cd backend && APTS_BASE_URL=http://localhost:474xx/api node scripts/test_task_backlog_link.js
// Necesita el servidor de prueba levantado (la validacion del campo vive en el esquema
// HTTP/MCP, no en el motor) y la base de prueba, que se usa para mirar las columnas por
// dentro y para limpiar. Crea su propio proyecto y lo borra entero al terminar.
//
// Lo que hay que demostrar es que son dos cosas y no una:
//   - `backlog_item_id` asocia: `tasks.backlog_item_id`, permanente y sin efectos.
//   - la posesion es `backlog_items.active_task_id`, y es lo UNICO que propaga estado.
// Y que lo que ya propagaba sigue propagando exactamente igual.

const knex = require('knex')(require('../knexfile').test);

const BASE = (process.env.APTS_BASE_URL || 'http://localhost:47411/api').replace(/\/$/, '');
const MCP = BASE.replace(/\/api$/, '') + '/mcp';
const API_KEY = process.env.APTS_API_KEY || 'default-dev-key';
const URL = 'https://example.invalid/prueba-asociar-vs-poseer';
const AGENTE = 'prueba-asociacion-dev';
const EMAIL = 'prueba-asociacion@example.invalid';

let fallos = 0;
const ok = (cond, etiqueta, detalle) => {
  console.log(`${cond ? '  OK  ' : ' FALLA'} ${etiqueta}${detalle ? ` — ${detalle}` : ''}`);
  if (!cond) fallos += 1;
};

const cabeceras = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${API_KEY}`,
  'X-APTS-Project-Url': URL,
  'X-APTS-Agent-Name': AGENTE,
  'X-APTS-Agent-Email': EMAIL,
};

const http = async (metodo, ruta, cuerpo) => {
  const r = await fetch(`${BASE}${ruta}`, {
    method: metodo,
    headers: cabeceras,
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  const texto = await r.text();
  let datos = null;
  try { datos = texto ? JSON.parse(texto) : null; } catch (_) { datos = { raw: texto }; }
  return { status: r.status, datos };
};

let idSeq = 0;
const mcp = async (herramienta, argumentos) => {
  const r = await fetch(MCP, {
    method: 'POST',
    headers: { ...cabeceras, Accept: 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `prueba-${(idSeq += 1)}`,
      method: 'tools/call',
      params: { name: herramienta, arguments: argumentos || {} },
    }),
  });
  const sobre = await r.json();
  const texto = sobre.result && sobre.result.content && sobre.result.content[0]
    ? sobre.result.content[0].text
    : null;
  const datos = texto ? JSON.parse(texto) : null;
  return { isError: Boolean(sobre.result && sobre.result.isError), datos };
};

const item = (id) => knex('backlog_items').where({ id }).first('id', 'status', 'active_task_id');
const tarea = (id) => knex('tasks').where({ id }).first('id', 'status', 'backlog_item_id');

(async () => {
  // ---- montaje: proyecto y tres unidades, una por escenario ----
  await knex('projects').insert({ url: URL, name: 'prueba asociar vs poseer' })
    .onConflict('url').ignore();
  const insertadas = await knex('backlog_items').insert([
    { project_url: URL, title: 'unidad que se posee', item_type: 'feature', status: 'ready' },
    { project_url: URL, title: 'unidad que solo se asocia', item_type: 'feature', status: 'ready' },
    { project_url: URL, title: 'unidad de la propagacion', item_type: 'feature', status: 'ready' },
  ]).returning(['id']);
  const [uPosee, uAsocia, uPropaga] = insertadas.map((f) => f.id);

  try {
    // ---- 1. el camino de siempre no cambia: asociar Y poseer ----
    const r1 = await http('POST', '/projects/tasks', {
      project_url: URL, title: 'tarea dueña', agent_name: AGENTE, agent_email: EMAIL,
      backlog_item_id: uPosee,
    });
    ok(r1.status === 201 || r1.status === 200, 'register_task sin el campo sigue aceptandose', `HTTP ${r1.status}`);
    ok(r1.datos && r1.datos.owns_backlog_item === true, 'y se declara dueña por defecto', JSON.stringify(r1.datos && r1.datos.owns_backlog_item));
    const t1 = await tarea(r1.datos.task_id);
    const i1 = await item(uPosee);
    ok(t1.backlog_item_id === uPosee, 'la tarea queda asociada a la unidad');
    ok(i1.active_task_id === r1.datos.task_id, 'y es la tarea activa de la unidad');
    ok(i1.status === 'in_progress', 'la unidad pasa a in_progress', i1.status);

    // La reanudacion, que es la via de recuperacion de una tarea muerta, sigue viva.
    const r1b = await http('POST', '/projects/tasks', {
      project_url: URL, title: 'segunda llamada', agent_name: AGENTE, agent_email: EMAIL,
      backlog_item_id: uPosee,
    });
    ok(r1b.datos.task_id === r1.datos.task_id, 'una segunda llamada reanuda en vez de duplicar');
    ok(r1b.datos.resumed === true, 'y lo dice');

    // ---- 2. asociar sin poseer ----
    const antes = await item(uAsocia);
    const r2 = await http('POST', '/projects/tasks', {
      project_url: URL, title: 'tarea asociada', agent_name: AGENTE, agent_email: EMAIL,
      backlog_item_id: uAsocia, owns_backlog_item: false,
    });
    ok(r2.status === 201 || r2.status === 200, 'register_task con owns_backlog_item: false se acepta', `HTTP ${r2.status}`);
    ok(r2.datos.owns_backlog_item === false, 'y lo devuelve, que es como un cliente puede saber que el servidor lo entendio');
    const t2 = await tarea(r2.datos.task_id);
    const i2 = await item(uAsocia);
    ok(t2.backlog_item_id === uAsocia, 'la tarea queda asociada igual que la dueña');
    ok(i2.active_task_id === antes.active_task_id, 'la tarea activa de la unidad no se toco', String(i2.active_task_id));
    ok(i2.status === 'ready', 'y la unidad no se movio de estado', i2.status);

    // Sin posesion no hay a quien reanudar, y eso se quiere: cada pasada es una ejecucion.
    const r2b = await http('POST', '/projects/tasks', {
      project_url: URL, title: 'segunda ejecucion', agent_name: AGENTE, agent_email: EMAIL,
      backlog_item_id: uAsocia, owns_backlog_item: false,
    });
    ok(r2b.datos.task_id !== r2.datos.task_id, 'una segunda llamada crea otra tarea en vez de reanudar');
    ok(r2b.datos.resumed === false, 'y no dice que reanudo');
    const historial = await knex('tasks').where({ backlog_item_id: uAsocia }).count('* as n').first();
    ok(Number(historial.n) === 2, 'las dos ejecuciones cuelgan de la unidad — esto es el historial que no existia', `n=${historial.n}`);

    // ---- 3. la propagacion sigue colgando SOLO de la posesion ----
    const rDuena = await http('POST', '/projects/tasks', {
      project_url: URL, title: 'dueña que cierra', agent_name: AGENTE, agent_email: EMAIL,
      backlog_item_id: uPropaga,
    });
    const rAsoc = await http('POST', '/projects/tasks', {
      project_url: URL, title: 'asociada que no cierra', agent_name: AGENTE, agent_email: EMAIL,
      backlog_item_id: uPropaga, owns_backlog_item: false,
    });
    // La asociada se mueve entera hasta `done` sin arrastrar nada.
    await http('PATCH', `/tasks/${rAsoc.datos.task_id}/status`, { status: 'review', project_url: URL, agent_name: AGENTE, agent_email: EMAIL });
    const rCierre = await http('PATCH', `/tasks/${rAsoc.datos.task_id}/status`, { status: 'done', project_url: URL, agent_name: AGENTE, agent_email: EMAIL });
    ok(rCierre.status === 200, 'la tarea asociada puede cerrarse', `HTTP ${rCierre.status}`);
    const iTrasAsoc = await item(uPropaga);
    ok(iTrasAsoc.status === 'in_progress', 'y la unidad NO se cerro con ella', iTrasAsoc.status);
    ok(iTrasAsoc.active_task_id === rDuena.datos.task_id, 'la dueña sigue siendo la dueña');
    // Y la dueña sigue arrastrando, que es lo que no se podia romper.
    await http('PATCH', `/tasks/${rDuena.datos.task_id}/status`, { status: 'review', project_url: URL, agent_name: AGENTE, agent_email: EMAIL });
    await http('PATCH', `/tasks/${rDuena.datos.task_id}/status`, { status: 'done', project_url: URL, agent_name: AGENTE, agent_email: EMAIL });
    const iTrasDuena = await item(uPropaga);
    ok(iTrasDuena.status === 'done', 'la tarea dueña SI cierra la unidad — nada de lo que propagaba dejo de propagar', iTrasDuena.status);
    ok(iTrasDuena.active_task_id === null, 'y suelta el puntero al cerrar');
    const tAsocFinal = await tarea(rAsoc.datos.task_id);
    ok(tAsocFinal.backlog_item_id === uPropaga, 'la asociada conserva su asociacion despues de cerrada — es historial, no estado');

    // ---- 4. lo que se rechaza ----
    const sinItem = await http('POST', '/projects/tasks', {
      project_url: URL, title: 'sin item', agent_name: AGENTE, agent_email: EMAIL,
      owns_backlog_item: false,
    });
    ok(sinItem.status === 400, 'owns_backlog_item sin backlog_item_id da 400', `HTTP ${sinItem.status}`);
    ok(/owns_backlog_item requires backlog_item_id/.test(JSON.stringify(sinItem.datos)), 'nombrando lo que falta');
    const basura = await http('POST', '/projects/tasks', {
      project_url: URL, title: 'valor raro', agent_name: AGENTE, agent_email: EMAIL,
      backlog_item_id: uAsocia, owns_backlog_item: 'quizas',
    });
    ok(basura.status === 400, 'un valor que no es booleano da 400 en vez de colar como false', `HTTP ${basura.status}`);

    // ---- 5. la asociacion se puede leer ----
    const completa = await http('GET', `/tasks/${r2.datos.task_id}`);
    ok(completa.datos.task.backlog_item_id === uAsocia, 'get_task (vista completa) devuelve la asociacion');
    const compacta = await http('GET', `/tasks/${r2.datos.task_id}?view=compact`);
    ok(compacta.datos.task.backlog_item_id === uAsocia, 'get_task (compact) tambien');
    const suelta = await http('POST', '/projects/tasks', {
      project_url: URL, title: 'tarea sin unidad', agent_name: AGENTE, agent_email: EMAIL,
    });
    const sueltaCompacta = await http('GET', `/tasks/${suelta.datos.task_id}?view=compact`);
    ok(!('backlog_item_id' in sueltaCompacta.datos.task), 'y en compact una tarea sin unidad no paga la clave vacia');

    // ---- 6. por MCP, que es la superficie real de un agente ----
    const porMcp = await mcp('register_task', {
      title: 'tarea por MCP', backlog_item_id: uAsocia, owns_backlog_item: false,
    });
    ok(!porMcp.isError && porMcp.datos.owns_backlog_item === false, 'register_task por MCP acepta el campo');
    const iMcp = await item(uAsocia);
    ok(iMcp.active_task_id === antes.active_task_id, 'y tampoco toca la tarea activa de la unidad');
    const malPorMcp = await mcp('register_task', { title: 'sin item por MCP', owns_backlog_item: true });
    ok(malPorMcp.isError, 'y el rechazo llega como isError, no como un 200 que no hizo nada');
  } finally {
    // ---- limpieza: el proyecto entero, para no dejar residuo en la base de prueba ----
    const tareas = await knex('tasks').where({ project_url: URL }).pluck('id');
    if (tareas.length) await knex('agent_logs').whereIn('task_id', tareas).del();
    await knex('backlog_items').where({ project_url: URL }).update({ active_task_id: null });
    await knex('semantic_documents').where({ project_url: URL }).del();
    await knex('tasks').where({ project_url: URL }).del();
    await knex('backlog_items').where({ project_url: URL }).del();
    await knex('projects').where({ url: URL }).del();
    console.log('\n(proyecto de prueba borrado: la base queda como estaba)');
  }

  console.log(fallos === 0 ? '\nTODO VERDE' : `\n${fallos} COMPROBACIONES EN ROJO`);
  await knex.destroy();
  process.exit(fallos === 0 ? 0 : 1);
})().catch(async (e) => { console.error(e); await knex.destroy(); process.exit(1); });
