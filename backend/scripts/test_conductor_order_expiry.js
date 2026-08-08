#!/usr/bin/env node
// Prueba dirigida de la caducidad de las ordenes del conductor.
//
// Uso:  cd backend && APTS_BASE_URL=http://localhost:474xx/api node scripts/test_conductor_order_expiry.js
// Necesita el servidor de prueba levantado —la presencia, que es la mitad del criterio,
// vive en la memoria de ESE proceso— y la base de prueba, para envejecer las filas y
// limpiar. Crea su propio proyecto y lo borra entero al terminar.
//
// El plazo de las ordenes NO se acorta: las filas se envejecen a mano contra la base, asi
// que lo que se comprueba es el plazo de verdad (`CONDUCTOR_ORDER_TTL_MS`, diez minutos por
// defecto) sin esperar diez minutos. Lo que si conviene acortar es el de la senal,
// `CONDUCTOR_PRESENCE_TTL_MS=3000`, porque el caso «callado» exige verla caducar y con el
// plazo real cuesta un minuto de espera; sin eso, ese caso se salta y se dice.
//
// Lo que motiva las dos reglas: una orden dirigida a un conductor que no corre se quedaba
// `pending` para siempre, y el dano no era solo la lista sucia —el conductor en espera
// recoge la PRIMERA pendiente de su nombre, asi que uno arrancado mañana ejecutaba el
// `start` de hoy—.

const knex = require('knex')(require('../knexfile').test);

const BASE = (process.env.APTS_BASE_URL || 'http://localhost:47399/api').replace(/\/$/, '');
const API_KEY = process.env.APTS_API_KEY || 'default-dev-key';
const CLAVE_PANEL = process.env.DASHBOARD_PASSWORD || 'admin';

const PROYECTO = 'https://example.invalid/prueba-caducidad-ordenes';
const VIVO = 'prueba-caducidad-vivo';
const APAGADO = 'prueba-caducidad-apagado';
const AJENO = 'prueba-caducidad-ajeno';
const NOMBRES = [VIVO, APAGADO, AJENO];
const EMAIL = 'prueba-caducidad@example.invalid';

let fallos = 0;
const ok = (cond, etiqueta, detalle) => {
  console.log(`${cond ? '  OK  ' : ' FALLA'} ${etiqueta}${detalle ? ` — ${detalle}` : ''}`);
  if (!cond) fallos += 1;
};
const saltado = (etiqueta, motivo) => console.log(`  --  ${etiqueta} — saltado: ${motivo}`);

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

