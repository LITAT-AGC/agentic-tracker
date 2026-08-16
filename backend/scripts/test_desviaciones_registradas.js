#!/usr/bin/env node
// Prueba dirigida del registro de desviaciones del contrato.
//
// Uso:  cd backend && APTS_BASE_URL=http://localhost:474xx/api node scripts/test_desviaciones_registradas.js
// Necesita el servidor de prueba levantado (el enganche vive en la ruta `/mcp`) y la base
// de prueba, para mirar las filas y limpiarlas. Crea su propio proyecto y lo borra entero.
//
// Lo que motiva la prueba: un rechazo del contrato es un agente intentando algo que la
// superficie no permite, y hasta ahora eso solo existia en el log de la aplicacion —rotado,
// sin agrupar y sin consultar—. La pregunta «¿que reglas intentan romper los agentes, y
// cuantas veces?» no se podia contestar, y las que se arreglaban salian de que un humano
// estuviera mirando en el momento justo: asi se encontro la del 2026-08-16, un agente
// cerrando la tarea que el conductor le habia prestado.
//
// Lo que se fija aqui es que la lista se pueda construir Y que no cueste nada de mas: que
// una llamada correcta no deje fila, y que la carga del agente —que puede traer secretos y
// texto de trabajo— no se guarde, solo sus claves.

const knex = require('knex')(require('../knexfile').test);

const BASE = (process.env.APTS_BASE_URL || 'http://localhost:47414/api').replace(/\/$/, '');
const MCP = BASE.replace(/\/api$/, '/mcp');
const API_KEY = process.env.APTS_API_KEY || 'default-dev-key';
const PROYECTO = 'https://example.invalid/prueba-desviaciones';
const AGENTE = 'prueba-desviaciones-dev';
const EMAIL = 'prueba-desviaciones@example.invalid';

let fallos = 0;
const ok = (cond, etiqueta, detalle) => {
  console.log(`${cond ? '  OK  ' : ' FALLA'} ${etiqueta}${detalle ? ` — ${detalle}` : ''}`);
  if (!cond) fallos += 1;
};

