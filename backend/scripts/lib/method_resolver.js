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

const { resolvePhaseStep, evaluatePrimitive } = require('./method_primitives');
const { buildWorkflowCompletion } = require('./method_outputs');
const { applyRewire } = require('../importer/rewire');
// Fuente única del roster. `method_bootstrap` no importa este módulo, así que no
// hay ciclo.
const { loadRosterKeys } = require('./method_bootstrap');

const LIFECYCLE = ['analysis', 'planning', 'solutioning', 'implementation', 'done'];
const TERMINAL_STATUSES = ['done', 'archived'];

// ---- F3-T1.5 — Navegación DAG multi-skill-por-fase ----
// El corpus real tiene varios workflows por fase (DAG inter-workflow). El routing
// ya es dato (workflow_definitions.metadata.routing, de module-help.csv). Modelo de
// completitud aprobado (Opción A): cada required de una fase cierra cuando su
// artefacto/estado declarado (routing.outputs) se cumple; la fase cierra cuando
// TODOS sus required cierran, recorridos en orden topológico (preceded_by).
//
// Mapa de completitud a nivel-workflow. F3-T2: DERIVADO de la fuente única
// (method_outputs.WORKFLOW_OUTPUTS) en vez de un literal, para que la completitud
// de T1.5 y los outputs[] per-step de T2 no puedan divergir (acordado con el
// operador). El resultado es idéntico al literal previo (verificado): brief/prd/
// architecture/epics por artifact-exists; readiness/sprint-planning/create-story
// por count-threshold (provisional F4); dev-story por all-children-status.
const WORKFLOW_COMPLETION = buildWorkflowCompletion();

// Fases sin ningún required en el CSV (analysis): workflow deliverable de facto.
const PHASE_FALLBACK_WORKFLOW = { analysis: 'bmad-product-brief' };

// Orden topológico determinista de los required por preceded_by (filtrando refs
// a sub-pasos `key:substep` y a otras fases). Ciclo/insatisfacible → resto en
// orden de key (determinista, no cuelga).
const topoSortRequired = (required) => {
  const keys = new Set(required.map((r) => r.key));
  const baseKey = (ref) => String(ref).split(':')[0];
  const prereqsOf = (r) => {
    const pb = (r.metadata && r.metadata.routing && r.metadata.routing.preceded_by) || [];
    return (Array.isArray(pb) ? pb : [pb]).map(baseKey).filter((k) => keys.has(k) && k !== r.key);
  };
  const remaining = [...required].sort((a, b) => (a.key < b.key ? -1 : 1));
  const placed = [];
  const placedSet = new Set();
  while (remaining.length) {
    const idx = remaining.findIndex((r) => prereqsOf(r).every((k) => placedSet.has(k)));
    if (idx === -1) {
      placed.push(...remaining);
      break;
    }
    const [r] = remaining.splice(idx, 1);
    placed.push(r);
    placedSet.add(r.key);
  }
  return placed;
};

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

// Espina de la fase activa, scopeada a la librería de la iniciativa (source_ref):
// devuelve la lista ORDENADA de workflows que gatean la fase.
//   · librería sin routing (toy): 1 workflow (track-match o primero) → completitud
//     por gates de resolvePhaseStep (comportamiento F1).
//   · con routing (bmad): required topológicamente ordenados → completitud por
//     WORKFLOW_COMPLETION. Fase sin required (analysis) → workflow fallback.
const resolvePhaseSpine = async (db, phase, track, sourceRef) => {
  let q = db('workflow_definitions').where({ phase, status: 'active' });
  if (sourceRef) q = q.where({ source_ref: sourceRef });
  const rows = await q;
  if (rows.length === 0) return [];

  const withRouting = rows.filter((r) => r.metadata && r.metadata.routing);
  if (withRouting.length === 0) {
    const wf = rows.find((w) => Array.isArray(w.tracks) && w.tracks.includes(track)) || rows[0];
    return [wf];
  }

  const required = withRouting.filter((r) => r.metadata.routing.required);
  if (required.length === 0) {
    const fbKey = PHASE_FALLBACK_WORKFLOW[phase];
    const wf = fbKey ? rows.find((r) => r.key === fbKey) : null;
    return wf ? [wf] : [];
  }
  return topoSortRequired(required);
};

