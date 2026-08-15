// F5-1 — Operaciones de bootstrap del motor de método, conducibles desde el cliente.
//
// El motor BMAD (F0–F4) quedó funcionando en el servidor, pero es INALCANZABLE
// desde un proyecto cliente: lo único que crea initiatives/epics/project_state son
// los seeds (f1/f4), que escriben directo a la DB. Un cliente que invoca el
// manifiesto recibe las 5 tools del método, pero `apts_next` devuelve 'blocked'
// para siempre (sin iniciativa activa). Estas operaciones abren la puerta.
//
// `create_initiative` (esta tarea, F5-1-T1): crea —idempotente por
// (project_url, status='active')— la iniciativa en fase 'analysis' scopeada a la
// librería BMAD sembrada (source_ref 'bmad:v6.8.0'), con 1 epic vacío plegado
// (loadEpic/claimDevStory lo necesitan en implementation y no hay tool de epics;
// simplificación conocida del ledger #5) y, opcionalmente, la spec del cliente
// como semantic_documents tipado ligado a la iniciativa (ledger #3: el server no
// ve el FS del cliente).
//
// Ledger F5-0 firmado (2026-06-21): #1 bootstrap separado (create_initiative +
// set_agent_role, esta última en F5-1-T2); #3 spec como artefacto en bootstrap;
// #4 source_ref='bmad:v6.8.0' / track='method' por defecto; #5 epic plegado.
//
// Patrón de servidor puro (scripts/lib/): recibe `db` (knex/trx, perfil test en
// validación), sin Express (eso es la ruta fina en index.js).

const crypto = require('crypto');
// El motor es de allí: la espina de fase, el mapa de completitud, el roster y la
// puerta de entrada de un item a la máquina de método. Este módulo los consulta, no
// los reimplementa.
const {
  loadRosterKeys, startPhaseGaps, loadActiveInitiative, loadEpic, methodEntryStatus,
} = require('./method_resolver');

const DEFAULT_TRACK = 'method';
const DEFAULT_SOURCE_REF = 'bmad:v6.8.0';
const DEFAULT_PHASE = 'analysis';
// doc_type del artefacto spec (agregado al enum en la migración 016). Decisión #3:
// recuperable por doc_type vía resolveNeed; distinto de 'brief' (que PRODUCE el
// step product-brief) para no marcar 'analysis' como completa de entrada.
const SPEC_DOC_TYPE = 'spec';

// Asegura la fila `projects` (FK NOT NULL de initiatives/epics). Idempotente:
// no pisa el `name` de un proyecto ya existente.
const ensureProject = async (db, projectUrl, name) => {
  await db('projects')
    .insert({ url: projectUrl, name: name || projectUrl })
    .onConflict('url')
    .ignore();
};

// Escribe la spec del cliente como semantic_documents tipado (doc_type='spec'),
// ligado a la iniciativa. Misma forma que upsertArtifact del resolver: 1 fila por
// (project_url, strategy_key, scope_key), version = contador. Idempotente por scope.
const writeSpecArtifact = async (db, { initiativeId, projectUrl, title, content }) => {
  const strategy_key = 'method_artifact';
  const scope_key = `initiative:${initiativeId}:${SPEC_DOC_TYPE}`;
  const body = content || '';
  const content_hash = crypto.createHash('sha256').update(body).digest('hex');
  const existing = await db('semantic_documents')
    .where({ project_url: projectUrl, strategy_key, scope_key })
    .first('id', 'version');
  if (existing) {
    await db('semantic_documents').where({ id: existing.id }).update({
      content: body, content_hash, title: title || null, doc_type: SPEC_DOC_TYPE,
      version: existing.version + 1, initiative_id: initiativeId, updated_at: db.fn.now(),
    });
    return { id: existing.id, version: existing.version + 1, created: false };
  }
  const [row] = await db('semantic_documents').insert({
    project_url: projectUrl, strategy_key, scope_key, source_type: 'method_bootstrap',
    title: title || null, content: body, content_hash, doc_type: SPEC_DOC_TYPE,
    version: 1, initiative_id: initiativeId,
  }).returning(['id']);
  return { id: row.id, version: 1, created: true };
};

