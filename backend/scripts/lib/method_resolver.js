// F1-T3 — Resolver `apts_next` declarativo full-lifecycle, role-aware,
// multi-agente sin colisión de historia. Lógica de servidor pura (patrón
// scripts/lib/): recibe `db` (knex/trx, perfil `test`), sin Express (eso es T4).
//
// Construye ENCIMA de resolvePhaseStep (cascada intra-fase de T2). T2 resuelve
// el verdicto de UNA fase; T3 le pone encima:
//   · selección de la fase activa desde initiatives.phase + su workflow_definition,
//   · avance inter-fase cuando una fase cierra (initiatives.phase → siguiente; "done" al final),
//   · role-matching: qué entidad requiere el step (workflow_steps.entity_id ||
//     workflow_definitions.default_entity_id) vs la del puntero del caller,
//   · reparto de unidades iterables (dev-story) entre agentes sin colisión
//     (claim transaccional con FOR UPDATE; unique(initiative_id, agent_name) = puntero único).
//
// Decisiones aprobadas (ledger 2026-06-20):
//   (A) input = { project_url, agent_name }: role solo no distingue agent-dev-1/2.
//   (B) "una query" = un round-trip del agente, no un único SQL: internamente,
//       lecturas indexadas + los COUNT de la cascada, todo en una transacción.
//   (C) apts_next hace 2 escrituras deterministas idempotentes: avanzar phase en
//       phase_done y reclamar la story en dev-story.
//
// Payload (firma PLAN §7): { next, target_id, role, why, args? }
//   next     : 'run_step' | 'wait' | 'done' | 'blocked'
//   target_id: dev-story => story_id; generative no-iterable => initiative_id;
//              wait/done/blocked => null
//   role     : entidad REQUERIDA por el step (no la del caller)
//   why      : razón legible (verdict.why de T2 + observed)
//   args     : identificadores mínimos para el goteo F3 { phase, workflow_key, step_key }

const { resolvePhaseStep } = require('./method_primitives');

const LIFECYCLE = ['analysis', 'planning', 'solutioning', 'implementation', 'done'];
const TERMINAL_STATUSES = ['done', 'archived'];

// Máquina de estados de método para STORIES (backlog_items). Lineal hacia adelante;
// es la transición del método, distinta de la edición libre de update_backlog_item.
// Story-only en F1 (ampliable a epic/initiative en F2, aditivo). Decisión aprobada T4.
const STORY_METHOD_STATUSES = ['ready_for_dev', 'in_progress', 'review', 'done'];
const STORY_METHOD_TRANSITIONS = {
  ready_for_dev: ['in_progress'],
  in_progress: ['review'],
  review: ['done'],
  done: [],
};

