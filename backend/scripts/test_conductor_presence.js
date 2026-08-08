#!/usr/bin/env node
// Prueba dirigida de la senal de vida del conductor: distinguir una orden encolada que se
// recogera en diez segundos de una dirigida a un conductor que no esta corriendo.
//
// Uso:  cd backend && APTS_BASE_URL=http://localhost:474xx/api node scripts/test_conductor_presence.js
// Necesita el servidor de prueba levantado —la presencia vive en la memoria de ESE proceso,
// asi que no se puede comprobar sin el— y la base de prueba, para limpiar. Crea su propio
// proyecto y lo borra entero al terminar.
//
// Conviene arrancarlo con `CONDUCTOR_PRESENCE_TTL_MS` corto (3000) en el servidor Y aqui:
// con el plazo real, ver caducar una senal cuesta un minuto de espera.
//
// Lo que motiva las dos comprobaciones centrales: el buzon solo lo atiende quien esta
// corriendo, y hasta ahora una orden a un conductor apagado se quedaba `pending` para
// siempre con el mismo aspecto que una que se recoge en el sondeo siguiente.

const knex = require('knex')(require('../knexfile').test);

const BASE = (process.env.APTS_BASE_URL || 'http://localhost:47399/api').replace(/\/$/, '');
const API_KEY = process.env.APTS_API_KEY || 'default-dev-key';
const CLAVE_PANEL = process.env.DASHBOARD_PASSWORD || 'admin';
const TTL_MS = Number.parseInt(process.env.CONDUCTOR_PRESENCE_TTL_MS, 10) > 0
  ? Number.parseInt(process.env.CONDUCTOR_PRESENCE_TTL_MS, 10)
  : 60000;

const PROYECTO = 'https://example.invalid/prueba-presencia-conductor';
const VIVO = 'prueba-presencia-vivo';
const APAGADO = 'prueba-presencia-apagado';
const EMAIL = 'prueba-presencia@example.invalid';

let fallos = 0;
const ok = (cond, etiqueta, detalle) => {
  console.log(`${cond ? '  OK  ' : ' FALLA'} ${etiqueta}${detalle ? ` — ${detalle}` : ''}`);
  if (!cond) fallos += 1;
};

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

