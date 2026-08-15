#!/usr/bin/env node
// Prueba dirigida del ciclo de vida de una iniciativa: la lectura que alimenta el panel,
// el archivado (con y sin retirada del backlog), que archivar DESBLOQUEA de verdad el
// re-bootstrap, y la purga —su compuerta, su orden de borrado y que no deje huérfanos—.
//
// Uso:  cd backend && node scripts/test_method_lifecycle.js
// Corre contra la base de PRUEBA (knexfile.test, PG_TEST_CONNECTION_STRING) y todo ocurre
// dentro de una transaccion que se revierte: no deja residuo. No necesita el servidor
// levantado; llama a las funciones de scripts/lib/method_lifecycle.js directamente.
//
// Existe por un cliente real (proyecto "tickets", 2026-08-15): producto redefinido, 21
// historias obsoletas, fase 'implementation', y ninguna operacion publicada capaz de
// cerrar la iniciativa. El unico camino era un SSH a la base de produccion.

const knex = require('knex')(require('../knexfile').test);
const { loadInitiativesOverview, archiveInitiative, purgeInitiative } = require('./lib/method_lifecycle');
const { createInitiative } = require('./lib/method_bootstrap');

const URL = 'https://example.invalid/prueba-ciclo-iniciativa';
const NOMBRE = 'prueba ciclo iniciativa';

let fallos = 0;
const ok = (cond, etiqueta, detalle) => {
  console.log(`${cond ? '  OK  ' : ' FALLA'} ${etiqueta}${detalle ? ` — ${detalle}` : ''}`);
  if (!cond) fallos += 1;
};

// Monta una iniciativa completa: epica, dos historias, un artefacto, una fila de roster,
// una tarea colgada de una historia y un log colgado de la tarea. Es la forma minima que
// toca las seis tablas que la purga tiene que recorrer en orden.
const montar = async (trx, { titulo, phase = 'implementation', status = 'active' }) => {
  const [ini] = await trx('initiatives').insert({
    project_url: URL, title: titulo, phase, status, track: 'method', source_ref: 'bmad:v6.8.0',
  }).returning(['id']);
  const [epic] = await trx('epics').insert({
    initiative_id: ini.id, project_url: URL, title: `${titulo} — epic`,
  }).returning(['id']);

  const historias = [];
  for (const [i, t] of ['US-01 alta de usuarios', 'US-02 baja de usuarios'].entries()) {
    const [row] = await trx('backlog_items').insert({
      project_url: URL, title: t, item_type: 'feature', status: 'ready_for_dev',
      initiative_id: ini.id, epic_id: epic.id, sort_order: i + 1,
    }).returning(['id']);
    historias.push(row.id);
    // El documento de la historia: sin FK que lo ate, sólo el scope_key lo liga.
    await trx('semantic_documents').insert({
      project_url: URL, strategy_key: 'backlog_item', scope_key: `backlog_item:${row.id}`,
      source_type: 'prueba', title: t, content: t, content_hash: `hash-${row.id}`, version: 1,
    });
  }

  await trx('semantic_documents').insert({
    project_url: URL, strategy_key: 'method_artifact',
    scope_key: `initiative:${ini.id}:prd`, source_type: 'prueba', doc_type: 'prd',
    title: 'PRD', content: '# PRD', content_hash: `hash-prd-${ini.id}`, version: 1,
    initiative_id: ini.id,
  });

  const entity = await trx('entities').first('id');
  await trx('project_state').insert({
    initiative_id: ini.id, project_url: URL, agent_name: `${titulo}-dev`,
    entity_id: entity ? entity.id : null, step_status: 'idle',
  });

  const [task] = await trx('tasks').insert({
    project_url: URL, title: 'Story US-01', agent_name: 'agente-de-prueba',
    status: 'in_progress', backlog_item_id: historias[0],
  }).returning(['id']);
  await trx('agent_logs').insert({
    task_id: task.id, agent_name: 'agente-de-prueba', action_type: 'journal', message: 'nota',
  });

  return { iniciativa: ini.id, epic: epic.id, historias, task: task.id };
};

