#!/usr/bin/env node
// Prueba dirigida del ORDEN en que el motor reparte las stories de un epic.
//
// Uso:  cd backend && node scripts/test_dev_story_claim_order.js
// Corre contra la base de PRUEBA dentro de una transaccion que se revierte: no deja
// residuo y no necesita el servidor levantado.
//
// `claimDevStory` ordenaba por `created_at, id`. Las stories de un epic las crea el motor
// en un solo lote, asi que el `created_at` empata en todas y el desempate lo decidia el
// UUID: reparto al azar. En produccion el 2026-08-08 eso saco primera la ultima story del
// plan —la que depende de otras cinco— y planto el bucle de fm-synth con el freno de
// estancamiento. El orden lo mandan `priority` y `sort_order`, que es donde el backlog
// declara su plan y por donde ya ordenaba `list_backlog_items`.
//
// La prueba se monta a proposito con los UUID en contra: la primera del plan es la que el
// criterio viejo habria dejado para el final.
//
// Y fija ademas la regla que gobierna todo esto: LAS STORIES NO SE SALTEAN. El reparto no
// puede adelantar una unidad sin terminar, pase lo que pase con ella. Las tres formas en
// que podria colarse una excepcion, cada una con su caso:
//
//   · a medias (`in_progress`, `review`) -> se vuelve a repartir LA MISMA, no la siguiente;
//   · bloqueada                          -> para la epica entera, y la siguiente NO se sirve;
//   · `archived`                         -> unica salida, y es un acto humano deliberado.
//
// Se fija por COMPORTAMIENTO y no leyendo la constante `TERMINAL_STATUSES`: lo que hay que
// impedir es que alguien amplie esa lista sin darse cuenta de lo que significa, y una
// asercion sobre el array se actualizaria junto al cambio sin que nadie lo notara.

const crypto = require('node:crypto');
const knex = require('knex')(require('../knexfile').test);
const { aptsNext } = require('./lib/method_resolver');

const PROYECTO = 'https://example.invalid/prueba-orden-de-reparto';
const AGENTE = 'prueba-orden-dev';

let fallos = 0;
const ok = (cond, etiqueta, detalle) => {
  console.log(`${cond ? '  OK  ' : ' FALLA'} ${etiqueta}${detalle ? ` — ${detalle}` : ''}`);
  if (!cond) fallos += 1;
};

// UUID fijos y ordenados al reves que el plan: el que va primero por `sort_order` es el
// ultimo por identificador, que es la trampa exacta que se vio en produccion.
const ID_PRIMERA = 'ffffffff-0000-4000-8000-000000000001'; // sort_order 40
const ID_SEGUNDA = 'aaaaaaaa-0000-4000-8000-000000000002'; // sort_order 120
const ID_TERCERA = '11111111-0000-4000-8000-000000000003'; // sort_order 240