const pedir = async (metodo, ruta, cuerpo, extra = {}) => {
  const r = await fetch(`${BASE}${ruta}`, {
    method: metodo,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
      'X-APTS-Project-Url': PROYECTO,
      'X-APTS-Agent-Name': extra.agente || VIVO,
      'X-APTS-Agent-Email': EMAIL,
      ...(extra.headers || {}),
    },
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  const texto = await r.text();
  let datos = null;
  try { datos = texto ? JSON.parse(texto) : null; } catch (_) { datos = { raw: texto }; }
  return { status: r.status, datos, cookie: r.headers.get('set-cookie') };
};

const presenciaDe = (estado, nombre) => (estado.presence || []).find((p) => p.agent_name === nombre) || null;

(async () => {
  await knex('projects').insert({ url: PROYECTO, name: 'prueba presencia' }).onConflict('url').ignore();

  try {
    const login = await pedir('POST', '/login', { password: CLAVE_PANEL });
    ok(login.status === 200, 'sesion de panel abierta', `HTTP ${login.status}`);
    const galleta = { headers: { Cookie: (login.cookie || '').split(';')[0] } };

    const estado = async (nombre) => {
      const r = await pedir(
        'GET',
        `/dashboard/projects/${encodeURIComponent(PROYECTO)}/conductor?agent_name=${encodeURIComponent(nombre)}`,
        undefined,
        galleta,
      );
      return r.datos;
    };

    // ---- 1. nadie ha sondeado todavia: no hay senal de ese nombre ----
    const e1 = await estado(VIVO);
    const p1 = presenciaDe(e1, VIVO);
    ok(Boolean(p1), 'la respuesta trae presencia del conductor consultado');
    ok(p1 && p1.listening === false, 'un conductor que no ha sondeado no esta escuchando');
    ok(p1 && p1.last_seen_at === null, 'y no consta ninguna senal suya', String(p1 && p1.last_seen_at));
    ok(Number.isFinite(e1.server_uptime_seconds), 'la respuesta dice cuanto lleva el servidor en pie',
      `${e1.server_uptime_seconds}s`);
    ok(e1.presence_ttl_seconds === Math.round(TTL_MS / 1000), 'y el plazo con el que se juzga la senal',
      `${e1.presence_ttl_seconds}s`);

    // ---- 2. una orden encolada a un conductor apagado ----
    // De paso, el comando retirado: `stop` era `pause` con otro nombre y ya no se acepta.
    // El rechazo tiene que NOMBRAR los que si valen, que es lo unico que convierte un 400
    // en una respuesta util para quien traiga un panel cacheado con el boton viejo.
    const retirada = await pedir('POST', '/dashboard/conductor/orders',
      { command: 'stop', agent_name: VIVO, project_url: PROYECTO }, galleta);
    ok(retirada.status === 400, 'el comando retirado `stop` se rechaza en vez de colarse como un pause',
      `HTTP ${retirada.status}`);
    ok(/pause/.test((retirada.datos && retirada.datos.error) || '') && !/stop/.test((retirada.datos && retirada.datos.error) || ''),
      'y el error nombra los tres que valen, sin el retirado', retirada.datos && retirada.datos.error);

    const orden = await pedir('POST', '/dashboard/conductor/orders',
      { command: 'pause', agent_name: VIVO, project_url: PROYECTO }, galleta);
    ok(orden.status === 200, 'el panel encola la orden igual: escribir la fila siempre funciona', `HTTP ${orden.status}`);
    const e2 = await estado(VIVO);
    const pendiente = (e2.orders || []).find((o) => o.id === orden.datos.order.id);
    ok(pendiente && pendiente.status === 'pending', 'y la orden sigue pendiente');
    ok(presenciaDe(e2, VIVO).listening === false, 'con el destinatario todavia sin dar senal: eso es lo que faltaba poder ver');

    // ---- 3. el conductor sondea el buzon: eso es la senal ----
    const sondeo = await pedir('GET', `/conductor/orders/next?agent_name=${encodeURIComponent(VIVO)}`);
    ok(sondeo.status === 200, 'el conductor sondea su buzon', `HTTP ${sondeo.status}`);
    ok(sondeo.datos.order && sondeo.datos.order.id === orden.datos.order.id, 'y recibe la orden que le esperaba');

    const e3 = await estado(VIVO);
    const p3 = presenciaDe(e3, VIVO);
    ok(p3.listening === true, 'ahora consta escuchando');
    ok(p3.last_seen_at !== null && p3.seconds_ago !== null && p3.seconds_ago < 5,
      'con la senal recien puesta', `hace ${p3 && p3.seconds_ago}s`);

    // ---- 4. dos destinatarios en la misma respuesta ----
    const ordenApagado = await pedir('POST', '/dashboard/conductor/orders',
      { command: 'pause', agent_name: APAGADO, project_url: PROYECTO }, galleta);
    ok(ordenApagado.status === 200, 'se encola otra orden a un nombre que nunca sondeo', `HTTP ${ordenApagado.status}`);
    const e4 = await estado(VIVO);
    ok(presenciaDe(e4, VIVO).listening === true, 'el consultado sigue escuchando');
    const pApagado = presenciaDe(e4, APAGADO);
    ok(Boolean(pApagado), 'y la presencia del OTRO destinatario tambien viaja, por su orden pendiente');
    ok(pApagado && pApagado.listening === false && pApagado.last_seen_at === null,
      'sin nadie al otro lado: la orden espera en el buzon');

    // ---- 5. el acuse tambien es senal, y sirve para el nombre que acusa ----
    const ack = await pedir('POST', `/conductor/orders/${ordenApagado.datos.order.id}/ack`,
      { status: 'done', detail: 'sin nada corriendo' }, { agente: APAGADO });
    ok(ack.status === 200, 'el conductor acusa una orden', `HTTP ${ack.status}`);
    const e5 = await estado(APAGADO);
    ok(presenciaDe(e5, APAGADO).listening === true, 'y acusar cuenta como senal de vida');
    const acusada = (e5.orders || []).find((o) => o.id === ordenApagado.datos.order.id);
    ok(acusada && acusada.status === 'done', 'la orden acusada deja de estar pendiente', acusada && acusada.status);

    // ---- 6. una orden que ya no esta pendiente no arrastra a su destinatario ----
    const e6 = await estado(VIVO);
    ok(!presenciaDe(e6, APAGADO), 'la presencia solo se calcula para pendientes y para el consultado');

    // ---- 7. caducar es dejar de escuchar, no dejar de existir ----
    await dormir(TTL_MS + 1200);
    const e7 = await estado(VIVO);
    const p7 = presenciaDe(e7, VIVO);
    ok(p7.listening === false, `pasado el plazo (${Math.round(TTL_MS / 1000)}s) ya no consta escuchando`);
    ok(p7.last_seen_at !== null, 'pero SI cuando hablo por ultima vez: callado no es lo mismo que apagado');
    ok(p7.seconds_ago >= Math.round(TTL_MS / 1000), 'y cuanto hace de eso', `hace ${p7.seconds_ago}s`);

    // ---- 8. el diario tambien sella ----
    const tarea = await pedir('POST', '/projects/tasks', {
      project_url: PROYECTO, title: 'tarea de la prueba de presencia', agent_name: VIVO, agent_email: EMAIL,
    });
    ok(tarea.status === 200, 'se registra una tarea para poder escribir diario', `HTTP ${tarea.status}`);
    const diario = await pedir('POST', '/conductor/journal', {
      task_id: tarea.datos.task_id, agent_name: VIVO, message: 'iteracion 1', event: { evento: 'prueba' },
    });
    ok(diario.status === 200, 'el conductor escribe en su diario', `HTTP ${diario.status}`);
    const e8 = await estado(VIVO);
    ok(presenciaDe(e8, VIVO).listening === true, 'y eso lo devuelve a escuchando sin esperar al sondeo siguiente');

    // ---- 9. sin nombre consultado no se inventa presencia ----
    const sinNombre = await pedir('GET',
      `/dashboard/projects/${encodeURIComponent(PROYECTO)}/conductor`, undefined, galleta);
    ok(sinNombre.status === 200, 'el estado se puede pedir sin nombre', `HTTP ${sinNombre.status}`);
    ok(Array.isArray(sinNombre.datos.presence), 'y la clave viaja igual');
    ok(!sinNombre.datos.presence.some((p) => p.agent_name === ''), 'sin filas vacias por el nombre que no se dio');
  } finally {
    const tareas = await knex('tasks').where({ project_url: PROYECTO }).pluck('id');
    if (tareas.length) await knex('agent_logs').whereIn('task_id', tareas).del();
    await knex('conductor_orders').where({ project_url: PROYECTO }).del();
    await knex('conductor_orders').whereIn('agent_name', [VIVO, APAGADO]).del();
    await knex('semantic_documents').where({ project_url: PROYECTO }).del();
    await knex('tasks').where({ project_url: PROYECTO }).del();
    await knex('projects').where({ url: PROYECTO }).del();
    console.log('\n(proyecto de prueba borrado)');
  }

  console.log(fallos === 0 ? '\nTODO VERDE' : `\n${fallos} COMPROBACIONES EN ROJO`);
  await knex.destroy();
  process.exit(fallos === 0 ? 0 : 1);
})().catch(async (e) => { console.error(e); await knex.destroy(); process.exit(1); });