// ---- create_initiative ----
// Idempotente por (project_url, status='active'): si ya hay una iniciativa activa,
// la RESUME (no duplica). Si se pasa spec_artifact, se (re)escribe el artefacto en
// ambos caminos (alta y resume), idempotente por scope.
// Corre todo en una transacción (project + initiative + epic + spec consistentes).
// Si `db` ya es una trx, knex anida vía savepoint.
const createInitiative = (db, {
  project_url,
  title,
  track = DEFAULT_TRACK,
  source_ref = DEFAULT_SOURCE_REF,
  phase = DEFAULT_PHASE,
  description,
  spec_artifact,
} = {}) =>
  db.transaction(async (trx) => {
    if (!project_url || typeof project_url !== 'string') {
      throw new Error('create_initiative requires project_url');
    }
    if (!title || typeof title !== 'string') {
      throw new Error('create_initiative requires title');
    }

    const hasSpec = spec_artifact
      && typeof spec_artifact === 'object'
      && spec_artifact.content !== undefined
      && spec_artifact.content !== null;

    // ---- Idempotencia: iniciativa activa existente → resume ----
    const existing = await trx('initiatives')
      .where({ project_url, status: 'active' })
      .orderBy('created_at', 'asc')
      .first();
    if (existing) {
      const epic = await trx('epics')
        .where({ initiative_id: existing.id })
        .orderBy('sort_order', 'asc')
        .first('id');
      let spec = null;
      if (hasSpec) {
        spec = await writeSpecArtifact(trx, {
          initiativeId: existing.id,
          projectUrl: project_url,
          title: spec_artifact.title,
          content: spec_artifact.content,
        });
      }
      return {
        initiative_id: existing.id,
        epic_id: epic ? epic.id : null,
        phase: existing.phase,
        created: false,
        resumed: true,
        ...(spec ? { spec_artifact_id: spec.id } : {}),
        // El roster también en el camino de resume: es la vía de recuperación de un
        // agente que retoma con el contexto limpio y no tiene las claves a mano.
        roster: {
          source_ref: existing.source_ref,
          entity_keys: await loadRosterKeys(trx, existing.source_ref),
        },
      };
    }

    // ---- Guardia: la fase de partida no puede saltarse trabajo sin hacer ----
    // Sólo en el alta. El camino de resume ya retornó arriba: allí `phase` es inerte
    // (manda la de la iniciativa viva) y rechazarlo rompería la vía de recuperación
    // del agente que repite su llamada original tras perder el contexto.
    const gaps = await startPhaseGaps(trx, { project_url, track, source_ref, phase });
    if (gaps.length) {
      throw badRequest(
        `phase '${phase}' se salta ${gaps.length} artefacto(s) que el motor exige antes: `
        + `${gaps.map((g) => `${g.doc_type} (fase '${g.phase}', workflow '${g.workflow_key}')`).join(', ')}. `
        + `Arrancá en '${DEFAULT_PHASE}' y dejá que el motor los produzca; `
        + 'spec_artifact es entrada de esos pasos, no sustituto de sus artefactos',
        'PHASE_NOT_REACHABLE',
      );
    }

    // ---- Alta: project (FK) → initiative ('analysis') → epic vacío plegado ----
    await ensureProject(trx, project_url, title);

    const [initRow] = await trx('initiatives').insert({
      project_url,
      title,
      description: description || null,
      track,
      phase,
      status: 'active',
      source_ref,
    }).returning('id');
    const initiativeId = initRow.id;

    const [epicRow] = await trx('epics').insert({
      initiative_id: initiativeId,
      project_url,
      title: `${title} — epic`,
      status: 'planned',
      priority: 100,
      sort_order: 0,
    }).returning('id');
    const epicId = epicRow.id;

    let spec = null;
    if (hasSpec) {
      spec = await writeSpecArtifact(trx, {
        initiativeId,
        projectUrl: project_url,
        title: spec_artifact.title,
        content: spec_artifact.content,
      });
    }

    return {
      initiative_id: initiativeId,
      epic_id: epicId,
      phase,
      created: true,
      resumed: false,
      ...(spec ? { spec_artifact_id: spec.id } : {}),
      // Las claves de rol de la librería recién fijada. `set_agent_role` es la
      // operación siguiente en el arranque y las necesita: publicarlas aquí evita
      // el rechazo obligatorio que hoy es la única forma de aprenderlas.
      roster: {
        source_ref,
        entity_keys: await loadRosterKeys(trx, source_ref),
      },
    };
  });

