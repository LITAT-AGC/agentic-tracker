#!/usr/bin/env node
// Prueba dirigida de los dos agujeros del panel sobre el backlog, que son el mismo agujero
// visto por sus dos puntas: la vista `compact` no trae lo que el panel daba por supuesto.
//
//   1. LOS TEXTOS. El listado sustituye `description` y `acceptance_criteria` por las
//      banderas `has_*` y un extracto. El panel llenaba su editor con la fila del listado
//      y su guardado manda siempre los dos campos, asi que abrir el editor de un item con
//      descripcion y pulsar Guardar la BORRABA —sin error, con respuesta 200 y sin nada
//      que mirar despues—. La reparacion es poder leer UN item completo:
//      `GET /dashboard/backlog/:id`.
//
//   2. LA EPICA. El motor cuenta y reparte por `epic_id`, y todo lo que nace por el panel
//      o por `create_backlog_item` nace sin epica. Un item creado desde el panel aparecia
//      en la lista y el conductor no lo iba a tomar nunca, sin un solo aviso en la
//      interfaz. La reparacion son dos cosas: verlo (`has_epic` en compact) y poder
//      decidirlo (`POST /dashboard/projects/:url/backlog/adopt`, forward a la operacion
//      del motor que ya existia pero SOLO por credencial de agente).
//
// Uso:  cd backend && APTS_BASE_URL=http://localhost:474xx/api node scripts/test_dashboard_backlog_epic_scope.js
// Necesita el servidor de PRUEBA levantado —lo que se comprueba son rutas HTTP con sesion
// de panel, y la sesion vive en ese proceso— y la base de prueba, para montar y limpiar.
// Crea su propio proyecto y lo borra entero al terminar.
//
// Existe por un caso real (proyecto "tickets", 2026-08-17): se agrego un bug al backlog
// desde el panel, quedo huerfano, y el conductor siguio diciendo 25 items con 26 en la
// base. Es el mismo sintoma que el 2026-08-14 —`total: 0` con 21 items— pero por la via
// del panel, que entonces no existia.

const knex = require('knex')(require('../knexfile').test);

const BASE = (process.env.APTS_BASE_URL || 'http://localhost:47399/api').replace(/\/$/, '');
const CLAVE_PANEL = process.env.DASHBOARD_PASSWORD || 'admin';

const PROYECTO = 'https://example.invalid/prueba-panel-alcance-epica';
const DESCRIPCION = 'Descripcion larga que el listado compacto NO trae y que el editor tiene que poder leer.';
const CRITERIOS = '- Un criterio que tampoco viaja en compact.\n- Y otro, para que sean varias lineas.';

let fallos = 0;
const ok = (cond, etiqueta, detalle) => {
  console.log(`${cond ? '  OK  ' : ' FALLA'} ${etiqueta}${detalle ? ` — ${detalle}` : ''}`);
  if (!cond) fallos += 1;
};