const loadSteps = (db, workflowId) =>
  db('workflow_steps').where({ workflow_id: workflowId }).orderBy('step_order', 'asc');

// Verdicto de UN workflow. Despacha por modelo de completitud:
//   · sin routing (toy): cascada de gates (resolvePhaseStep) → phase_done|actionable|blocked.
//   · con routing (bmad): si su predicado de completitud (WORKFLOW_COMPLETION) pasa →
//     'phase_done' (workflow cerrado); si no, resolvePhaseStep da el step de entrada accionable.
const resolveWorkflowVerdict = async (db, ctx, workflow, steps) => {
  const routing = workflow.metadata && workflow.metadata.routing;
  if (!routing) {
    return resolvePhaseStep(db, ctx, workflow, steps);
  }
  const spec = WORKFLOW_COMPLETION[workflow.key];
  if (spec) {
    const v = await evaluatePrimitive(db, spec.primitive, ctx, spec.params);
    if (v.pass) {
      return { kind: 'phase_done', why: `workflow '${workflow.key}' completo: ${v.detail}`, observed: v.observed };
    }
  }
  // No completo (o sin spec): el step de entrada accionable. Para workflows reales
  // (sin gates/outputs por step cableados) resolvePhaseStep devuelve el 1er generative.
  return resolvePhaseStep(db, ctx, workflow, steps);
};

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
      // Único bloqueo cuya salida es registrar un rol, y el roster no era descubrible
      // sin fallar antes en `set_agent_role`. Se adjunta SOLO aquí: en el ciclo normal
      // esta rama no se toma, así que el coste recurrente en tokens es cero.
      // Alcanza también a `apts_status`, que compone su recomendación con este mismo
      // resolver.
      return {
        next: 'blocked',
        target_id: null,
        role: null,
        why: `agente '${agent_name}' sin puntero en la iniciativa; registralo con set_agent_role`,
        roster: {
          source_ref: initiative.source_ref,
          entity_keys: await loadRosterKeys(trx, initiative.source_ref),
        },
      };
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

      const spine = await resolvePhaseSpine(trx, phase, initiative.track, initiative.source_ref);
      if (spine.length === 0) {
        return { next: 'blocked', target_id: null, role: null, why: `sin workflow activo para la fase '${phase}'` };
      }

      // Recorre la espina: el primer workflow NO-completo es el activo. Si todos
      // cierran, la fase está completa.
      let workflow = null;
      let verdict = null;
      for (const wf of spine) {
        const steps = await loadSteps(trx, wf.id);
        const v = await resolveWorkflowVerdict(trx, ctx, wf, steps);
        if (v.kind === 'phase_done') continue; // workflow cerrado → siguiente en la espina
        workflow = wf;
        verdict = v;
        break;
      }

      if (!workflow) {
        // Todos los workflows de la espina cerraron → avanzar de fase.
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

// ---- F3-T2 — apts_workflow_step: goteo modelo B (contexto fresco por paso) ----
// El server reconstruye el payload del paso ACTUAL desde el estado (puntero en
// project_state) y reinyecta SOLO lo que el paso needs[]. Costo-B: el payload por
// paso es ~constante (instrucción del paso + slices acotados de needs + template),
// no crece con el proyecto. Lado de LECTURA: sirve el paso actual. El AVANCE del
// cursor lo hace apts_submit_step (T4); la elicitación (await_input) la hace T3.
//
// Input { project_url, agent_name } (server-autoritativo, lee/inicializa el cursor):
//   · si el caller ya está corriendo un paso (puntero running) → lo sirve;
//   · si está idle → bootstrap vía aptsNext (rol-aware + claim), fija el cursor al
//     paso de entrada del workflow recomendado y lo sirve.
// Si aptsNext no da run_step (wait/done/blocked), se devuelve ese modo.

const SLICE_CHARS = 1200; // tope por need: slice acotado (costo-B, sin embeddings)

const truncateSlice = (text) => {
  if (!text) return null;
  if (text.length <= SLICE_CHARS) return text;
  return `${text.slice(0, SLICE_CHARS)}…[+${text.length - SLICE_CHARS} chars]`;
};

// Resuelve un need a { referencia + slice acotado } desde el estado servidor.
// Determinista (sin API de embeddings): el slice es un excerpt de tamaño fijo del
// artefacto upstream. La recuperación semántica embedding-ranked es refinamiento
// opcional (requiere OPENROUTER_API_KEY); el contrato del payload no cambia.
const resolveNeed = async (db, ctx, need) => {
  if (need.kind === 'artifact') {
    const row = await db('semantic_documents')
      .where({ initiative_id: ctx.initiative_id, doc_type: need.doc_type })
      .orderBy('version', 'desc')
      .first('id', 'doc_type', 'version', 'title', 'content');
    if (!row) {
      return { kind: 'artifact', doc_type: need.doc_type, present: false, ref: null, slice: null };
    }
    return {
      kind: 'artifact',
      doc_type: row.doc_type,
      present: true,
      ref: { id: row.id, version: row.version, title: row.title || null },
      slice: truncateSlice(row.content),
    };
  }
  // Otros kinds (config/entity) se sirven inline por rewire; no son needs recuperables aquí.
  return { kind: need.kind, present: false, ref: null, slice: null };
};

// Puntos de elicitación del paso = los <ask> estructurados que BMAD marca
// (preservados en step.metadata.asks por el importador). Señal determinista de
// "este paso requiere input del usuario" (F3-T3). Los workflows en prosa elicitan
// dentro del instruction_chunk verbatim; no traen asks estructurados.
const stepAsks = (step) =>
  (step.metadata && Array.isArray(step.metadata.asks) ? step.metadata.asks : []);

// Serializa el cursor preservando story_id (claim) y answers (elicitación).
const serializeCursor = (cursor) => {
  const c = {};
  if (cursor && cursor.story_id) c.story_id = cursor.story_id;
  if (cursor && cursor.answers && Object.keys(cursor.answers).length) c.answers = cursor.answers;
  return Object.keys(c).length ? JSON.stringify(c) : null;
};

// Construye el payload servido de un paso (ADN re-cableado en serve-time + needs).
// mode: 'run' | 'await_input' (F3-T3). En await_input expone `questions`; cuando ya
// hubo input, lo devuelve en `provided_input` para que el paso se reconstruya completo.
const buildStepPayload = async (db, ctx, {
  initiative, workflow, step, role, storyId, mode = 'run', questions = null, providedInput = null,
}) => {
  const needs = [];
  for (const need of step.needs || []) {
    needs.push(await resolveNeed(db, ctx, need));
  }
  const payload = {
    mode,
    workflow_key: workflow.key,
    step_key: step.key,
    step_order: step.step_order,
    goal: step.goal || null,
    role,
    target_id: storyId || initiative.id,
    // ADN generativo verbatim re-cableado en serve-time (NO se muta el almacenado):
    instruction_chunk: applyRewire(step.instruction_chunk),
    template_slice: applyRewire(step.template_slice),
    needs,
    outputs: step.outputs || [],
  };
  if (mode === 'await_input') payload.questions = questions || [];
  if (providedInput != null) payload.provided_input = providedInput;
  return payload;
};

// `answers` (opcional): cuando el paso estaba pausado en espera-input (T3), el
// agente reanuda pasándolo aquí — se registra en cursor.answers[step.key] y el paso
// pasa a 'run' con `provided_input`. Servir y reanudar son el mismo punto de
// interacción (modelo B), por eso una sola tool en vez de una `resume` aparte.
const aptsWorkflowStep = (db, { project_url, agent_name, answers }) =>
  db.transaction(async (trx) => {
    const initiative = await loadActiveInitiative(trx, project_url);
    if (!initiative) {
      return { mode: 'blocked', why: `sin iniciativa activa en ${project_url}` };
    }
    let caller = await loadCallerPointer(trx, initiative.id, agent_name);
    if (!caller) {
      return { mode: 'blocked', why: `agente '${agent_name}' sin puntero en la iniciativa` };
    }
    const epic = await loadEpic(trx, initiative.id);
    const ctx = { initiative_id: initiative.id, project_url, epic_id: epic ? epic.id : null };

    // ¿El caller ya está a mitad de un workflow? (puntero con paso fijado, corriendo
    // o pausado en espera-input → se re-sirve el mismo paso, no se re-bootstrapea).
    let workflow = null;
    let step = null;
    if (caller.current_workflow_id && caller.current_step_id
        && ['running', 'await_input'].includes(caller.step_status)) {
      workflow = await trx('workflow_definitions').where({ id: caller.current_workflow_id }).first();
      step = await trx('workflow_steps').where({ id: caller.current_step_id }).first();
    }

    // Idle / sin paso fijado → bootstrap vía el resolver (rol-aware + claim de unidad).
    if (!workflow || !step) {
      const rec = await aptsNext(trx, { project_url, agent_name });
      if (rec.next !== 'run_step') {
        return { mode: rec.next, why: rec.why, role: rec.role || null, args: rec.args || null };
      }
      workflow = await trx('workflow_definitions')
        .where({ key: rec.args.workflow_key })
        .modify((q) => { if (initiative.source_ref) q.where({ source_ref: initiative.source_ref }); })
        .first();
      step = await trx('workflow_steps').where({ workflow_id: workflow.id, key: rec.args.step_key }).first();
      // aptsNext ya persistió el cursor para iterables (claimDevStory); re-leemos para
      // recoger story_id antes de fijar el cursor del paso de entrada.
      caller = await loadCallerPointer(trx, initiative.id, agent_name);
    }

    // Cursor vigente (story_id del claim + answers de elicitaciones previas).
    const cursor = caller.cursor || {};
    // Resume de elicitación: si llega input y el paso estaba pausado, se registra
    // (la elicitación es PAUSA, ≠ blocker; ver F3-T3).
    if (answers !== undefined && answers !== null && caller.step_status === 'await_input') {
      cursor.answers = { ...(cursor.answers || {}), [step.key]: answers };
    }
    const storyId = cursor.story_id || null;

    // ¿El paso es un punto de elicitación aún sin responder? → pausa await_input.
    const asks = stepAsks(step);
    const answered = Boolean(cursor.answers && cursor.answers[step.key] !== undefined);
    const elicit = asks.length > 0 && !answered;
    const stepStatus = elicit ? 'await_input' : 'running';

    // Persistencia única del puntero (idempotente; preserva story_id + answers).
    await trx('project_state').where({ id: caller.id }).update({
      current_workflow_id: workflow.id,
      current_step_id: step.id,
      step_status: stepStatus,
      cursor: serializeCursor(cursor),
      updated_at: trx.fn.now(),
    });

    const role = await entityKey(trx, step.entity_id || workflow.default_entity_id);
    return buildStepPayload(trx, ctx, {
      initiative, workflow, step, role, storyId,
      mode: elicit ? 'await_input' : 'run',
      questions: elicit ? asks : null,
      providedInput: answered ? cursor.answers[step.key] : null,
    });
  });

// ---- F3-T4 — apts_submit_step: captura de output del paso + avance del cursor ----
// Doc-artefactos → APTS (semantic_documents tipados, doc_type del enum); código →
// referencia (code_ref); unidades iterables → status de la story reclamada. Luego
// avanza el cursor al próximo paso (o cierra el workflow y libera el puntero).
//
// El descriptor de output del paso (step.outputs, cableado en T2) decide QUÉ se
// captura; el `output` del caller trae el contenido/referencia. Coherente con la
// completitud a nivel-workflow de T1.5 (el artefacto del paso terminal es el que
// WORKFLOW_COMPLETION verifica).

const crypto = require('crypto');

// Upsert de artefacto tipado (1 fila por initiative+doc_type; version=contador).
const upsertArtifact = async (db, { initiativeId, projectUrl, docType, title, content }) => {
  const strategy_key = 'method_artifact';
  const scope_key = `initiative:${initiativeId}:${docType}`;
  const body = content || '';
  const content_hash = crypto.createHash('sha256').update(body).digest('hex');
  const existing = await db('semantic_documents')
    .where({ project_url: projectUrl, strategy_key, scope_key })
    .first('id', 'version');
  if (existing) {
    await db('semantic_documents').where({ id: existing.id }).update({
      content: body, content_hash, title: title || null, doc_type: docType,
      version: existing.version + 1, initiative_id: initiativeId, updated_at: db.fn.now(),
    });
    return { id: existing.id, doc_type: docType, version: existing.version + 1, created: false };
  }
  const [row] = await db('semantic_documents').insert({
    project_url: projectUrl, strategy_key, scope_key, source_type: 'method_step',
    title: title || null, content: body, content_hash, doc_type: docType, version: 1,
    initiative_id: initiativeId,
  }).returning(['id']);
  return { id: row.id, doc_type: docType, version: 1, created: true };
};

const aptsSubmitStep = (db, { project_url, agent_name, output }) =>
  db.transaction(async (trx) => {
    const initiative = await loadActiveInitiative(trx, project_url);
    if (!initiative) {
      return { ok: false, why: `sin iniciativa activa en ${project_url}` };
    }
    const caller = await loadCallerPointer(trx, initiative.id, agent_name);
    if (!caller || !caller.current_step_id) {
      return { ok: false, why: `el agente '${agent_name}' no tiene un paso activo` };
    }
    if (caller.step_status === 'await_input') {
      return { ok: false, why: 'paso en espera-input; reanudá con apts_workflow_step (answers) antes de submit' };
    }
    const step = await trx('workflow_steps').where({ id: caller.current_step_id }).first();
    const workflow = await trx('workflow_definitions').where({ id: caller.current_workflow_id }).first();
    const cursor = caller.cursor || {};
    const declared = step.outputs || [];
    const out = output || {};

    // ---- 1. Captura de output según el descriptor del paso ----
    const captured = [];
    for (const decl of declared) {
      if (decl.kind === 'artifact') {
        const res = await upsertArtifact(trx, {
          initiativeId: initiative.id, projectUrl: project_url,
          docType: decl.doc_type, title: out.title, content: out.content,
        });
        captured.push({ kind: 'artifact', doc_type: decl.doc_type, id: res.id, version: res.version });
        // Conveniencia: cerrar el FK prd_artifact_id de la iniciativa cuando es el PRD.
        if (decl.doc_type === 'prd') {
          await trx('initiatives').where({ id: initiative.id }).update({ prd_artifact_id: res.id, updated_at: trx.fn.now() });
        }
      } else if (decl.kind === 'backlog_items') {
        // F4-T1: el motor crea las stories (server-authoritative). El agente genera
        // el CONTENIDO (out.stories: lista de {title, description?, acceptance_criteria?}
        // o strings); el motor las liga a la jerarquía (epic/initiative) con el status
        // canónico del método ('ready_for_dev'). Determinista = estructura; generativo
        // = contenido. Idempotente: no duplica por título bajo la iniciativa.
        const epic = await loadEpic(trx, initiative.id);
        const proposed = Array.isArray(out.stories) ? out.stories : [];
        const existing = await trx('backlog_items')
          .where({ initiative_id: initiative.id }).whereNull('deleted_at').select('title');
        const seen = new Set(existing.map((r) => r.title));
        const createdIds = [];
        let order = existing.length;
        for (const s of proposed) {
          const title = typeof s === 'string' ? s : (s && s.title);
          if (!title || seen.has(title)) continue;
          seen.add(title);
          const [row] = await trx('backlog_items').insert({
            project_url, title,
            description: (typeof s === 'object' && s.description) || null,
            acceptance_criteria: (typeof s === 'object' && s.acceptance_criteria) || null,
            item_type: 'feature', status: 'ready_for_dev',
            initiative_id: initiative.id, epic_id: epic ? epic.id : null,
            priority: 100, sort_order: order++,
          }).returning(['id']);
          createdIds.push(row.id);
        }
        captured.push({ kind: 'backlog_items', created: createdIds.length, ids: createdIds });
      } else if (decl.kind === 'status') {
        // Iterable (dev-story): actualiza la story reclamada + registra code_ref.
        if (cursor.story_id) {
          const to = out.status || decl.value || 'done';
          await trx('backlog_items').where({ id: cursor.story_id }).update({ status: to, updated_at: trx.fn.now() });
          captured.push({ kind: 'status', story_id: cursor.story_id, to, code_ref: out.code_ref || null });
        }
      } else if (decl.kind === 'code_ref') {
        captured.push({ kind: 'code_ref', ref: out.code_ref || null });
      }
    }

    // ---- 2. Avance del cursor: próximo paso, o cierre del workflow ----
    const steps = await loadSteps(trx, workflow.id);
    const next = steps.find((s) => s.step_order > step.step_order) || null;

    if (next) {
      // Mantiene el cursor (story_id/answers) y avanza dentro del workflow.
      await trx('project_state').where({ id: caller.id }).update({
        current_step_id: next.id, step_status: 'running', updated_at: trx.fn.now(),
      });
      return { ok: true, captured, advanced_to: next.key, workflow_complete: false };
    }
    // Sin próximo paso → workflow completo: libera el puntero (vuelve a idle). Para
    // iterables, liberar el cursor permite que el próximo claim tome otra unidad.
    await trx('project_state').where({ id: caller.id }).update({
      current_workflow_id: null, current_step_id: null, step_status: 'idle', cursor: null, updated_at: trx.fn.now(),
    });
    return { ok: true, captured, advanced_to: null, workflow_complete: true, iterable_unit_done: Boolean(step.iterable) };
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
      // F6-4 — La máquina de método es lineal hacia adelante, así que un estado como
      // 'blocked' (lo pone la monitorización de latidos caducados) no tiene salida por
      // aquí. Salida sí hay: la edición libre. Sin decirlo, el agente se queda parado
      // pidiendo ayuda con la herramienta en la mano — medido en F6-4-T2.
      const salida = allowed.length
        ? ''
        : `. Este estado no tiene salida por la máquina de método; para reponer la story usa `
          + `update_backlog_item (edición libre), p. ej. status 'ready'`;
      throw new MethodStatusError(
        `transición de método inválida: '${from}' → '${status}' (permitidas desde '${from}': ${allowed.length ? allowed.join(', ') : 'ninguna'})${salida}`,
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
  aptsWorkflowStep,
  aptsSubmitStep,
  methodStatus,
  setMethodStatus,
  STORY_METHOD_STATUSES,
  STORY_METHOD_TRANSITIONS,
  MethodStatusError,
  LIFECYCLE,
  nextPhase,
  claimDevStory,
  // F3-T1.5 — navegación DAG (exportadas para tests/harness)
  resolvePhaseSpine,
  resolveWorkflowVerdict,
  topoSortRequired,
  WORKFLOW_COMPLETION,
  PHASE_FALLBACK_WORKFLOW,
  // F3-T2 — goteo modelo B (exportadas para tests/harness)
  resolveNeed,
  buildStepPayload,
  upsertArtifact,
  SLICE_CHARS,
};