(async () => {
  await knex.transaction(async (trx) => {
    await trx('projects').insert({ url: URL, name: NOMBRE }).onConflict('url').ignore();

    // ---- 1. lectura: es lo que pinta el panel ----
    const montada = await montar(trx, { titulo: 'plan viejo' });
    const vista = await loadInitiativesOverview(trx, URL);
    ok(vista.initiatives.length === 1, 'la vista trae la iniciativa', `n=${vista.initiatives.length}`);
    const v = vista.initiatives[0];
    ok(v.phase === 'implementation' && v.status === 'active', 'trae fase y estado', `${v.phase}/${v.status}`);
    ok(v.epics.length === 1, 'trae la epica');
    ok(v.backlog.total === 2 && v.backlog.by_status.ready_for_dev === 2, 'cuenta el backlog por estado',
      JSON.stringify(v.backlog));
    ok(v.artifacts.total === 1 && v.artifacts.by_doc_type.prd === 1, 'cuenta los artefactos por tipo',
      JSON.stringify(v.artifacts));
    ok(v.roster.length === 1, 'trae el roster');

    // ---- 2. archivar sin retirar el backlog ----
    const arch = await archiveInitiative(trx, { initiative_id: montada.iniciativa, project_url: URL });
    ok(arch.status === 'archived' && arch.already_archived === false, 'archiva');
    ok(arch.withdrawn_backlog_items === 0, 'no retira historias si no se le pide');
    const vivas = await trx('backlog_items').where({ initiative_id: montada.iniciativa })
      .whereNull('deleted_at').count('* as n').first();
    ok(Number(vivas.n) === 2, 'las historias siguen vivas', `n=${vivas.n}`);

    // Idempotente: repetir no es un error.
    const otraVez = await archiveInitiative(trx, { initiative_id: montada.iniciativa, project_url: URL });
    ok(otraVez.already_archived === true, 'archivar dos veces es idempotente');

    // ---- 3. archivar DESBLOQUEA el re-bootstrap ----
    // Es el punto entero del asunto: con la vieja 'active', create_initiative devolvia
    // siempre la misma resumida en su fase, y el cliente no podia re-planificar.
    const sembrada = await trx('workflow_definitions').where({ source_ref: 'bmad:v6.8.0' }).first('id');
    if (!sembrada) {
      console.log('  SALTA re-bootstrap — la base de prueba no tiene sembrada la libreria bmad:v6.8.0');
    } else {
      const nueva = await createInitiative(trx, { project_url: URL, title: 'plan nuevo' });
      ok(nueva.created === true && nueva.resumed === false, 'create_initiative da de alta una NUEVA',
        `created=${nueva.created} resumed=${nueva.resumed}`);
      ok(nueva.phase === 'analysis', 'la nueva arranca en analysis', `phase=${nueva.phase}`);
      ok(nueva.initiative_id !== montada.iniciativa, 'no es la vieja');
      await purgeInitiative(trx, { initiative_id: nueva.initiative_id, project_url: URL, confirm: NOMBRE });
    }

    // ---- 4. archivar retirando el backlog ----
    const conRetirada = await montar(trx, { titulo: 'plan con retirada' });
    const arch2 = await archiveInitiative(trx, {
      initiative_id: conRetirada.iniciativa, project_url: URL, withdraw_backlog: true,
    });
    ok(arch2.withdrawn_backlog_items === 2, 'retira las historias', `n=${arch2.withdrawn_backlog_items}`);
    const trasRetirada = await trx('backlog_items').where({ initiative_id: conRetirada.iniciativa })
      .whereNull('deleted_at').count('* as n').first();
    ok(Number(trasRetirada.n) === 0, 'ninguna queda viva', `n=${trasRetirada.n}`);

    // ---- 5. la purga exige confirmacion ----
    const aPurgar = await montar(trx, { titulo: 'plan a purgar' });
    let rechazo = null;
    try {
      await purgeInitiative(trx, { initiative_id: aPurgar.iniciativa, project_url: URL });
    } catch (error) { rechazo = error; }
    ok(rechazo?.code === 'PURGE_NOT_CONFIRMED', 'sin confirm, rechaza', rechazo?.message);
    ok((await trx('initiatives').where({ id: aPurgar.iniciativa }).first()) != null,
      'el rechazo no borro nada');

    let malNombre = null;
    try {
      await purgeInitiative(trx, { initiative_id: aPurgar.iniciativa, project_url: URL, confirm: 'otro' });
    } catch (error) { malNombre = error; }
    ok(malNombre?.code === 'PURGE_NOT_CONFIRMED', 'con el nombre equivocado, rechaza');

    // ---- 6. un id de otro proyecto no entra por esta puerta ----
    let ajena = null;
    try {
      await purgeInitiative(trx, {
        initiative_id: aPurgar.iniciativa, project_url: 'https://example.invalid/otro', confirm: NOMBRE,
      });
    } catch (error) { ajena = error; }
    ok(ajena?.code === 'INITIATIVE_PROJECT_MISMATCH', 'una iniciativa de otro proyecto se rechaza');

    // ---- 7. la purga borra todo lo que cuelga, y en orden ----
    const purga = await purgeInitiative(trx, {
      initiative_id: aPurgar.iniciativa, project_url: URL, confirm: NOMBRE,
    });
    ok(purga.deleted.initiatives === 1, 'borra la iniciativa');
    ok(purga.deleted.epics === 1, 'borra la epica (CASCADE)', `n=${purga.deleted.epics}`);
    ok(purga.deleted.project_state === 1, 'borra el roster (CASCADE)', `n=${purga.deleted.project_state}`);
    ok(purga.deleted.backlog_items === 2, 'borra las historias', `n=${purga.deleted.backlog_items}`);
    ok(purga.deleted.story_documents === 2, 'borra los documentos de historia', `n=${purga.deleted.story_documents}`);
    ok(purga.deleted.artifacts === 1, 'borra los artefactos', `n=${purga.deleted.artifacts}`);
    ok(purga.deleted.tasks === 1, 'borra las tareas de sus historias', `n=${purga.deleted.tasks}`);
    ok(purga.deleted.agent_logs === 1, 'borra los logs de esas tareas', `n=${purga.deleted.agent_logs}`);

    // Lo que de verdad se estaba comprobando: que no quede NADA huerfano. Borrar la
    // iniciativa a secas dejaria las historias vivas con initiative_id en NULL, que es
    // peor que no haber borrado.
    const huerfanas = await trx('backlog_items').where({ project_url: URL })
      .whereNull('initiative_id').count('* as n').first();
    ok(Number(huerfanas.n) === 0, 'no quedan historias huerfanas', `n=${huerfanas.n}`);
    const docsSueltos = await trx('semantic_documents').where({ project_url: URL })
      .whereIn('scope_key', aPurgar.historias.map((id) => `backlog_item:${id}`)).count('* as n').first();
    ok(Number(docsSueltos.n) === 0, 'no quedan documentos de historia sueltos', `n=${docsSueltos.n}`);
    const tareaViva = await trx('tasks').where({ id: aPurgar.task }).first();
    ok(tareaViva == null, 'la tarea no sobrevive muda');

    // ---- 8. la fila del proyecto se conserva ----
    // El re-bootstrap la necesita: create_initiative la reinsertaria, pero perder el
    // `name` puesto a mano en el panel seria una sorpresa que nadie pidio.
    const proyecto = await trx('projects').where({ url: URL }).first('url', 'name');
    ok(proyecto?.name === NOMBRE, 'el proyecto sigue ahi con su nombre', proyecto?.name);

    // ---- 9. lo archivado en el paso 4 sigue existiendo ----
    const archivadas = await trx('initiatives').where({ project_url: URL, status: 'archived' }).count('* as n').first();
    ok(Number(archivadas.n) === 2, 'archivar no borra: las dos archivadas siguen', `n=${archivadas.n}`);

    // Se revierte SIEMPRE: la base de prueba queda como estaba.
    throw new Error('ROLLBACK_INTENCIONAL');
  }).catch((error) => {
    if (error.message !== 'ROLLBACK_INTENCIONAL') throw error;
  });

  const residuo = await knex('projects').where({ url: URL }).count('* as n').first();
  console.log(`\nresiduo en la base: ${residuo.n} fila(s) de proyecto (tiene que ser 0)`);
  if (Number(residuo.n) !== 0) fallos += 1;

  console.log(fallos === 0 ? '\nTODO OK' : `\n${fallos} FALLO(S)`);
  await knex.destroy();
  process.exit(fallos === 0 ? 0 : 1);
})().catch(async (error) => {
  console.error('ERROR', error);
  await knex.destroy();
  process.exit(1);
});
