#!/usr/bin/env node
// Prueba dirigida del bloqueo: el motor NO reparte trabajo por encima de una unidad
// bloqueada, y el presupuesto de saltos atras da para una revision que converge.
//
// Uso:  cd backend && node scripts/test_blocked_unit_halts.js
// Corre contra la base de PRUEBA (knexfile.test) dentro de una transaccion que se
// revierte: no deja residuo y no necesita el servidor levantado.
//
// Existe por una corrida real (proyecto "tickets", 2026-08-15). US-AUTH-01 encadeno
// cuatro pasadas de revision adversaria, cada una con defectos reales de seguridad; al
// cuarto salto atras el motor degrado a HALT por tope de reintentos y el agente reporto
// el bloqueo. A partir de ahi el ciclo se cerro sobre si mismo: `report_blocker` marca la
// unidad y NO toca el puntero de metodo, `blocked` no estaba entre los estados terminales,
// y la rama de idempotencia del reparto devolvia la MISMA unidad bloqueada para siempre.
// Un bucle desatendido la rehacia desde el paso 1 indefinidamente —tres cuartos de hora y
// credito real por vuelta— sin mirar nunca las 24 unidades listas que tenia al lado.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const knex = require('knex')(require('../knexfile').test);
const { aptsNext, aptsSubmitStep, claimDevStory } = require('./lib/method_resolver');

const PROYECTO = 'https://example.invalid/prueba-unidad-bloqueada';
const AGENTE = 'prueba-bloqueo-dev';
const OTRO_AGENTE = 'prueba-bloqueo-dev-2';

const ID_PRIMERA = 'ffffffff-1111-4000-8000-000000000001'; // sort_order 40
const ID_SEGUNDA = 'aaaaaaaa-1111-4000-8000-000000000002'; // sort_order 120

let fallos = 0;
const ok = (cond, etiqueta, detalle) => {
  console.log(`${cond ? '  OK  ' : ' FALLA'} ${etiqueta}${detalle ? ` — ${detalle}` : ''}`);
  if (!cond) fallos += 1;
};

// El motor lee el porque del bloqueo de `agent_logs`, donde lo deja `report_blocker`
// (backend/index.js, reportBlockerInternal). Como esta prueba simula esa escritura en vez
// de llamar al escritor —que vive en index.js y levantaria el servidor—, se comprueba que
// el prefijo sigue siendo el mismo: sin esta guarda, cambiar el formato alli dejaria esta
// prueba en verde y el aviso real sin motivo.
const MARCA = 'BLOCKER REPORTED: ';
const comprobarAcoplamiento = () => {
  const indice = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  ok(indice.includes(`'${MARCA}'`), `report_blocker sigue escribiendo el prefijo ${MARCA.trim()}`,
    'si falla, actualiza MARCA_BLOQUEO en method_resolver.js y aqui');
};

