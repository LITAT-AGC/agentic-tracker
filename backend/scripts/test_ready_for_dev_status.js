#!/usr/bin/env node
// Prueba dirigida de `ready_for_dev` en la superficie de la API.
//
// Uso:  cd backend && APTS_BASE_URL=http://localhost:474xx/api node scripts/test_ready_for_dev_status.js
//
// La migracion 010 metio ese estado en la columna y el motor lo escribe en cada story que
// crea, pero `BACKLOG_STATUSES` en la API se quedo con la lista de antes: la base lo
// aceptaba, el motor lo escribia, y la API ni lo leia ni lo escribia. Los dos sintomas que
// costo el 2026-08-08: `list_backlog_items` con ese filtro rebotando con 400 a un agente en
// produccion, y `update_backlog_item` incapaz de reponer una story que la vigilancia habia
// dejado en `blocked` —que es el unico camino de vuelta que el propio motor recomienda—.

const knex = require('knex')(require('../knexfile').test);

const BASE = (process.env.APTS_BASE_URL || 'http://localhost:47412/api').replace(/\/$/, '');
const API_KEY = process.env.APTS_API_KEY || 'default-dev-key';
const PROYECTO = 'https://example.invalid/prueba-ready-for-dev';
const AGENTE = 'prueba-rfd';

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
  'X-APTS-Agent-Email': 'prueba-rfd@example.invalid',
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

(async () => {
  await knex('projects').insert({ url: PROYECTO, name: 'prueba ready_for_dev' })
    .onConflict('url').ignore();
  const [story] = await knex('backlog_items').insert({
    project_url: PROYECTO, title: 'story del motor', item_type: 'feature',
    // Tal cual lo escribe el motor al crear las stories del epic.
    status: 'ready_for_dev',
  }).returning(['id']);

  try {
    const lista = await http('GET', `/projects/backlog?url=${encodeURIComponent(PROYECTO)}&status=ready_for_dev`);
    ok(lista.status === 200, 'list_backlog_items filtra por ready_for_dev', `HTTP ${lista.status}`);
    const items = Array.isArray(lista.datos) ? lista.datos : (lista.datos && lista.datos.backlog) || [];
    ok(items.some((i) => i.id === story.id), 'y devuelve la story que el motor creo asi');

    // La reposicion de una story que la vigilancia dejo en `blocked`: el motor manda a
    // `update_backlog_item` y hasta ahora el valor bueno era el unico que no aceptaba.
    await knex('backlog_items').where({ id: story.id }).update({ status: 'blocked' });
    const repone = await http('PATCH', `/backlog/${story.id}`, { status: 'ready_for_dev' });
    ok(repone.status === 200, 'update_backlog_item repone una story bloqueada', `HTTP ${repone.status}`);
    const tras = await knex('backlog_items').where({ id: story.id }).first('status');
    ok(tras.status === 'ready_for_dev', 'y queda en el estado canonico del metodo, no en un primo suyo', tras.status);

    const invalido = await http('GET', `/projects/backlog?url=${encodeURIComponent(PROYECTO)}&status=ready_for_deb`);
    ok(invalido.status === 400, 'un estado inventado sigue dando 400', `HTTP ${invalido.status}`);
  } finally {
    await knex('semantic_documents').where({ project_url: PROYECTO }).del();
    await knex('backlog_items').where({ project_url: PROYECTO }).del();
    await knex('projects').where({ url: PROYECTO }).del();
    console.log('\n(proyecto de prueba borrado)');
  }

  console.log(fallos === 0 ? '\nTODO VERDE' : `\n${fallos} COMPROBACIONES EN ROJO`);
  await knex.destroy();
  process.exit(fallos === 0 ? 0 : 1);
})().catch(async (e) => { console.error(e); await knex.destroy(); process.exit(1); });