(async () => {
  await knex.transaction(async (trx) => {
    await trx('projects').insert({ url: PROYECTO, name: 'prueba orden' }).onConflict('url').ignore();

    const wf = await trx('workflow_definitions').where({ key: 'bmad-dev-story' })
      .first('id', 'default_entity_id', 'source_ref');
    if (!wf) throw new Error('la base de prueba no tiene sembrado bmad-dev-story');

    const [ini] = await trx('initiatives').insert({
      project_url: PROYECTO, title: 'prueba orden', phase: 'implementation',
      status: 'active', track: 'method', source_ref: wf.source_ref,
    }).returning(['id']);
    const [epic] = await trx('epics').insert({
      initiative_id: ini.id, project_url: PROYECTO, title: 'epic',
    }).returning(['id']);

    // La espina de implementation pide `bmad-sprint-planning` antes de dev-story y cierra
    // por artifact-exists; se da por hecho, que es la condicion de una corrida ya en
    // marcha.
    for (const docType of ['sprint_plan', 'story_spec']) {
      const contenido = `dado por hecho (${docType})`;
      await trx('semantic_documents').insert({
        project_url: PROYECTO, strategy_key: 'method_artifact',
        scope_key: `initiative:${ini.id}:${docType}`, source_type: 'method_step',
        title: docType, content: contenido,
        content_hash: crypto.createHash('sha256').update(contenido).digest('hex'),
        doc_type: docType, version: 1, initiative_id: ini.id,
      });
    }

    // Mismo `created_at` en las tres, como las escribe el motor de una tacada.
    const nacidas = trx.fn.now();
    await trx('backlog_items').insert([
      { id: ID_TERCERA, project_url: PROYECTO, title: 'la ultima del plan', item_type: 'feature',
        status: 'ready_for_dev', initiative_id: ini.id, epic_id: epic.id, sort_order: 240, created_at: nacidas },
      { id: ID_PRIMERA, project_url: PROYECTO, title: 'la primera del plan', item_type: 'feature',
        status: 'ready_for_dev', initiative_id: ini.id, epic_id: epic.id, sort_order: 40, created_at: nacidas },
      { id: ID_SEGUNDA, project_url: PROYECTO, title: 'la segunda del plan', item_type: 'feature',
        status: 'ready_for_dev', initiative_id: ini.id, epic_id: epic.id, sort_order: 120, created_at: nacidas },
    ]);

    await trx('project_state').insert({
      initiative_id: ini.id, project_url: PROYECTO, agent_name: AGENTE,
      entity_id: wf.default_entity_id, step_status: 'idle',
    });

    // ---- 1. el reparto sigue el plan, no el identificador ----
    const primera = await aptsNext(trx, { project_url: PROYECTO, agent_name: AGENTE });
    ok(primera.target_id === ID_PRIMERA,
      'reparte primero la de sort_order mas bajo',
      `${String(primera.target_id).slice(0, 8)} (${primera.next})`);
    ok(primera.target_id !== ID_TERCERA,
      'y no la que ganaba por UUID, que es la ultima del plan');

    // ---- 2. y sigue el plan al avanzar: cerrada la primera, cae la segunda ----
    await trx('backlog_items').where({ id: ID_PRIMERA }).update({ status: 'done' });
    await trx('project_state').where({ project_url: PROYECTO, agent_name: AGENTE })
      .update({ cursor: null, step_status: 'idle' });
    const segunda = await aptsNext(trx, { project_url: PROYECTO, agent_name: AGENTE });
    ok(segunda.target_id === ID_SEGUNDA,
      'cerrada la primera, reparte la segunda del plan',
      String(segunda.target_id).slice(0, 8));

    // ---- 3. `priority` manda sobre `sort_order`, que es el orden que declara la lista ----
    await trx('backlog_items').where({ id: ID_TERCERA }).update({ priority: 10 });
    await trx('project_state').where({ project_url: PROYECTO, agent_name: AGENTE })
      .update({ cursor: null, step_status: 'idle' });
    const urgente = await aptsNext(trx, { project_url: PROYECTO, agent_name: AGENTE });
    ok(urgente.target_id === ID_TERCERA,
      'una prioridad mas alta se salta el sort_order',
      String(urgente.target_id).slice(0, 8));

    // ---- 4. una unidad A MEDIAS no se saltea: se vuelve a repartir la misma ----
    //
    // Es el caso que mas facil seria perder de vista, porque no falla ruidosamente: la
    // story se queda sin cerrar, el motor pasa a la siguiente y el backlog avanza dejando
    // un agujero detras. Aqui se exige lo contrario. `review` ademas del `in_progress`
    // porque es donde queda una unidad cuyo agente entrego y el motor no confirmo.
    // Se le devuelve la prioridad CON LA QUE NACIO, leyendola de una hermana intacta. Un
    // literal aqui es una trampa: `priority` ordena ASCENDENTE, asi que poner 0 no la
    // devuelve a la fila, la asciende a la primera de todas.
    const { priority: prioridadDeFabrica } = await trx('backlog_items')
      .where({ id: ID_SEGUNDA }).first('priority');
    await trx('backlog_items').where({ id: ID_TERCERA }).update({ priority: prioridadDeFabrica });
    for (const aMedias of ['in_progress', 'review']) {
      await trx('backlog_items').where({ id: ID_PRIMERA }).update({ status: aMedias });
      await trx('project_state').where({ project_url: PROYECTO, agent_name: AGENTE })
        .update({ cursor: null, step_status: 'idle' });
      const otra = await aptsNext(trx, { project_url: PROYECTO, agent_name: AGENTE });
      ok(otra.target_id === ID_PRIMERA,
        `una unidad en '${aMedias}' se vuelve a repartir, no se saltea`,
        `${String(otra.target_id).slice(0, 8)} (${otra.next})`);
      ok(otra.target_id !== ID_SEGUNDA,
        `  y la siguiente del plan NO se adelanta por encima de ella`);
    }

    // ---- 5. una unidad BLOQUEADA para el reparto entero ----
    //
    // No es «no hay trabajo»: es que lo que hay delante pide una persona. La siguiente del
    // plan no se sirve aunque este lista, que es justo lo que hace que el aviso llegue
    // ahora y no enterrado bajo horas de trabajo posterior.
    await trx('backlog_items').where({ id: ID_PRIMERA }).update({ status: 'blocked' });
    await trx('project_state').where({ project_url: PROYECTO, agent_name: AGENTE })
      .update({ cursor: null, step_status: 'idle' });
    const parada = await aptsNext(trx, { project_url: PROYECTO, agent_name: AGENTE });
    ok(parada.next === 'blocked', 'una unidad bloqueada para el ciclo', parada.next);
    ok(parada.target_id !== ID_SEGUNDA && parada.target_id !== ID_TERCERA,
      '  y no reparte ninguna de las que tiene listas al lado',
      String(parada.target_id).slice(0, 8));
    ok(/US|bloquead|blocked|la primera del plan/i.test(parada.why || ''),
      '  y dice cual es', parada.why);

    // ---- 6. `archived` es la UNICA salida que deja pasar al reparto ----
    //
    // Deliberada y humana: archivar es decir «esta no va». Si alguien anade un estado mas
    // a TERMINAL_STATUSES, este caso sigue en verde y el 4 se pone en rojo, que es donde
    // hay que enterarse.
    await trx('backlog_items').where({ id: ID_PRIMERA }).update({ status: 'archived' });
    await trx('project_state').where({ project_url: PROYECTO, agent_name: AGENTE })
      .update({ cursor: null, step_status: 'idle' });
    const tras = await aptsNext(trx, { project_url: PROYECTO, agent_name: AGENTE });
    ok(tras.target_id === ID_SEGUNDA,
      'archivada la primera, el plan sigue por la segunda',
      String(tras.target_id).slice(0, 8));

    throw new Error('__rollback__');
  }).catch((e) => {
    if (e.message !== '__rollback__') throw e;
    console.log('\n(transaccion revertida: la base de prueba queda como estaba)');
  });

  console.log(fallos === 0 ? '\nTODO VERDE' : `\n${fallos} COMPROBACIONES EN ROJO`);
  await knex.destroy();
  process.exit(fallos === 0 ? 0 : 1);
})().catch(async (e) => { console.error(e); await knex.destroy(); process.exit(1); });