const pedir = async (metodo, ruta, cuerpo, extra = {}) => {
  const r = await fetch(`${BASE}${ruta}`, {
    method: metodo,
    headers: {
      'Content-Type': 'application/json',
      ...(extra.headers || {}),
    },
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  const texto = await r.text();
  let datos = null;
  try { datos = texto ? JSON.parse(texto) : null; } catch (_) { datos = { raw: texto }; }
  return { status: r.status, datos, cookie: r.headers.get('set-cookie') };
};

const limpiar = async () => {
  const epics = await knex('epics').where({ project_url: PROYECTO }).pluck('id');
  if (epics.length) await knex('backlog_items').whereIn('epic_id', epics).del();
  await knex('backlog_items').where({ project_url: PROYECTO }).del();
  await knex('epics').where({ project_url: PROYECTO }).del();
  await knex('initiatives').where({ project_url: PROYECTO }).del();
  await knex('projects').where({ url: PROYECTO }).del();
};

(async () => {
  await limpiar();

  try {
    // ---- montaje: proyecto -> iniciativa activa -> epica -> un item DENTRO y un
    // huerfano con textos largos ----
    await knex('projects').insert({ url: PROYECTO, name: 'prueba panel alcance epica' });
    const [ini] = await knex('initiatives').insert({
      project_url: PROYECTO, title: 'prueba panel alcance epica',
      phase: 'implementation', status: 'active', track: 'method',
    }).returning(['id']);
    const [epica] = await knex('epics').insert({
      initiative_id: ini.id, project_url: PROYECTO, title: 'epica de prueba',
    }).returning(['id']);

    const [dentro] = await knex('backlog_items').insert({
      project_url: PROYECTO, title: 'ya esta en el plan', item_type: 'feature',
      status: 'ready_for_dev', initiative_id: ini.id, epic_id: epica.id,
      priority: 1, sort_order: 7, code_ref: 'abc1234',
    }).returning(['id']);
    const [huerfano] = await knex('backlog_items').insert({
      project_url: PROYECTO, title: 'creado desde el panel', item_type: 'bug',
      status: 'ready', priority: 100, sort_order: 0,
      description: DESCRIPCION, acceptance_criteria: CRITERIOS,
    }).returning(['id']);

    const login = await pedir('POST', '/login', { password: CLAVE_PANEL });
    ok(login.status === 200, 'sesion de panel abierta', `HTTP ${login.status}`);
    const galleta = { headers: { Cookie: (login.cookie || '').split(';')[0] } };

    const listar = async () => {
      const r = await pedir('GET', `/dashboard/projects/${encodeURIComponent(PROYECTO)}/backlog`, undefined, galleta);
      const filas = (r.datos && r.datos.backlog) || [];
      return {
        dentro: filas.find((f) => f.id === dentro.id) || null,
        huerfano: filas.find((f) => f.id === huerfano.id) || null,
      };
    };

    // ---- 2. la epica: verlo ----
    const antes = await listar();
    ok(antes.huerfano !== null && antes.dentro !== null, 'el listado del panel trae los dos items');
    ok(antes.huerfano && antes.huerfano.has_epic === false,
      'el huerfano se ve como fuera del plan (has_epic === false)',
      `has_epic=${JSON.stringify(antes.huerfano && antes.huerfano.has_epic)}`);
    ok(antes.dentro && antes.dentro.has_epic === true,
      'el que esta en la epica se ve dentro (has_epic === true)',
      `has_epic=${JSON.stringify(antes.dentro && antes.dentro.has_epic)}`);

    // ---- 1. los textos: por que la fila del listado NO sirve para el editor ----
    // Esto no es un defecto, es el diseno de `compact`; se fija aqui para que quede
    // escrito que llenar el editor con la fila es leer `undefined`, no leer vacio.
    ok(antes.huerfano && antes.huerfano.description === undefined,
      'la fila compacta NO trae description (de ahi venia el borrado)');
    ok(antes.huerfano && antes.huerfano.has_description === true,
      'pero si dice que la tiene (has_description === true)');

    // Vecino del mismo defecto: `code_ref` se emite en compact a proposito —«que commit
    // cerro esta historia» es una linea— pero no estaba en el select, asi que salia null
    // siempre. Se fija aqui porque es la misma desincronizacion entre select y proyeccion.
    ok(antes.dentro && antes.dentro.code_ref === 'abc1234',
      'compact trae el code_ref de verdad, no null',
      `code_ref=${JSON.stringify(antes.dentro && antes.dentro.code_ref)}`);

    // ---- 1. la reparacion: leer un item completo ----
    const completo = await pedir('GET', `/dashboard/backlog/${huerfano.id}`, undefined, galleta);
    ok(completo.status === 200, 'GET /dashboard/backlog/:id responde 200', `HTTP ${completo.status}`);
    const item = completo.datos && completo.datos.backlog_item;
    ok(item && item.description === DESCRIPCION,
      'devuelve la descripcion entera, sin recortar');
    ok(item && item.acceptance_criteria === CRITERIOS,
      'devuelve los criterios enteros, con sus saltos de linea');

    const ajeno = await pedir('GET', `/dashboard/backlog/${huerfano.id}`, undefined, {});
    ok(ajeno.status === 401 || ajeno.status === 403,
      'sin sesion de panel no se lee un item', `HTTP ${ajeno.status}`);

    // ---- 2. la reparacion: adoptar desde el panel ----
    const adopcion = await pedir(
      'POST',
      `/dashboard/projects/${encodeURIComponent(PROYECTO)}/backlog/adopt`,
      { backlog_item_ids: [huerfano.id] },
      galleta,
    );
    ok(adopcion.status === 200, 'POST .../backlog/adopt responde 200', `HTTP ${adopcion.status}`);
    ok(adopcion.datos && adopcion.datos.adopted_count === 1,
      'adopta exactamente un item', `adopted_count=${adopcion.datos && adopcion.datos.adopted_count}`);

    const fila = await knex('backlog_items').where({ id: huerfano.id })
      .first('epic_id', 'initiative_id', 'sort_order', 'status');
    ok(fila.epic_id === epica.id, 'el item quedo colgado de la epica de la iniciativa activa');
    ok(fila.initiative_id === ini.id, 'y de la iniciativa');
    // El orden no se hereda: va DETRAS de lo que la epica ya tenia (7), y no se queda con
    // el sort_order 0 con el que nacio. Es el fallo que se pago en PROD el 2026-08-08.
    ok(fila.sort_order > 7, 'se le dio orden detras de lo que ya habia',
      `sort_order=${fila.sort_order} (la epica tenia 7)`);

    const despues = await listar();
    ok(despues.huerfano && despues.huerfano.has_epic === true,
      'y el panel ya lo ve dentro del plan');

    // Idempotente: repetirla no lo mueve ni lo duplica.
    const otraVez = await pedir(
      'POST',
      `/dashboard/projects/${encodeURIComponent(PROYECTO)}/backlog/adopt`,
      { backlog_item_ids: [huerfano.id] },
      galleta,
    );
    ok(otraVez.datos && otraVez.datos.adopted_count === 0 && otraVez.datos.skipped.length === 1,
      'adoptar de nuevo no lo mueve: sale en skipped',
      JSON.stringify(otraVez.datos && otraVez.datos.skipped));
  } finally {
    await limpiar();
    await knex.destroy();
  }

  console.log(fallos ? `\n${fallos} comprobacion(es) FALLAN` : '\ntodo en verde');
  process.exit(fallos ? 1 : 0);
})().catch(async (error) => {
  console.error('la prueba revento:', error);
  try { await knex.destroy(); } catch (_) { /* ya estaba cerrada */ }
  process.exit(1);
});