// Error de máquina de estados con código/HTTP para que la ruta mapee 404/409.
class MethodStatusError extends Error {
  constructor(message, { code, statusCode }) {
    super(message);
    this.name = 'MethodStatusError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const nextPhase = (phase) => {
  const i = LIFECYCLE.indexOf(phase);
  return i >= 0 && i < LIFECYCLE.length - 1 ? LIFECYCLE[i + 1] : 'done';
};

const loadActiveInitiative = (db, projectUrl) =>
  db('initiatives')
    .where({ project_url: projectUrl, status: 'active' })
    .orderBy('created_at', 'asc')
    .first();

const loadCallerPointer = (db, initiativeId, agentName) =>
  db('project_state').where({ initiative_id: initiativeId, agent_name: agentName }).first();

const loadEpic = (db, initiativeId) =>
  db('epics').where({ initiative_id: initiativeId }).orderBy('sort_order', 'asc').first();

// Workflow de la fase activa: prefiere el que matchea el track; si no, el primero activo.
const selectPhaseWorkflow = async (db, phase, track) => {
  const rows = await db('workflow_definitions').where({ phase, status: 'active' });
  if (rows.length === 0) return null;
  return rows.find((w) => Array.isArray(w.tracks) && w.tracks.includes(track)) || rows[0];
};

const loadSteps = (db, workflowId) =>
  db('workflow_steps').where({ workflow_id: workflowId }).orderBy('step_order', 'asc');

const entityKey = async (db, entityId) => {
  if (!entityId) return null;
  const row = await db('entities').where({ id: entityId }).first('key');
  return row ? row.key : null;
};

// ---- Reparto multi-agente sin colisión (dev-story iterable) ----
// Devuelve { story_id } reclamado para el caller, o null si no quedan libres.
// Idempotente: si el caller ya sostiene una story no-terminal, la devuelve sin rebarajar.
const claimDevStory = async (db, ctx, caller, workflow, step) => {
  const cur = caller.cursor || null;
  if (cur && cur.story_id) {
    const held = await db('backlog_items').where({ id: cur.story_id }).first();
    if (held && !TERMINAL_STATUSES.includes(held.status)) return { story_id: held.id };
  }

  // Candidatas: stories no-terminales del epic, en orden determinista, bloqueadas para el claim.
  const candidates = await db('backlog_items')
    .where({ epic_id: ctx.epic_id })
    .whereNotIn('status', TERMINAL_STATUSES)
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .forUpdate();

  // Sostenidas por OTRO agente (otro puntero running con cursor.story_id).
  const others = await db('project_state')
    .where({ initiative_id: ctx.initiative_id, step_status: 'running' })
    .whereNot({ agent_name: caller.agent_name });
  const heldByOthers = new Set(
    others.map((o) => o.cursor && o.cursor.story_id).filter(Boolean),
  );

  const free = candidates.find((r) => !heldByOthers.has(r.id));
  if (!free) {
    // Liberar el puntero del caller si venía running sobre una story ya terminal.
    if (cur && cur.story_id) {
      await db('project_state')
        .where({ id: caller.id })
        .update({ step_status: 'idle', cursor: null, updated_at: db.fn.now() });
    }
    return null;
  }

  await db('project_state').where({ id: caller.id }).update({
    current_workflow_id: workflow.id,
    current_step_id: step.id,
    cursor: JSON.stringify({ story_id: free.id }),
    step_status: 'running',
    updated_at: db.fn.now(),
  });
  return { story_id: free.id };
};

// ---- Resolver principal ----
// Corre todo en una transacción (claim + avance de fase consistentes). Si `db`
// ya es una trx, knex anida vía savepoint.
const aptsNext = (db, { project_url, agent_name }) =>
  db.transaction(async (trx) => {
    const initiative = await loadActiveInitiative(trx, project_url);
    if (!initiative) {
      return { next: 'blocked', target_id: null, role: null, why: `sin iniciativa activa en ${project_url}` };
    }
    const caller = await loadCallerPointer(trx, initiative.id, agent_name);
    if (!caller) {
      return { next: 'blocked', target_id: null, role: null, why: `agente '${agent_name}' sin puntero en la iniciativa` };
    }
    const epic = await loadEpic(trx, initiative.id);
    const ctx = {
      initiative_id: initiative.id,
      project_url,
      epic_id: epic ? epic.id : null,
    };

    let phase = initiative.phase;
    const visitedPhases = new Set();

    // Walk inter-fase: atraviesa fases ya satisfechas hasta hallar trabajo o 'done'.
    while (true) {
      if (phase === 'done') {
        return { next: 'done', target_id: null, role: null, why: 'lifecycle completo' };
      }
      if (visitedPhases.has(phase)) {
        return { next: 'blocked', target_id: null, role: null, why: `ciclo inter-fase en '${phase}'` };
      }
      visitedPhases.add(phase);

      const workflow = await selectPhaseWorkflow(trx, phase, initiative.track);
      if (!workflow) {
        return { next: 'blocked', target_id: null, role: null, why: `sin workflow activo para la fase '${phase}'` };
      }
      const steps = await loadSteps(trx, workflow.id);
      const verdict = await resolvePhaseStep(trx, ctx, workflow, steps);

      if (verdict.kind === 'phase_done') {
        const adv = nextPhase(phase);
        await trx('initiatives').where({ id: initiative.id }).update({ phase: adv, updated_at: trx.fn.now() });
        phase = adv;
        continue;
      }

      if (verdict.kind === 'blocked') {
        return {
          next: 'blocked',
          target_id: null,
          role: await entityKey(trx, (verdict.step && verdict.step.entity_id) || workflow.default_entity_id),
          why: verdict.why,
        };
      }

      // actionable: role-matching + reparto multi-agente
      const step = verdict.step;
      const requiredEntityId = step.entity_id || workflow.default_entity_id;
      const role = await entityKey(trx, requiredEntityId);
      const args = { phase, workflow_key: workflow.key, step_key: step.key };

      if (!caller.entity_id || caller.entity_id !== requiredEntityId) {
        return {
          next: 'wait',
          target_id: null,
          role,
          why: `el rol '${role}' debe ejecutar '${step.key}': ${step.goal}`,
          args,
        };
      }

      if (step.iterable) {
        const claim = await claimDevStory(trx, ctx, caller, workflow, step);
        if (!claim) {
          return { next: 'wait', target_id: null, role, why: 'sin unidades de trabajo libres para este agente', args };
        }
        return { next: 'run_step', target_id: claim.story_id, role, why: verdict.why, args };
      }

      return { next: 'run_step', target_id: initiative.id, role, why: verdict.why, args };
    }
  });

// ---- apts_status (data-mode): conteos + recomendación, SOLO LECTURA ----
// La recomendación se computa con el MISMO aptsNext (sin duplicar routing), pero
// dentro de una transacción que se ROLLBACKEA: aptsNext puede escribir (avance de
// fase, claim de story) y este endpoint no debe mutar estado. Los conteos reflejan
// la fase/estado PERSISTIDOS (se leen antes de invocar aptsNext).
const methodStatus = async (db, { project_url, agent_name }) => {
  const trx = await db.transaction();
  try {
    const initiative = await loadActiveInitiative(trx, project_url);
    let body;

    if (!initiative) {
      body = {
        project_url,
        initiative: null,
        phase: null,
        epic: null,
        backlog: { total: 0, by_status: {}, done: 0, remaining: 0 },
        recommendation: {
          next: 'blocked',
          target_id: null,
          role: null,
          why: `sin iniciativa activa en ${project_url}`,
        },
      };
    } else {
      const epic = await loadEpic(trx, initiative.id);
      const by_status = {};
      if (epic) {
        const rows = await trx('backlog_items')
          .where({ epic_id: epic.id })
          .groupBy('status')
          .select('status')
          .count('* as c');
        for (const r of rows) by_status[r.status] = Number(r.c);
      }
      const total = Object.values(by_status).reduce((a, b) => a + b, 0);
      const done = (by_status.done || 0) + (by_status.archived || 0);

      const recommendation = agent_name
        ? await aptsNext(trx, { project_url, agent_name })
        : { next: 'wait', target_id: null, role: null, why: 'sin agent_name: recomendación no resuelta' };

      body = {
        project_url,
        initiative: { id: initiative.id, track: initiative.track, status: initiative.status },
        phase: initiative.phase,
        epic: epic ? { id: epic.id } : null,
        backlog: { total, by_status, done, remaining: total - done },
        recommendation,
      };
    }

    await trx.rollback();
    return body;
  } catch (error) {
    try { await trx.rollback(); } catch (_) { /* trx ya cerrada */ }
    throw error;
  }
};

// ---- apts_set_status: transición de método validada para una story ----
// Distinta de update_backlog_item (edición libre): valida contra
// STORY_METHOD_TRANSITIONS y persiste. 404 si la story no existe, 409 si la
// transición es inválida. Idempotencia no requerida (máquina lineal hacia adelante).
const setMethodStatus = (db, { backlog_item_id, status }) =>
  db.transaction(async (trx) => {
    const item = await trx('backlog_items').where({ id: backlog_item_id }).forUpdate().first();
    if (!item) {
      throw new MethodStatusError(`backlog item '${backlog_item_id}' no existe`, {
        code: 'NOT_FOUND',
        statusCode: 404,
      });
    }
    const from = item.status;
    const allowed = STORY_METHOD_TRANSITIONS[from] || [];
    if (!allowed.includes(status)) {
      throw new MethodStatusError(
        `transición de método inválida: '${from}' → '${status}' (permitidas desde '${from}': ${allowed.length ? allowed.join(', ') : 'ninguna'})`,
        { code: 'INVALID_TRANSITION', statusCode: 409 },
      );
    }
    await trx('backlog_items')
      .where({ id: backlog_item_id })
      .update({ status, updated_at: trx.fn.now() });
    return { backlog_item_id, from, to: status };
  });

module.exports = {
  aptsNext,
  methodStatus,
  setMethodStatus,
  STORY_METHOD_STATUSES,
  STORY_METHOD_TRANSITIONS,
  MethodStatusError,
  LIFECYCLE,
  nextPhase,
  claimDevStory,
  selectPhaseWorkflow,
};