let seq = 0;
const llamar = async (herramienta, argumentos) => {
  seq += 1;
  const r = await fetch(MCP, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${API_KEY}`,
      'X-APTS-Project-Url': PROYECTO,
      'X-APTS-Agent-Name': AGENTE,
      'X-APTS-Agent-Email': EMAIL,
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: `desv-${seq}`, method: 'tools/call',
      params: { name: herramienta, arguments: argumentos || {} },
    }),
  });
  const sobre = await r.json();
  const texto = sobre?.result?.content?.[0]?.text;
  return {
    isError: Boolean(sobre?.result?.isError),
    datos: texto ? JSON.parse(texto) : null,
  };
};

const desviaciones = () => knex('agent_logs')
  .where({ action_type: 'deviation', agent_name: AGENTE })
  .orderBy('id', 'asc')
  .select('id', 'task_id', 'message', 'technical_details');

// El registro es best-effort y se dispara sin esperarlo: la peticion contesta antes de que
// la fila este escrita, asi que la prueba le da margen. Sondear en vez de dormir un numero
// fijo es lo que la hace fiable sin hacerla lenta.
const esperarFilas = async (cuantas, ms = 4000) => {
  const hasta = Date.now() + ms;
  for (;;) {
    const filas = await desviaciones();
    if (filas.length >= cuantas || Date.now() > hasta) return filas;
    await new Promise((r) => setTimeout(r, 100));
  }
};

const limpiar = async () => {
  const tareas = await knex('tasks').where({ project_url: PROYECTO }).pluck('id');
  if (tareas.length) await knex('agent_logs').whereIn('task_id', tareas).del();
  await knex('agent_logs').where({ agent_name: AGENTE }).del();
  await knex('tasks').where({ project_url: PROYECTO }).del();
  await knex('backlog_items').where({ project_url: PROYECTO }).del();
  await knex('projects').where({ url: PROYECTO }).del();
};

(async () => {
  try {
    const salud = await fetch(`${BASE}/health`).then((r) => r.json()).catch(() => null);
    if (!salud || salud.environment !== 'test') {
      console.error(`El servidor de ${BASE} no dice environment=test (dice ${salud && salud.environment}). No sigo.`);
      process.exit(1);
    }
    await limpiar();
    await knex('projects').insert({ url: PROYECTO, name: 'prueba desviaciones' }).onConflict('url').ignore();

    // ---- 0. una tarea de verdad, por la superficie de verdad ----
    const alta = await llamar('register_task', { title: 'prueba de desviaciones' });
    const tareaId = alta.datos && alta.datos.task_id;
    ok(Boolean(tareaId), 'la tarea se registra para tener sobre que desviarse', String(tareaId));
    ok((await desviaciones()).length === 0, 'y una llamada correcta NO deja fila');

    // ---- 1. la desviacion de verdad: una transicion ilegal ----
    // `in_progress -> done` no existe: el metodo exige pasar por `review`, que es la
    // compuerta. Es exactamente la clase de regla que un agente se salta.
    const salto = await llamar('update_task_status', { task_id: tareaId, status: 'done' });
    ok(salto.isError, 'el servidor la rechaza', JSON.stringify(salto.datos && salto.datos.error && salto.datos.error.code));

    const filas = await esperarFilas(1);
    ok(filas.length === 1, 'y queda UNA fila de desviacion', String(filas.length));

    const d = filas[0] || {};
    const td = typeof d.technical_details === 'string' ? JSON.parse(d.technical_details) : (d.technical_details || {});
    ok(td.operation === 'update_task_status', 'con la operacion', td.operation);
    ok(td.status === 409, 'con el codigo HTTP', String(td.status));
    ok(td.project_url === PROYECTO, 'con el proyecto', td.project_url);
    ok(d.task_id === tareaId, 'y atada a la tarea, que es como se investiga despues', String(d.task_id));

    // Lo que hace consultable la tabla: `GROUP BY operation, code`.
    ok(typeof td.code === 'string' && td.code.length > 0, 'y con un `code` para agrupar', String(td.code));

    // ---- 2. la carga no se guarda: solo sus claves ----
    ok(Array.isArray(td.argument_keys) && td.argument_keys.includes('task_id') && td.argument_keys.includes('status'),
      'guarda QUE campos venian', JSON.stringify(td.argument_keys));
    const serializada = JSON.stringify(td);
    ok(!serializada.includes(tareaId) || td.argument_keys.every((k) => k !== tareaId),
      'y no vuelca los valores dentro de technical_details');

    // ---- 3. lo correcto sigue sin costar fila ----
    const antes = (await desviaciones()).length;
    const legal = await llamar('update_task_status', { task_id: tareaId, status: 'review' });
    ok(!legal.isError, 'la transicion legal pasa', JSON.stringify(legal.datos && legal.datos.error));
    const despues = await esperarFilas(antes + 1, 1200);
    ok(despues.length === antes, 'y no deja desviacion', `${antes} -> ${despues.length}`);

    // ---- 4. una operacion que no existe tambien es desviacion del contrato ----
    // Es la forma en que se ve a un agente inventandose una herramienta.
    await llamar('get_backlog_item', { backlog_item_id: 'no-soy-un-uuid' });
    const conMalUuid = await esperarFilas(despues.length + 1);
    ok(conMalUuid.length === despues.length + 1,
      'un identificador con forma invalida queda registrado', String(conMalUuid.length));
    const ultima = conMalUuid[conMalUuid.length - 1];
    const tdUltima = typeof ultima.technical_details === 'string'
      ? JSON.parse(ultima.technical_details) : ultima.technical_details;
    ok(tdUltima.operation === 'get_backlog_item', '  con su operacion', tdUltima.operation);
    ok(tdUltima.status === 400, '  y su 400', String(tdUltima.status));

    // ---- 5. la otra mitad: lo que el servidor PERMITE y aun asi es una desviacion ----
    //
    // El caso real del 2026-08-16: el agente cierra la tarea que el conductor le presto,
    // con la unidad todavia abierta. Es legal —`review -> done` existe— e inofensivo, y por
    // eso no se rechaza; pero es exactamente lo que el prompt le pide que no haga, y sin
    // esta fila no habria forma de saber cuantas veces pasa.
    const unidad = await knex('backlog_items').insert({
      project_url: PROYECTO, title: 'unidad prestada', item_type: 'feature', status: 'in_progress',
    }).returning(['id']).then(([f]) => f.id);

    const prestada = await llamar('register_task', {
      title: 'tarea que abre el conductor',
      backlog_item_id: unidad,
      owns_backlog_item: false,
      context: JSON.stringify({ conductor: 'apts-loop', story_id: unidad, iteracion: 1 }),
    });
    const prestadaId = prestada.datos && prestada.datos.task_id;
    ok(Boolean(prestadaId), 'el conductor abre su tarea', String(prestadaId));

    const antesDelCierre = (await desviaciones()).length;
    await llamar('log_agent_progress', { task_id: prestadaId, message: 'trabajando' });
    await llamar('update_task_status', { task_id: prestadaId, status: 'review' });
    const cierre = await llamar('update_task_status', { task_id: prestadaId, status: 'done' });
    ok(!cierre.isError, 'el servidor la deja cerrar: no se prohibe',
      JSON.stringify(cierre.datos && cierre.datos.error));

    const conPermitida = await esperarFilas(antesDelCierre + 1);
    const permitida = conPermitida[conPermitida.length - 1] || {};
    const tdPermitida = typeof permitida.technical_details === 'string'
      ? JSON.parse(permitida.technical_details) : (permitida.technical_details || {});
    ok(tdPermitida.outcome === 'allowed', 'pero queda registrada como permitida', tdPermitida.outcome);
    ok(tdPermitida.rule === 'tarea-del-conductor-no-se-cierra-con-la-unidad-abierta',
      'con el nombre de la regla, que es por lo que se agrupa', tdPermitida.rule);
    ok(permitida.task_id === prestadaId, 'y atada a la tarea', String(permitida.task_id));

    // El camino del conductor NO deja fila: el cierra despues de que el motor pase a otra
    // unidad, es decir con la unidad ya terminal. Sin esta comprobacion el contador subiria
    // una vez por unidad y no serviria para nada.
    const unidadCerrada = await knex('backlog_items').insert({
      project_url: PROYECTO, title: 'unidad ya cerrada', item_type: 'feature', status: 'done',
    }).returning(['id']).then(([f]) => f.id);
    const delConductor = await llamar('register_task', {
      title: 'tarea que cierra el conductor',
      backlog_item_id: unidadCerrada,
      owns_backlog_item: false,
      context: JSON.stringify({ conductor: 'apts-loop', story_id: unidadCerrada, iteracion: 2 }),
    });
    const delConductorId = delConductor.datos && delConductor.datos.task_id;
    const antesDelConductor = (await desviaciones()).length;
    await llamar('log_agent_progress', { task_id: delConductorId, message: 'cerrando' });
    await llamar('update_task_status', { task_id: delConductorId, status: 'review' });
    await llamar('update_task_status', { task_id: delConductorId, status: 'done' });
    const trasConductor = await esperarFilas(antesDelConductor + 1, 1500);
    ok(trasConductor.length === antesDelConductor,
      'el cierre del conductor, con la unidad ya terminal, no deja fila',
      `${antesDelConductor} -> ${trasConductor.length}`);

    // ---- 6. la consulta que justifica todo esto ----
    const resumen = await knex('agent_logs')
      .where({ action_type: 'deviation', agent_name: AGENTE })
      .select(
        knex.raw("technical_details->>'rule' as regla"),
        knex.raw("technical_details->>'outcome' as resultado"),
        knex.raw('count(*)::int as veces')
      )
      .groupBy('regla', 'resultado')
      .orderBy('veces', 'desc');
    ok(resumen.length === 3, 'la lista priorizada sale de una consulta', JSON.stringify(resumen));
    ok(resumen.some((f) => f.resultado === 'allowed') && resumen.some((f) => f.resultado === 'rejected'),
      'y distingue lo rechazado de lo permitido, que son dos preguntas distintas');
  } finally {
    await limpiar();
    console.log('\n(filas de prueba borradas)');
  }

  console.log(fallos === 0 ? '\nTODO VERDE' : `\n${fallos} COMPROBACIONES EN ROJO`);
  await knex.destroy();
  process.exit(fallos === 0 ? 0 : 1);
})().catch(async (e) => { console.error(e); await knex.destroy(); process.exit(1); });
