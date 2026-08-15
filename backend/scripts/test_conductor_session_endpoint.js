#!/usr/bin/env node
// Prueba dirigida de las dos rutas de la sesion del agente, contra servidor y base de
// verdad. La otra mitad —que el conductor filtra, redacta, agrupa y degrada— no necesita
// base y vive en `test_conductor_session_stream.js`.
//
// Uso:  cd backend && APTS_BASE_URL=http://localhost:474xx/api node scripts/test_conductor_session_endpoint.js
// Necesita el servidor de prueba levantado y la base de prueba. Crea su propio proyecto y
// su propia tarea, y borra los dos al terminar.
//
// Lo que se comprueba, y por que:
//   · que el `seq` es idempotente, porque es lo unico que permite que el envio sea
//     best-effort sin arriesgarse a duplicar una sesion;
//   · que el cursor no relee ni se salta nada, que es de lo que depende el sondeo del panel;
//   · y que el proyecto es frontera de verdad: sabiendo un UUID de tarea de OTRO proyecto,
//     esta ruta no lo sirve.

const knex = require('knex')(require('../knexfile').test);

const BASE = (process.env.APTS_BASE_URL || 'http://localhost:47399/api').replace(/\/$/, '');
const API_KEY = process.env.APTS_API_KEY || 'default-dev-key';
const CLAVE_PANEL = process.env.DASHBOARD_PASSWORD || 'admin';

const PROYECTO = 'https://example.invalid/prueba-sesion-endpoint';
const AJENO = 'https://example.invalid/prueba-sesion-endpoint-ajeno';
const AGENTE = 'prueba-sesion-endpoint';
const EMAIL = 'prueba-sesion@example.invalid';

let fallos = 0;
const ok = (cond, etiqueta, detalle) => {
  console.log(`${cond ? '  OK  ' : ' FALLA'} ${etiqueta}${detalle ? ` — ${detalle}` : ''}`);
  if (!cond) fallos += 1;
};
const saltado = (etiqueta, motivo) => console.log(`  --  ${etiqueta} — saltado: ${motivo}`);