(async () => {
  await knex('projects').insert({ url: PROYECTO, name: 'prueba caducidad ordenes' }).onConflict('url').ignore();

  try {
    const login = await pedir('POST', '/login', { password: CLAVE_PANEL });
    ok(login.status === 200, 'sesion de panel abierta', `HTTP ${login.status}`);
    const galleta = { headers: { Cookie: (login.cookie || '').split(';')[0] } };

    const estado = async (nombre) => {
      const query = nombre ? `?agent_name=${encodeURIComponent(nombre)}` : '';
      const r = await pedir('GET',
        `/dashboard/projects/${encodeURIComponent(PROYECTO)}/conductor${query}`, undefined, galleta);
      return r.datos;
    };

    const encolar = async (comando, nombre) => {
      const r = await pedir('POST', '/dashboard/conductor/orders',
        { command: comando, agent_name: nombre, project_url: PROYECTO }, galleta);
      return r.datos && r.datos.order;
    };

    const fila = async (id) => knex('conductor_orders').where({ id }).first();

    const inicial = await estado(VIVO);
    const PLAZO_S = Number(inicial.order_ttl_seconds);
    const PRESENCIA_S = Number(inicial.presence_ttl_seconds);
    ok(Number.isFinite(PLAZO_S) && PLAZO_S > 0, 'la respuesta dice el plazo de caducidad de las ordenes', `${PLAZO_S}s`);

    // Envejecer una fila mas alla del plazo: es lo que evita esperar el plazo de verdad.
    const envejecer = async (id) => knex('conductor_orders').where({ id })
      .update({ created_at: new Date(Date.now() - (PLAZO_S * 1000 + 60000)) });

    // El criterio de ausencia lleva un cerrojo: la senal vive en la memoria del proceso, asi
    // que sin ninguna senal de un nombre solo se puede afirmar que no hay nadie si el
    // servidor lleva en pie mas que el plazo de la senal. Un servidor recien arrancado no ha
    // tenido tiempo de ver a nadie, y caducar ahi seria matar las ordenes de un conductor
    // vivo cada vez que se reinicia pm2.
    //
    // Ese caso no se puede provocar desde aqui —depende de cuando arranco el servidor—, asi
    // que la prueba se adapta: si toca, lo comprueba; si no, espera a poder probar el resto.
    // Para verlo de verdad, arranca el servidor con CONDUCTOR_PRESENCE_TTL_MS muy alto.
    if (Number(inicial.server_uptime_seconds) <= PRESENCIA_S) {
      const enArranque = await encolar('stop', APAGADO);
      await knex('conductor_orders').where({ id: enArranque.id })
        .update({ created_at: new Date(Date.now() - (PLAZO_S * 1000 + 60000)) });
      const eArranque = await estado(APAGADO);
      const vArranque = (eArranque.orders || []).find((o) => o.id === enArranque.id);
      ok(vArranque && vArranque.status === 'pending',
        `con el servidor en pie ${eArranque.server_uptime_seconds}s y el plazo de senal en ${PRESENCIA_S}s, no se caduca lo que no se puede dar por ausente`,
        vArranque && vArranque.status);

      const falta = PRESENCIA_S - Number(eArranque.server_uptime_seconds) + 1;
      if (falta > 15) {
        saltado('el resto del escenario', `haria falta esperar ${falta}s a que el servidor pueda afirmar una ausencia`);
        throw new Error('__solo_cerrojo__');
      }
      console.log(`(esperando ${falta}s a que el servidor pueda afirmar una ausencia)`);
      await dormir(falta * 1000);
    }

    // ---- 1. el plazo protege el encolar-antes-de-arrancar ----
    const recien = await encolar('stop', APAGADO);
    ok(Boolean(recien), 'se encola una orden a un conductor que no corre');
    const e1 = await estado(APAGADO);
    const v1 = (e1.orders || []).find((o) => o.id === recien.id);
    ok(v1 && v1.status === 'pending', 'una orden recien encolada NO caduca aunque no haya nadie escuchando',
      v1 && v1.status);

    // ---- 2. pasada del plazo y sin nadie al otro lado, el panel la caduca ----
    await envejecer(recien.id);
    const e2 = await estado(APAGADO);
    const v2 = (e2.orders || []).find((o) => o.id === recien.id);
    ok(v2 && v2.status === 'cancelled', 'pasado el plazo y con el destinatario ausente, mirar el buzon la caduca',
      v2 && v2.status);
    ok(v2 && /nadie escuchando/.test(v2.detail || ''), 'y el motivo queda escrito en la propia orden', v2 && v2.detail);
    ok(v2 && v2.acked_at === null, 'sin acuse: caducar no es que le llegara a nadie');
    ok((e2.orders || []).some((o) => o.id === recien.id), 'la orden caducada sigue en la lista, con su motivo');

    // ---- 3. quien esta escuchando manda sobre el reloj ----
    const suya = await encolar('stop', VIVO);
    const sondeo = await pedir('GET', `/conductor/orders/next?agent_name=${encodeURIComponent(VIVO)}`);
    ok(sondeo.status === 200 && sondeo.datos.order && sondeo.datos.order.id === suya.id,
      'el conductor sondea y recibe la orden que le esperaba', `HTTP ${sondeo.status}`);
    await envejecer(suya.id);
    const e3 = await estado(VIVO);
    const v3 = (e3.orders || []).find((o) => o.id === suya.id);
    ok(v3 && v3.status === 'pending', 'el panel NO caduca la de un conductor que consta escuchando, por vieja que sea',
      v3 && v3.status);

    // ---- 4. pero al ENTREGAR, lo rancio no se entrega ----
    const sondeo2 = await pedir('GET', `/conductor/orders/next?agent_name=${encodeURIComponent(VIVO)}`);
    ok(sondeo2.status === 200 && sondeo2.datos.order === null,
      'el sondeo siguiente no entrega la orden rancia', JSON.stringify(sondeo2.datos && sondeo2.datos.order));
    const f4 = await fila(suya.id);
    ok(f4 && f4.status === 'cancelled', 'la deja caducada en vez de dejarla ahi para el proximo arranque', f4 && f4.status);
    ok(f4 && /volvio a preguntar|volvió a preguntar/.test(f4.detail || ''),
      'con el motivo del otro camino, que no es el mismo', f4 && f4.detail);

    // ---- 5. lo que ya no esta pendiente no se toca ----
    const acusada = await encolar('pause', APAGADO);
    await envejecer(acusada.id);
    await knex('conductor_orders').where({ id: acusada.id }).update({ status: 'done', detail: 'sin nada corriendo' });
    await estado(APAGADO);
    const f5 = await fila(acusada.id);
    ok(f5 && f5.status === 'done' && f5.detail === 'sin nada corriendo',
      'una orden vieja que ya se resolvio no se reescribe', f5 && `${f5.status}/${f5.detail}`);

    // ---- 6. el radio: el panel de un proyecto no caduca lo ajeno ----
    const [ajena] = await knex('conductor_orders').insert({
      project_url: null, agent_name: AJENO, command: 'stop',
      created_at: new Date(Date.now() - (PLAZO_S * 1000 + 60000)),
    }).returning('*');
    await estado(VIVO);
    const f6 = await fila(ajena.id);
    ok(f6 && f6.status === 'pending', 'una orden vieja de otro nombre y sin proyecto no la toca este panel', f6 && f6.status);
    const sondeoOtro = await pedir('GET', `/conductor/orders/next?agent_name=${encodeURIComponent(VIVO)}`);
    ok(sondeoOtro.status === 200, 'y sondear con otro nombre tampoco', `HTTP ${sondeoOtro.status}`);
    ok((await fila(ajena.id)).status === 'pending', 'la caducidad al entregar es del buzon de quien pregunta');

    // ---- 7. su propio conductor si la caduca al preguntar ----
    const sondeoAjeno = await pedir('GET',
      `/conductor/orders/next?agent_name=${encodeURIComponent(AJENO)}`, undefined, { agente: AJENO });
    ok(sondeoAjeno.status === 200 && sondeoAjeno.datos.order === null,
      'cuando pregunta su destinatario, no la recibe', JSON.stringify(sondeoAjeno.datos && sondeoAjeno.datos.order));
    ok((await fila(ajena.id)).status === 'cancelled', 'y queda caducada, tambien sin proyecto');

    // ---- 8. callado no es escuchando ----
    if (PRESENCIA_S <= 10) {
      const callada = await encolar('stop', VIVO);
      await envejecer(callada.id);
      await dormir(PRESENCIA_S * 1000 + 1200);
      const e8 = await estado(VIVO);
      const v8 = (e8.orders || []).find((o) => o.id === callada.id);
      ok(v8 && v8.status === 'cancelled',
        `un conductor que hablo y lleva mas de ${PRESENCIA_S}s callado ya no protege su orden`, v8 && v8.status);
    } else {
      saltado('callado no es escuchando', `el plazo de senal son ${PRESENCIA_S}s; arranca el servidor con CONDUCTOR_PRESENCE_TTL_MS=3000`);
    }
  } catch (error) {
    // Salir a medias por no poder afirmar una ausencia todavia no es un fallo: es que este
    // servidor acaba de arrancar y esta corrida solo alcanzaba a comprobar el cerrojo.
    if (!error || error.message !== '__solo_cerrojo__') throw error;
  } finally {
    await knex('conductor_orders').where({ project_url: PROYECTO }).del();
    await knex('conductor_orders').whereIn('agent_name', NOMBRES).del();
    const tareas = await knex('tasks').where({ project_url: PROYECTO }).pluck('id');
    if (tareas.length) await knex('agent_logs').whereIn('task_id', tareas).del();
    await knex('semantic_documents').where({ project_url: PROYECTO }).del();
    await knex('tasks').where({ project_url: PROYECTO }).del();
    await knex('projects').where({ url: PROYECTO }).del();
    console.log('\n(proyecto de prueba borrado)');
  }

  console.log(fallos === 0 ? '\nTODO VERDE' : `\n${fallos} COMPROBACIONES EN ROJO`);
  await knex.destroy();
  process.exit(fallos === 0 ? 0 : 1);
})().catch(async (e) => { console.error(e); await knex.destroy(); process.exit(1); });
