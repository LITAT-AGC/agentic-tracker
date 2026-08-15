// Ciclo de vida de una iniciativa del método: leerla, archivarla y purgarla.
//
// Existe porque no había ninguna forma de cerrar una iniciativa que no fuera un SSH a la
// base. `create_initiative` es idempotente por (project_url, status='active'), así que
// mientras esa fila siga activa un cliente que quiere re-planificar desde cero recibe
// SIEMPRE la vieja, resumida en su fase. Le pasó al proyecto "tickets" el 2026-08-15:
// producto redefinido, 21 historias obsoletas, fase 'implementation', y el agente parado
// en preflight sin ninguna herramienta con la que salir de ahí.
//
// Lo delicado no es el borrado, es el ORDEN. Borrar la iniciativa NO limpia el proyecto:
// sólo `epics` y `project_state` cuelgan por CASCADE. `backlog_items` (por `initiative_id`
// y por `epic_id`), `semantic_documents.initiative_id` y `action_items` son SET NULL, de
// modo que las historias SOBREVIVEN vivas y huérfanas —visibles en list_backlog_items,
// invisibles para el motor—, que es un estado peor que el de partida. De ahí que purgar
// sea una secuencia y no un DELETE.
//
// Patrón de servidor puro (scripts/lib/): recibe `db` (knex o trx), sin Express. La ruta
// fina vive en index.js, y publicarlo algún día como operación MCP no pide tocar esto.

// Mismo patrón que method_bootstrap.js: error de entrada del llamante, no fallo del
// servidor. Sin esto un `new Error` pelado sale como 500 con el mensaje interno.
const clientError = (message, code = 'INVALID_ARGUMENT', statusCode = 400) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  error.expose = true;
  return error;
};

const asCount = (value) => Number(value || 0);

// La iniciativa y su proyecto, comprobando que la una es del otro. El `project_url` de la
// ruta no es decorativo: sin él, un id de otro proyecto entraría por la puerta de este.
const loadScopedInitiative = async (db, { initiative_id, project_url }) => {
  if (!initiative_id || typeof initiative_id !== 'string') {
    throw clientError('initiative_id es obligatorio');
  }
  const initiative = await db('initiatives').where({ id: initiative_id }).first();
  if (!initiative) {
    throw clientError(`no existe la iniciativa ${initiative_id}`, 'INITIATIVE_NOT_FOUND', 404);
  }
  if (project_url && initiative.project_url !== project_url) {
    throw clientError(
      `la iniciativa ${initiative_id} es de ${initiative.project_url}, no de ${project_url}`,
      'INITIATIVE_PROJECT_MISMATCH',
    );
  }
  return initiative;
};

// ---- lectura ----
// Todas las iniciativas del proyecto con lo que cuelga de cada una. Las cuentas van
// agrupadas en cuatro consultas para el conjunto, no una por iniciativa: son pocas hoy,
// pero el N+1 se paga solo cuando ya está escrito.
const loadInitiativesOverview = async (db, projectUrl) => {
  if (!projectUrl || typeof projectUrl !== 'string') {
    throw clientError('project_url es obligatorio');
  }

  const initiatives = await db('initiatives')
    .where({ project_url: projectUrl })
    .orderBy('created_at', 'desc')
    .select('id', 'title', 'description', 'track', 'phase', 'status', 'source_ref', 'created_at', 'updated_at');

  if (!initiatives.length) {
    return { project_url: projectUrl, initiatives: [] };
  }

  const ids = initiatives.map((row) => row.id);

  const epics = await db('epics').whereIn('initiative_id', ids)
    .orderBy('sort_order', 'asc')
    .select('id', 'initiative_id', 'title', 'status', 'sort_order');

  // Sin las borradas: son las que el motor ya no ve, y contarlas aquí haría creer que
  // queda trabajo donde no queda.
  const backlog = await db('backlog_items').whereIn('initiative_id', ids)
    .whereNull('deleted_at')
    .select('initiative_id', 'status').count('* as n')
    .groupBy('initiative_id', 'status');

  const artifacts = await db('semantic_documents').whereIn('initiative_id', ids)
    .select('initiative_id', 'doc_type').count('* as n')
    .groupBy('initiative_id', 'doc_type');

  const roster = await db('project_state').whereIn('initiative_id', ids)
    .orderBy('agent_name', 'asc')
    .select('initiative_id', 'agent_name', 'step_status', 'updated_at');

  const porIniciativa = (filas) => filas.reduce((acc, fila) => {
    (acc[fila.initiative_id] = acc[fila.initiative_id] || []).push(fila);
    return acc;
  }, {});

  const epicsBy = porIniciativa(epics);
  const backlogBy = porIniciativa(backlog);
  const artifactsBy = porIniciativa(artifacts);
  const rosterBy = porIniciativa(roster);

  return {
    project_url: projectUrl,
    initiatives: initiatives.map((initiative) => {
      const backlogRows = backlogBy[initiative.id] || [];
      const artifactRows = artifactsBy[initiative.id] || [];
      return {
        ...initiative,
        epics: (epicsBy[initiative.id] || []).map(({ initiative_id, ...epic }) => epic),
        backlog: {
          total: backlogRows.reduce((sum, row) => sum + asCount(row.n), 0),
          by_status: Object.fromEntries(backlogRows.map((row) => [row.status, asCount(row.n)])),
        },
        artifacts: {
          total: artifactRows.reduce((sum, row) => sum + asCount(row.n), 0),
          // doc_type nulo es un documento suelto ligado a la iniciativa; se nombra para
          // que la cuenta cuadre con el total en vez de perderse.
          by_doc_type: Object.fromEntries(artifactRows.map((row) => [row.doc_type || 'sin tipo', asCount(row.n)])),
        },
        roster: (rosterBy[initiative.id] || []).map(({ initiative_id, ...fila }) => fila),
      };
    }),
  };
};