(async () => {
  comprobarAcoplamiento();

  await knex.transaction(async (trx) => {
    // ---- montaje: iniciativa en implementation, epic con dos historias listas ----
    await trx('projects').insert({ url: PROYECTO, name: 'prueba bloqueo' }).onConflict('url').ignore();

    const wf = await trx('workflow_definitions').where({ key: 'bmad-dev-story' })
      .first('id', 'default_entity_id', 'source_ref');
    if (!wf) throw new Error('la base de prueba no tiene sembrado bmad-dev-story');

    const [ini] = await trx('initiatives').insert({
      project_url: PROYECTO, title: 'prueba bloqueo', phase: 'implementation',
      status: 'active', track: 'method', source_ref: wf.source_ref,
    }).returning(['id']);
    const [epic] = await trx('epics').insert({
      initiative_id: ini.id, project_url: PROYECTO, title: 'epic',
    }).returning(['id']);

    // La espina de implementation pide sprint-planning y create-story antes de dev-story;
    // se dan por hechos, que es la condicion de una corrida ya en marcha.
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

    await trx('backlog_items').insert([
      { id: ID_PRIMERA, project_url: PROYECTO, title: 'la primera del plan', item_type: 'feature',
        status: 'ready_for_dev', initiative_id: ini.id, epic_id: epic.id, sort_order: 40 },
      { id: ID_SEGUNDA, project_url: PROYECTO, title: 'la segunda del plan', item_type: 'feature',
        status: 'ready_for_dev', initiative_id: ini.id, epic_id: epic.id, sort_order: 120 },
    ]);

    for (const nombre of [AGENTE, OTRO_AGENTE]) {
      await trx('project_state').insert({
        initiative_id: ini.id, project_url: PROYECTO, agent_name: nombre,
        entity_id: wf.default_entity_id, step_status: 'idle',
      });
    }

    // ---- 1. linea base: con todo listo, el motor reparte ----
    const base = await aptsNext(trx, { project_url: PROYECTO, agent_name: AGENTE });
    ok(base.next === 'run_step' && base.target_id === ID_PRIMERA,
      'con el backlog sano el motor reparte la primera del plan',
      `next=${base.next} target=${String(base.target_id).slice(0, 8)}`);

    // ---- 2. se bloquea la unidad reclamada, como hace report_blocker ----
    // Los tres efectos que importan, y NINGUNO toca el puntero de metodo: esa es
    // exactamente la condicion que cerraba el ciclo.
    const [tarea] = await trx('tasks').insert({
      project_url: PROYECTO, title: 'implementar la primera', agent_name: AGENTE, status: 'stalled',
    }).returning(['id']);
    const MOTIVO = 'tope de reintentos de step:5 agotado en la pasada 4 de revision adversaria';
    await trx('backlog_items').where({ id: ID_PRIMERA })
      .update({ status: 'blocked', active_task_id: tarea.id });
    await trx('agent_logs').insert({
      task_id: tarea.id, agent_name: AGENTE, action_type: 'error', message: MARCA + MOTIVO,
    });

    const puntero = await trx('project_state').where({ project_url: PROYECTO, agent_name: AGENTE })
      .first('cursor', 'step_status');
    ok(puntero.cursor && puntero.cursor.story_id === ID_PRIMERA,
      'el puntero sigue sosteniendo la unidad bloqueada (report_blocker no lo toca)',
      `cursor=${JSON.stringify(puntero.cursor)}`);

    // ---- 3. el veredicto es blocked, y nombra la unidad y el motivo ----
    const parado = await aptsNext(trx, { project_url: PROYECTO, agent_name: AGENTE });
    ok(parado.next === 'blocked', 'una unidad bloqueada da blocked, no run_step', `next=${parado.next}`);
    ok(parado.target_id === ID_PRIMERA, 'y nombra cual es la bloqueada',
      String(parado.target_id).slice(0, 8));
    ok(/la primera del plan/.test(parado.why || ''), 'el porque trae el titulo de la unidad', parado.why || '');
    ok(parado.why.includes(MOTIVO), 'y el motivo que dejo report_blocker');
    ok(/update_backlog_item/.test(parado.why || ''), 'y nombra como reponerla');

    // ---- 4. el ciclo NO se cierra sobre si mismo: repetir no vuelve a repartirla ----
    const repetido = await aptsNext(trx, { project_url: PROYECTO, agent_name: AGENTE });
    ok(repetido.next === 'blocked' && repetido.target_id === ID_PRIMERA,
      'preguntar otra vez sigue dando blocked (antes devolvia run_step sobre la bloqueada)',
      `next=${repetido.next}`);

    // ---- 5. tampoco reparte la SEGUNDA por encima del bloqueo ----
    // Ni al agente que la sostiene ni a otro distinto: la respuesta no puede depender de
    // quien pregunta, o el bloqueo queda enterrado bajo el trabajo de un segundo conductor.
    const otro = await aptsNext(trx, { project_url: PROYECTO, agent_name: OTRO_AGENTE });
    ok(otro.next === 'blocked', 'otro agente tampoco recibe trabajo mientras haya un bloqueo',
      `next=${otro.next} target=${String(otro.target_id).slice(0, 8)}`);
    ok(otro.target_id !== ID_SEGUNDA, 'y desde luego no la segunda del plan');

    // ---- 6. el reparto de bajo nivel mantiene su invariante ----
    // `claimDevStory` esta exportado y se usa suelto: no debe entregar una bloqueada ni
    // por la rama de idempotencia ni entre las candidatas.
    const callerBloqueado = await trx('project_state')
      .where({ project_url: PROYECTO, agent_name: AGENTE }).first();
    const stepIterable = await trx('workflow_steps').where({ workflow_id: wf.id, iterable: true })
      .first('id', 'key');
    const ctx = { initiative_id: ini.id, project_url: PROYECTO, epic_id: epic.id };
    const directo = await claimDevStory(trx, ctx, callerBloqueado, wf, stepIterable);
    ok(directo && directo.blocked && directo.blocked.id === ID_PRIMERA,
      'claimDevStory devuelve la bloqueada como bloqueo, no como trabajo',
      JSON.stringify(directo && Object.keys(directo)));

    // Y con el puntero suelto la bloqueada no entra entre las candidatas: el reparto salta
    // a la siguiente en vez de volver a entregarla. Parar del todo es politica del ciclo
    // (aptsNext, que mira la epica entera antes de repartir); lo que se comprueba aqui es
    // la invariante de esta capa —una bloqueada no se devuelve NUNCA como trabajo—, que es
    // la que protege a quien llame a claimDevStory por su cuenta.
    await trx('project_state').where({ project_url: PROYECTO, agent_name: AGENTE })
      .update({ cursor: null, step_status: 'idle' });
    const callerSuelto = await trx('project_state')
      .where({ project_url: PROYECTO, agent_name: AGENTE }).first();
    const suelto = await claimDevStory(trx, ctx, callerSuelto, wf, stepIterable);
    ok(suelto && suelto.story_id === ID_SEGUNDA,
      'con el puntero suelto salta a la siguiente y no re-reparte la bloqueada',
      JSON.stringify(suelto));

    // ---- 7. reponerla devuelve el trabajo: el bloqueo es recuperable ----
    // Se suelta el puntero que acaba de fijar la llamada directa de arriba, para medir el
    // reparto y no el residuo de la comprobacion anterior.
    await trx('project_state').where({ project_url: PROYECTO, agent_name: AGENTE })
      .update({ cursor: null, step_status: 'idle' });
    await trx('backlog_items').where({ id: ID_PRIMERA }).update({ status: 'ready_for_dev' });
    const repuesto = await aptsNext(trx, { project_url: PROYECTO, agent_name: AGENTE });
    ok(repuesto.next === 'run_step', 'repuesta la unidad, el motor vuelve a repartir',
      `next=${repuesto.next} why=${repuesto.why || ''}`);
    ok(repuesto.target_id === ID_PRIMERA, 'y retoma la primera del plan',
      String(repuesto.target_id).slice(0, 8));

    // ---- 8. presupuesto de saltos atras: 5, no 3 ----
    // El cuarto salto 8->5 es el que la corrida de "tickets" no pudo dar. Se monta el
    // puntero con el gasto ya hecho y se pide el salto siguiente.
    const pasos = await trx('workflow_steps').where({ workflow_id: wf.id })
      .orderBy('step_order', 'asc').select('*');
    const paso8 = pasos.find((p) => String(p.key) === '8');
    const paso5 = pasos.find((p) => String(p.key) === '5');
    ok(Boolean(paso8 && paso5), 'dev-story tiene los pasos 5 y 8 sembrados');
    ok(paso5.step_order <= paso8.step_order, 'y el 5 va antes que el 8, que es lo que hace el salto retrogrado',
      `orden 5=${paso5 && paso5.step_order} 8=${paso8 && paso8.step_order}`);

    const ponerPuntero = (visitas) => trx('project_state')
      .where({ project_url: PROYECTO, agent_name: AGENTE })
      .update({
        current_workflow_id: wf.id, current_step_id: paso8.id, step_status: 'running',
        cursor: JSON.stringify({ story_id: ID_PRIMERA, visits: { 5: visitas } }),
        updated_at: trx.fn.now(),
      });

    // Con 3 gastados, el cuarto salto tiene que pasar (con el tope viejo moria aqui).
    await ponerPuntero(3);
    const cuarto = await aptsSubmitStep(trx, {
      project_url: PROYECTO, agent_name: AGENTE,
      output: { control: { goto: 'step:5' }, control_why: 'pasada 4: un hallazgo confirmado' },
    });
    ok(cuarto.ok !== false, 'el paso 8 acepta la rama step:5 (esta declarada)', cuarto.why || '');
    ok(cuarto.halted !== true, 'el cuarto salto atras ya no degrada a HALT',
      `halted=${cuarto.halted} why=${cuarto.why || ''}`);
    ok(String(cuarto.advanced_to) === '5', 'y el motor vuelve de verdad al paso 5',
      `advanced_to=${cuarto.advanced_to}`);

    // Con 5 gastados, el sexto se corta: el tope sigue existiendo, solo se movio.
    await ponerPuntero(5);
    const sexto = await aptsSubmitStep(trx, {
      project_url: PROYECTO, agent_name: AGENTE,
      output: { control: { goto: 'step:5' }, control_why: 'pasada 6' },
    });
    ok(sexto.halted === true, 'pasado el tope nuevo si degrada a HALT', `halted=${sexto.halted}`);
    ok(/tope de reintentos/.test(sexto.why || ''), 'y lo dice', sexto.why || '');

    throw new Error('__rollback__');
  }).catch((e) => {
    if (e.message !== '__rollback__') throw e;
    console.log('\n(transaccion revertida: la base de prueba queda como estaba)');
  });

  console.log(fallos === 0 ? '\nTODO VERDE' : `\n${fallos} COMPROBACIONES EN ROJO`);
  await knex.destroy();
  process.exit(fallos === 0 ? 0 : 1);
})().catch(async (e) => { console.error(e); await knex.destroy(); process.exit(1); });