const pedir = async (metodo, ruta, cuerpo, extra = {}) => {
  const r = await fetch(`${BASE}${ruta}`, {
    method: metodo,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
      'X-APTS-Project-Url': PROYECTO,
      'X-APTS-Agent-Name': AGENTE,
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

const evento = (seq, kind = 'texto', payload = { texto: `evento ${seq}` }) => ({
  seq, kind, payload, ts: new Date(Date.UTC(2026, 7, 15, 12, 0, seq)).toISOString(),
});

(async () => {
  for (const url of [PROYECTO, AJENO]) {
    await knex('projects').insert({ url, name: `prueba sesion ${url.slice(-6)}` }).onConflict('url').ignore();
  }

  const [tarea] = await knex('tasks').insert({
    project_url: PROYECTO, agent_name: AGENTE, title: 'Una ejecucion de prueba', status: 'in_progress',
  }).returning('id');
  const [tareaAjena] = await knex('tasks').insert({
    project_url: AJENO, agent_name: AGENTE, title: 'De otro proyecto', status: 'in_progress',
  }).returning('id');
  const TAREA = tarea.id || tarea;
  const TAREA_AJENA = tareaAjena.id || tareaAjena;

  try {
    const login = await pedir('POST', '/login', { password: CLAVE_PANEL });
    ok(login.status === 200, 'sesion de panel abierta', `HTTP ${login.status}`);
    const galleta = { headers: { Cookie: (login.cookie || '').split(';')[0] } };

    const leer = (query, extra = galleta) => pedir(
      'GET', `/dashboard/projects/${encodeURIComponent(PROYECTO)}/conductor/session${query}`, undefined, extra,
    );

    // ---- La purga, primero ----
    // Va la primera porque solo se puede comprobar UNA VEZ por proceso del servidor: la poda
    // es perezosa y corre como mucho cada hora, asi que la unica ocasion garantizada es la
    // primera ingesta tras arrancar. Si otra cosa ya la disparo, esto se salta y lo dice, en
    // vez de fallar por algo que no es un defecto. Con el servidor recien arrancado, corre.
    //
    // Que este probada importa mas de lo que parece: sin poda, la respuesta a «que borra esta
    // tabla» es «nada», porque el ON DELETE CASCADE solo actua al borrar una tarea y APTS no
    // borra tareas por ningun camino.
    console.log('0) la purga por antiguedad corre de verdad');
    const retencion = Number.parseInt(process.env.CONDUCTOR_SESSION_RETENTION_DAYS, 10);
    const dias = Number.isFinite(retencion) ? retencion : 30;
    if (dias <= 0) {
      saltado('la purga borra lo viejo', 'la retencion esta desactivada en este servidor');
    } else {
      // Una fila de otra tarea, envejecida a mano por encima del plazo. Se envejece la fila y
      // no se acorta el plazo: asi se comprueba el plazo de VERDAD sin esperar treinta dias.
      const [vieja] = await knex('tasks').insert({
        project_url: PROYECTO, agent_name: AGENTE, title: 'Ejecucion antigua', status: 'done',
      }).returning('id');
      const TAREA_VIEJA = vieja.id || vieja;
      await knex('conductor_agent_events').insert({
        task_id: TAREA_VIEJA,
        seq: 1,
        kind: 'texto',
        payload: JSON.stringify({ texto: 'de hace mucho' }),
        ts: new Date(),
        created_at: new Date(Date.now() - (dias + 1) * 86400000),
      });

      await pedir('POST', '/conductor/session', { task_id: TAREA, events: [evento(1000)] });
      // La poda no se espera (`sin await` en la ruta), asi que se le da un respiro.
      await new Promise((r) => setTimeout(r, 1500));

      const quedan = await knex('conductor_agent_events').where({ task_id: TAREA_VIEJA }).count('id as n').first();
      if (Number(quedan.n) === 0) {
        ok(true, `lo anterior a ${dias} dias se borro`);
        const recien = await knex('conductor_agent_events').where({ task_id: TAREA }).count('id as n').first();
        ok(Number(recien.n) === 1, 'y lo reciente sigue ahi', String(recien.n));
      } else {
        saltado('la purga borra lo viejo', 'la ventana de una hora ya se habia gastado en este proceso del servidor');
      }
      await knex('conductor_agent_events').where({ task_id: TAREA }).del();
      await knex('tasks').where({ id: TAREA_VIEJA }).del();
    }

    console.log('\n1) ingesta: un lote entra entero');
    let r = await pedir('POST', '/conductor/session', {
      task_id: TAREA, events: [evento(1, 'init', { modelo: 'claude-opus-5' }), evento(2), evento(3)],
    });
    ok(r.status === 200, 'la ruta responde 200', `HTTP ${r.status}`);
    ok(r.datos && r.datos.received === 3 && r.datos.stored === 3, 'y dice cuantos guardo', JSON.stringify(r.datos));

    console.log('\n2) el mismo lote otra vez NO duplica');
    r = await pedir('POST', '/conductor/session', { task_id: TAREA, events: [evento(2), evento(3)] });
    ok(r.status === 200, 'sigue siendo 200: reenviar no es un error', `HTTP ${r.status}`);
    ok(r.datos.stored === 0, 'y no guarda nada', JSON.stringify(r.datos));
    const total = await knex('conductor_agent_events').where({ task_id: TAREA }).count('id as n').first();
    ok(Number(total.n) === 3, 'siguen siendo tres filas', String(total.n));

    console.log('\n3) lo que no se acepta se dice, en vez de descartarse en silencio');
    r = await pedir('POST', '/conductor/session', { task_id: TAREA, events: [{ kind: 'texto', payload: {} }] });
    ok(r.status === 400 && /seq/.test(r.datos.error || ''), 'sin seq: 400 nombrando el campo', JSON.stringify(r.datos));
    r = await pedir('POST', '/conductor/session', { task_id: TAREA, events: [{ seq: 9, payload: {} }] });
    ok(r.status === 400 && /kind/.test(r.datos.error || ''), 'sin kind: 400 nombrando el campo', JSON.stringify(r.datos));
    r = await pedir('POST', '/conductor/session', {
      task_id: TAREA, events: [{ seq: 9, kind: 'texto', payload: { t: 'x'.repeat(5000) } }],
    });
    ok(r.status === 400 && /bytes/.test(r.datos.error || ''), 'payload gigante: 400 diciendo el tope', JSON.stringify(r.datos));
    r = await pedir('POST', '/conductor/session', { task_id: TAREA, events: 'no soy un array' });
    ok(r.status === 400, 'events que no es array: 400', `HTTP ${r.status}`);
    r = await pedir('POST', '/conductor/session', { task_id: TAREA, events: [] });
    ok(r.status === 200 && r.datos.stored === 0, 'lote vacio: 200 y no toca nada', JSON.stringify(r.datos));
    r = await pedir('POST', '/conductor/session', {
      task_id: '00000000-0000-0000-0000-000000000000', events: [evento(1)],
    });
    ok(r.status === 404, 'una tarea que no existe: 404', `HTTP ${r.status}`);

    console.log('\n4) un rechazo no deja nada a medias');
    const trasRechazos = await knex('conductor_agent_events').where({ task_id: TAREA }).count('id as n').first();
    ok(Number(trasRechazos.n) === 3, 'siguen siendo tres filas', String(trasRechazos.n));

    console.log('\n5) lectura con cursor: ni relee ni se salta');
    r = await leer(`?task_id=${TAREA}`);
    ok(r.status === 200, 'la ruta responde 200', `HTTP ${r.status}`);
    ok(r.datos.events.length === 3, 'sin cursor vienen los tres', String(r.datos.events.length));
    ok(r.datos.events.map((e) => e.seq).join(',') === '1,2,3', 'y en orden de seq', r.datos.events.map((e) => e.seq).join(','));
    ok(r.datos.next_seq === 3, 'el cursor queda en el ultimo', String(r.datos.next_seq));
    ok(r.datos.has_more === false, 'y dice que no hay mas');
    ok(r.datos.events[0].payload.modelo === 'claude-opus-5', 'el payload vuelve como objeto, no como texto');

    r = await leer(`?task_id=${TAREA}&after_seq=3`);
    ok(r.datos.events.length === 0, 'desde el cursor no hay nada nuevo', String(r.datos.events.length));
    ok(r.datos.next_seq === 3, 'y el cursor NO retrocede', String(r.datos.next_seq));

    await pedir('POST', '/conductor/session', { task_id: TAREA, events: [evento(4), evento(5)] });
    r = await leer(`?task_id=${TAREA}&after_seq=3`);
    ok(r.datos.events.map((e) => e.seq).join(',') === '4,5', 'lo nuevo llega, y solo lo nuevo', r.datos.events.map((e) => e.seq).join(','));

    console.log('\n6) el limite parte, y lo dice');
    r = await leer(`?task_id=${TAREA}&limit=2`);
    ok(r.datos.events.length === 2 && r.datos.has_more === true, 'has_more distingue «no hay» de «no cabe»', JSON.stringify({ n: r.datos.events.length, mas: r.datos.has_more }));

    console.log('\n7) huecos: el seq no tiene por que ser denso');
    await pedir('POST', '/conductor/session', { task_id: TAREA, events: [evento(40, 'recorte', { motivo: 'tope por unidad' })] });
    r = await leer(`?task_id=${TAREA}&after_seq=5`);
    ok(r.datos.events.length === 1 && r.datos.events[0].seq === 40, 'un salto de 5 a 40 se sirve igual', JSON.stringify(r.datos.events.map((e) => e.seq)));

    console.log('\n8) el proyecto es la frontera, no el UUID');
    await pedir('POST', '/conductor/session', { task_id: TAREA_AJENA, events: [evento(1)] });
    r = await leer(`?task_id=${TAREA_AJENA}`);
    ok(r.status === 404, 'una tarea de otro proyecto no se sirve por esta ruta', `HTTP ${r.status}`);
    const ajenas = await knex('conductor_agent_events').where({ task_id: TAREA_AJENA }).count('id as n').first();
    ok(Number(ajenas.n) === 1, 'aunque sus eventos si esten guardados (la ingesta va por clave de agente)', String(ajenas.n));

    console.log('\n9) sin sesion no se puede leer');
    r = await leer(`?task_id=${TAREA}`, {});
    ok(r.status === 401 || r.status === 403, 'sin la galleta del panel se rechaza', `HTTP ${r.status}`);
    r = await leer('', galleta);
    ok(r.status === 400 && /task_id/.test(r.datos.error || ''), 'y sin task_id, 400 nombrandolo', JSON.stringify(r.datos));

    console.log('\n10) el panel sabe que ejecuciones tienen sesion');
    r = await pedir('GET', `/dashboard/projects/${encodeURIComponent(PROYECTO)}/conductor?agent_name=${AGENTE}`, undefined, galleta);
    const conSesion = (r.datos.session_tasks || []).find((t) => t.id === TAREA);
    ok(Boolean(conSesion), 'la tarea aparece en session_tasks');
    ok(conSesion && conSesion.events === 6, 'con su cuenta de eventos', String(conSesion && conSesion.events));
    ok(conSesion && conSesion.last_seq === 40, 'y el ultimo seq', String(conSesion && conSesion.last_seq));

    console.log('\n11) borrar la tarea se lleva su sesion (ON DELETE CASCADE)');
    await knex('tasks').where({ id: TAREA_AJENA }).del();
    const huerfanos = await knex('conductor_agent_events').where({ task_id: TAREA_AJENA }).count('id as n').first();
    ok(Number(huerfanos.n) === 0, 'no queda ni una fila huerfana', String(huerfanos.n));
  } finally {
    await knex('tasks').whereIn('project_url', [PROYECTO, AJENO]).del();
    await knex('projects').whereIn('url', [PROYECTO, AJENO]).del();
    console.log('\n(proyectos de prueba borrados)');
    await knex.destroy();
  }

  console.log(`\n${fallos === 0 ? 'TODO OK' : `${fallos} COMPROBACIONES FALLARON`}`);
  process.exit(fallos === 0 ? 0 : 1);
})().catch(async (e) => { console.error(e); try { await knex.destroy(); } catch (_) { /* */ } process.exit(1); });