// ---- archivar ----
// El camino blando, y el que resuelve el caso común: basta con que la fila deje de estar
// `active` para que el siguiente `create_initiative` dé de alta una NUEVA en 'analysis'.
// Los artefactos viejos quedan de histórico sin contaminar, porque su `scope_key` es
// `initiative:<id-viejo>:<doc_type>` y la nueva no los alcanza.
//
// `withdraw_backlog` retira además las historias (borrado blando, `deleted_at`). Sin eso
// siguen apareciendo en el backlog del proyecto y se duplican con el plan nuevo, que es
// justo la queja que abrió esto.
const archiveInitiative = (db, {
  initiative_id,
  project_url,
  withdraw_backlog = false,
} = {}) =>
  db.transaction(async (trx) => {
    const initiative = await loadScopedInitiative(trx, { initiative_id, project_url });

    // Idempotente: repetir la llamada no es un error, y el llamante que perdió la
    // respuesta necesita poder repetirla.
    const yaArchivada = initiative.status === 'archived';
    if (!yaArchivada) {
      await trx('initiatives').where({ id: initiative.id })
        .update({ status: 'archived', updated_at: trx.fn.now() });
    }

    let retiradas = 0;
    if (withdraw_backlog) {
      retiradas = await trx('backlog_items')
        .where({ initiative_id: initiative.id })
        .whereNull('deleted_at')
        .update({ deleted_at: trx.fn.now(), updated_at: trx.fn.now() });
    }

    return {
      initiative_id: initiative.id,
      project_url: initiative.project_url,
      title: initiative.title,
      status: 'archived',
      already_archived: yaArchivada,
      withdrawn_backlog_items: retiradas,
    };
  });

// ---- purgar ----
// El camino duro, irreversible. Se lleva TODO lo que cuelga de la iniciativa, en el orden
// que exigen las claves foráneas:
//   1. agent_logs de las tareas de sus historias (agent_logs no tiene project_url: cuelga
//      de task_id, y el FK es SET NULL, así que sobrevivirían mudas)
//   2. esas tareas
//   3. los documentos de esas historias (scope_key 'backlog_item:<id>', sin FK que los ate)
//   4. las historias
//   5. los artefactos de la iniciativa (arrastra semantic_document_embeddings por CASCADE)
//   6. la iniciativa (arrastra epics y project_state por CASCADE)
//
// Lo que NO se toca, a propósito: la fila de `projects` —el proyecto sigue existiendo y su
// url tiene que seguir siendo válida para el re-bootstrap— y las tareas sin historia, que
// no son de esta iniciativa y no hay forma de atribuírselas.
const purgeInitiative = (db, {
  initiative_id,
  project_url,
  confirm,
} = {}) =>
  db.transaction(async (trx) => {
    const initiative = await loadScopedInitiative(trx, { initiative_id, project_url });

    // La compuerta viaja con la mecánica y no con la ruta: quien llame a esto desde otra
    // superficie tiene que pasar por ella igual. Se teclea el nombre del proyecto porque
    // es lo que la persona está mirando, y porque un id copiado no prueba intención.
    const project = await trx('projects').where({ url: initiative.project_url }).first('url', 'name');
    const esperado = (project?.name || '').trim();
    if (!esperado || String(confirm || '').trim() !== esperado) {
      throw clientError(
        `purgar es irreversible: mandá confirm con el nombre exacto del proyecto ('${esperado}')`,
        'PURGE_NOT_CONFIRMED',
      );
    }

    const backlogIds = await trx('backlog_items').where({ initiative_id: initiative.id }).pluck('id');
    const taskIds = backlogIds.length
      ? await trx('tasks').whereIn('backlog_item_id', backlogIds).pluck('id')
      : [];

    // Se cuentan antes de borrar: después de la CASCADE ya no hay a quién preguntarle.
    const [{ n: epicsCount }] = await trx('epics').where({ initiative_id: initiative.id }).count('* as n');
    const [{ n: rosterCount }] = await trx('project_state').where({ initiative_id: initiative.id }).count('* as n');

    const agentLogs = taskIds.length ? await trx('agent_logs').whereIn('task_id', taskIds).del() : 0;
    const tasks = taskIds.length ? await trx('tasks').whereIn('id', taskIds).del() : 0;
    const storyDocs = backlogIds.length
      ? await trx('semantic_documents')
        .where({ project_url: initiative.project_url })
        .whereIn('scope_key', backlogIds.map((id) => `backlog_item:${id}`))
        .del()
      : 0;
    const backlogItems = await trx('backlog_items').where({ initiative_id: initiative.id }).del();
    const artifacts = await trx('semantic_documents').where({ initiative_id: initiative.id }).del();
    await trx('initiatives').where({ id: initiative.id }).del();

    return {
      initiative_id: initiative.id,
      project_url: initiative.project_url,
      title: initiative.title,
      deleted: {
        initiatives: 1,
        epics: asCount(epicsCount),
        project_state: asCount(rosterCount),
        backlog_items: backlogItems,
        story_documents: storyDocs,
        artifacts,
        tasks,
        agent_logs: agentLogs,
      },
    };
  });

module.exports = {
  loadInitiativesOverview,
  archiveInitiative,
  purgeInitiative,
};