// ---- set_agent_role (F5-1-T2) ----
// Registra/actualiza el puntero de un rol en `project_state` para la iniciativa
// activa del proyecto. Upsert idempotente sobre unique(initiative_id, agent_name):
// segunda llamada con el mismo agent_name no duplica, re-asigna.
//
// Decisión #2 (roster Opción A): 1 agent_name por rol; el orquestador conmuta de
// identidad usando el `role` que devuelve apts_next. El role-matching del resolver
// compara `project_state.entity_id` vs la entidad REQUERIDA por el step, así que
// `entity_id` se PERSISTE NO-NULL: el PoC F5-0 probó que entity_id=null = `wait`
// eterno (reproduce el bug f4 stale). Se resuelve entity_key→entity_id contra la
// librería de la iniciativa (entities scopeadas por su source_ref) y se valida que
// exista ahí; una key de otra librería se rechaza aunque `entities.key` sea único
// global. Corre en transacción (initiative + entity + upsert consistentes).
// F6-4 — Error de entrada del llamante, no fallo del servidor. Sin esto, `new Error`
// pelado sale como 500 con el mensaje interno (getErrorStatusCode, index.js:522), que
// es el mismo defecto que F6-2-T2 cerró en create_initiative. Patrón de servidor puro:
// se marca el error con statusCode/code y la ruta ya lo traduce.
const badRequest = (message, code = 'INVALID_ARGUMENT') => {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = code;
  error.expose = true;
  return error;
};

const setAgentRole = (db, {
  project_url,
  agent_name,
  entity_key,
} = {}) =>
  db.transaction(async (trx) => {
    if (!project_url || typeof project_url !== 'string') {
      throw badRequest('set_agent_role requires project_url');
    }
    if (!agent_name || typeof agent_name !== 'string') {
      throw badRequest('set_agent_role requires agent_name');
    }
    if (!entity_key || typeof entity_key !== 'string') {
      throw badRequest('set_agent_role requires entity_key');
    }

    // La iniciativa activa fija la librería (source_ref) contra la que resolver el rol.
    const initiative = await trx('initiatives')
      .where({ project_url, status: 'active' })
      .orderBy('created_at', 'asc')
      .first('id', 'source_ref');
    if (!initiative) {
      throw badRequest(
        `set_agent_role requires an active initiative for ${project_url}; run create_initiative first`,
      );
    }

    // entity_key → entity_id, scopeado a la librería de la iniciativa.
    const entity = await trx('entities')
      .where({ key: entity_key, source_ref: initiative.source_ref })
      .first('id', 'key');
    if (!entity) {
      // El rechazo sigue enumerando las claves, por la misma fuente que ahora las
      // publica `create_initiative` y `apts_next`: aquí es la última red, no la única.
      const disponibles = (await loadRosterKeys(trx, initiative.source_ref)).join(', ');
      throw badRequest(
        `entity_key '${entity_key}' no existe en la librería source_ref '${initiative.source_ref}'. `
        + `Claves válidas: ${disponibles}`,
        'UNKNOWN_ENTITY_KEY',
      );
    }

    // Upsert sobre unique(initiative_id, agent_name). entity_id NO-NULL siempre.
    const existing = await trx('project_state')
      .where({ initiative_id: initiative.id, agent_name })
      .first('id');
    if (existing) {
      await trx('project_state').where({ id: existing.id }).update({
        entity_id: entity.id,
        project_url,
        updated_at: trx.fn.now(),
      });
      return { project_state_id: existing.id, role: entity.key, created: false, updated: true };
    }

    const [row] = await trx('project_state').insert({
      initiative_id: initiative.id,
      project_url,
      agent_name,
      entity_id: entity.id,
      step_status: 'idle',
    }).returning('id');
    return { project_state_id: row.id, role: entity.key, created: true, updated: false };
  });

// ---- adopt_backlog_items ----
// Repara la fractura entre las dos vías de alta del backlog. `create_backlog_item`
// no acepta jerarquía —su esquema no tiene epic_id ni initiative_id— y el motor sólo
// liga historias al crearlas él en el submit de `bmad-create-epics-and-stories`. Un
// proyecto puede acabar entonces con un backlog visible en `list_backlog_items` y
// vacío para el motor: `apts_status` devolviendo `backlog: {total: 0}` con veinte
// items dentro. Sin esta operación, salir de ahí exigía un UPDATE a mano en la base:
// ninguna de las herramientas publicadas podía tocar la jerarquía.
//
// Adopta en la épica de la iniciativa activa los items del proyecto que no están en
// ninguna. Idempotente: un item ya ligado se informa en `skipped` y no se toca.
//
// El orden NO se hereda. Los huérfanos suelen traer el `sort_order` por defecto y la
// misma `priority`, y `claimDevStory` ordena por esas dos columnas: adoptarlos tal cual
// dejaría el reparto en manos del desempate por UUID, que es el fallo que ya se pagó en
// producción el 2026-08-08. Se les asigna `sort_order` correlativo detrás de lo que la
// épica ya tenga: en el orden de `backlog_item_ids` cuando se pasan —así el llamante
// dicta el plan— y si no, en el orden estable (priority, sort_order, created_at, id).
const ADOPTABLE_ITEM_TYPES_DEFAULT_EXCLUDED = ['bug'];

const adoptBacklogItems = (db, {
  project_url,
  backlog_item_ids,
  include_bugs = false,
} = {}) =>
  db.transaction(async (trx) => {
    if (!project_url || typeof project_url !== 'string') {
      throw badRequest('adopt_backlog_items requires project_url');
    }
    const ids = backlog_item_ids === undefined || backlog_item_ids === null
      ? null
      : backlog_item_ids;
    if (ids !== null && (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !id.trim()))) {
      throw badRequest('backlog_item_ids must be an array of backlog item ids');
    }

    const initiative = await loadActiveInitiative(trx, project_url);
    if (!initiative) {
      throw badRequest(
        `adopt_backlog_items requires an active initiative for ${project_url}; run create_initiative first`,
      );
    }
    const epic = await loadEpic(trx, initiative.id);
    if (!epic) {
      throw badRequest(
        `la iniciativa activa de ${project_url} no tiene épica; no hay dónde adoptar`,
        'NO_EPIC',
      );
    }

    // Candidatos. Con ids explícitos se respeta lo que pide el llamante (incluidos
    // los bugs); el barrido sin ids deja los bugs fuera salvo que se pidan, porque
    // arrastrar el triaje entero a un plan BMAD no es lo que nadie quiere por defecto.
    const base = trx('backlog_items')
      .where({ project_url })
      .whereNull('deleted_at')
      .orderBy('priority', 'asc')
      .orderBy('sort_order', 'asc')
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .forUpdate();
    if (ids) base.whereIn('id', ids.map((id) => id.trim()));
    else {
      base.whereNull('epic_id');
      if (!include_bugs) base.whereNotIn('item_type', ADOPTABLE_ITEM_TYPES_DEFAULT_EXCLUDED);
    }
    const candidates = await base.select('id', 'title', 'status', 'epic_id', 'item_type');

    const skipped = [];
    const byId = new Map(candidates.map((row) => [row.id, row]));
    if (ids) {
      for (const raw of ids) {
        const id = raw.trim();
        if (!byId.has(id)) skipped.push({ backlog_item_id: id, reason: 'no existe en este proyecto (o está borrado)' });
      }
    }

    const adoptables = candidates.filter((row) => {
      if (row.epic_id) {
        skipped.push({ backlog_item_id: row.id, reason: `ya está en la épica ${row.epic_id}` });
        return false;
      }
      return true;
    });

    // Con ids explícitos manda el orden de la lista: es la única forma que tiene el
    // llamante de expresar el plan cuando los huérfanos no traen orden propio —y no lo
    // traen casi nunca, porque `create_backlog_item` los deja a todos con la misma
    // prioridad y el mismo sort_order—. Sin esto, el desempate acababa en el id.
    if (ids) {
      const posicion = new Map(ids.map((id, i) => [id.trim(), i]));
      adoptables.sort((a, b) => posicion.get(a.id) - posicion.get(b.id));
    }

    const [{ max_order: maxOrder }] = await trx('backlog_items')
      .where({ epic_id: epic.id })
      .whereNull('deleted_at')
      .max('sort_order as max_order');
    let order = Number(maxOrder || 0) + 1;

    const adopted = [];
    for (const row of adoptables) {
      const status = methodEntryStatus(row.status);
      await trx('backlog_items').where({ id: row.id }).update({
        initiative_id: initiative.id,
        epic_id: epic.id,
        status,
        sort_order: order,
        updated_at: trx.fn.now(),
      });
      adopted.push({
        backlog_item_id: row.id,
        title: row.title,
        status_from: row.status,
        status_to: status,
        sort_order: order,
      });
      order += 1;
    }

    return {
      initiative_id: initiative.id,
      epic_id: epic.id,
      adopted_count: adopted.length,
      adopted,
      skipped,
    };
  });

module.exports = {
  createInitiative,
  setAgentRole,
  adoptBacklogItems,
  writeSpecArtifact,
  ensureProject,
  SPEC_DOC_TYPE,
  DEFAULT_TRACK,
  DEFAULT_SOURCE_REF,
  DEFAULT_PHASE,
};
