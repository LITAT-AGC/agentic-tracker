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
const { buildWorkflowCompletion, perStoryDocTypes } = require('./method_outputs');
const { applyRewire } = require('../importer/rewire');

const LIFECYCLE = ['analysis', 'planning', 'solutioning', 'implementation', 'done'];
const TERMINAL_STATUSES = ['done', 'archived'];

const readPositiveInt = (raw, fallback) => {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

// Plazo del claim de una unidad iterable (arrendamiento, no reserva perpetua).
// El puntero se refresca en cada apts_workflow_step / apts_submit_step, así que un
// puntero `running` que lleva más de esto sin tocarse es un conductor que se murió
// a mitad de la story. Sin plazo esa unidad queda reservada para siempre y el ciclo
// responde `wait: sin unidades de trabajo libres` indefinidamente — el modo de fallo
// que un bucle desatendido encuentra y uno supervisado no, porque el operador
// reinicia a mano sin enterarse.
//
// El plazo debe superar al paso más largo de dev-story (implementar + escribir
// tests), porque trabajar NO refresca el puntero: sólo lo refresca el submit del
// paso. Por eso el defecto es holgado; bajarlo acelera la recuperación pero arriesga
// que dos agentes tomen la misma story mientras el primero sigue vivo trabajando.
const CLAIM_TTL_MS = readPositiveInt(process.env.METHOD_CLAIM_TTL_MS, 60 * 60 * 1000);

// Tope de saltos HACIA ATRÁS a un mismo paso dentro de una unidad de trabajo.
// Sólo lo pagan las ramas retrógradas: todo ciclo contiene al menos una arista hacia
// atrás, así que acotarlas acota el grafo entero, y los saltos hacia adelante terminan
// solos sin gastar presupuesto. Por eso el número significa exactamente "reintentos de
// este tramo" y no "veces que pasé por aquí".
//
// El contador vive en project_state.cursor.visits, no en el conductor: el bucle 8→5 de
// dev-story ocurre DENTRO de la sesión del agente, por debajo del muestreo de la huella
// de estancamiento, así que ningún freno de cliente puede verlo. Y vive en el cursor
// —no en la sesión— para que sobreviva a los reintentos del conductor y al re-servido
// del paso, y se limpie solo al cerrar el workflow o al soltar el claim: cada story
// empieza con presupuesto fresco.
const MAX_STEP_REVISITS = readPositiveInt(process.env.METHOD_MAX_STEP_REVISITS, 3);

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

// ---- Alcance de un artefacto tipado ----
// Casi todos los artefactos del metodo son de la INICIATIVA: hay un brief, un prd,
// una arquitectura. `story_spec` no: es de la unidad, y guardarlo con la clave de
// la iniciativa hacia que todas las stories compartieran una sola fila.
//
// La clave la compone esta funcion y nadie mas, porque la escritura
// (`upsertArtifact`) y la lectura (`resolveNeed`) tienen que coincidir exactamente:
// si se compusiera en los dos sitios, separarlas seria cuestion de tiempo y el
// sintoma volveria a ser el de siempre —un artefacto que no aparece, o el de otro—.
const PER_STORY_DOC_TYPES = perStoryDocTypes();

const isPerStoryDocType = (docType) => PER_STORY_DOC_TYPES.has(docType);

const artifactScopeKey = (initiativeId, docType, storyId) => (
  isPerStoryDocType(docType) && storyId
    ? `initiative:${initiativeId}:${docType}:story:${storyId}`
    : `initiative:${initiativeId}:${docType}`
);

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

// Estados de backlog ANTERIORES al método: los que pone la vía libre
// (`create_backlog_item`, el triaje, el panel). Un item que entra a una épica desde
// ahí arranca en la puerta de la máquina de método; si ya está EN la máquina
// —ready_for_dev/in_progress/review/done— o fuera de juego —archived, blocked—, se
// respeta su estado: adoptar no es reponer, y reponer es otra decisión.
const PRE_METHOD_STATUSES = ['draft', 'needs_details', 'ready'];
const METHOD_ENTRY_STATUS = 'ready_for_dev';
const methodEntryStatus = (status) => (
  PRE_METHOD_STATUSES.includes(status) ? METHOD_ENTRY_STATUS : status
);

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

// Fuente única del roster: las claves de rol de una librería, ordenadas. La usan
// `apts_next` (cuando el agente no tiene puntero), `create_initiative` (para
// publicarlo al arrancar) y el rechazo de `set_agent_role`.
//
// Vive aquí y no en `method_bootstrap` porque la dependencia sólo puede apuntar en
// un sentido, y desde que el bootstrap consulta la espina de fase (startPhaseGaps)
// el sentido es `method_bootstrap` → este módulo.
const loadRosterKeys = (db, sourceRef) => db('entities')
  .where({ source_ref: sourceRef, kind: 'role' })
  .orderBy('key', 'asc')
  .pluck('key');

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

// ---- Guardia de la fase de partida (create_initiative) ----
// `create_initiative` publica `phase`, y es la única puerta del contrato por la que
// un cliente puede saltarse trabajo que el motor habría exigido por el camino: el
// paseo inter-fase arranca en `initiatives.phase`, así que una fase de partida
// adelantada no se salta un paso, se salta fases enteras.
//
// Lo encontró producción el 2026-08-07. Un cliente que traía una spec arrancó en
// 'solutioning' —"analysis y planning ya cubiertos por el SPEC adjunto"— y la
// iniciativa llegó a implementation sin `brief` y sin `prd`: sin la elicitación del
// analyst y sin el PM. El servidor no pudo negarse porque la llamada era legal.
//
// La guardia dice lo que el motor ya sabía: saltarse una fase exige que los
// artefactos que la cierran YA existan en el proyecto. Se leen de la misma espina y
// del mismo mapa de completitud que usa `apts_next`, así que no hay un segundo
// criterio que pueda contradecir al primero. Y una spec no compra ningún salto: su
// doc_type es 'spec' justamente para no cerrar ninguna fase (method_bootstrap.js).
//
// Se busca por `project_url` y no por iniciativa: en el camino de alta la iniciativa
// todavía no existe, y el caso legítimo que esto deja pasar es exactamente ése —un
// proyecto que ya produjo esos artefactos en una iniciativa anterior—.
//
// Devuelve los huecos como dato; traducirlos a un 400 es de quien la llama.
const startPhaseGaps = async (db, { project_url, track, source_ref, phase }) => {
  const target = LIFECYCLE.indexOf(phase);
  if (target <= 0) return []; // 'analysis' (o fase desconocida): no se salta nada
  const gaps = [];
  for (const earlier of LIFECYCLE.slice(0, target)) {
    const spine = await resolvePhaseSpine(db, earlier, track, source_ref);
    for (const wf of spine) {
      const spec = WORKFLOW_COMPLETION[wf.key];
      if (!spec || spec.primitive !== 'artifact-exists') continue;
      const docType = spec.params.doc_type;
      const row = await db('semantic_documents').where({ project_url, doc_type: docType }).first('id');
      if (!row) gaps.push({ phase: earlier, workflow_key: wf.key, doc_type: docType });
    }
  }
  return gaps;
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

// ---- Perfil del agente ----
// La biblioteca guarda persona, principios, estilo e instruccion de cada agente desde el
// primer dia, y hasta ahora no las leia nadie: el paso servido llevaba `role` y `role` era
// solo la CLAVE de la entity. Editar un agente no cambiaba nada observable, que es lo que
// hacia inutil cualquier editor.
//
// La lectura pasa por aqui y por ningun otro sitio, para que la mezcla —corpus, override
// global ('*'), override del proyecto— sea una sola regla. Un campo nulo hereda; el
// override incompleto es la forma normal de usarlo.
//
// `requireOverride`: el perfil del corpus pesa unos 650 caracteres por agente y hasta hoy
// no viajaba. Mandarlo en cada paso servido seria un gasto de contexto que nadie pidio, y
// el motor no lo necesita para nada. Asi que al agente solo se le manda el perfil de un
// agente que alguien EDITO —que es justo el caso en que la edicion tiene que notarse—; sin
// override, el payload sale byte a byte como salia antes. El panel, que si quiere ver lo
// efectivo siempre, llama sin la opcion.
const ENTITY_PROFILE_FIELDS = ['name', 'persona', 'principles', 'communication_style', 'instruction'];

const resolveEntityProfile = async (db, key, projectUrl, { requireOverride = false } = {}) => {
  if (!key) return null;
  const base = await db('entities').where({ key }).first(...ENTITY_PROFILE_FIELDS);
  if (!base) return null;

  const hasOverrides = await db.schema.hasTable('entity_overrides');
  const scopes = projectUrl ? ['*', projectUrl] : ['*'];
  const overrides = hasOverrides
    ? await db('entity_overrides').where({ entity_key: key }).whereIn('scope_project_url', scopes)
    : [];

  // El global primero y el del proyecto despues, para que el segundo gane.
  const ordered = ['*', projectUrl]
    .map((scope) => overrides.find((row) => row.scope_project_url === scope))
    .filter(Boolean);

  if (requireOverride && !ordered.length) return null;

  const profile = {};
  for (const field of ENTITY_PROFILE_FIELDS) {
    let value = base[field] == null ? null : base[field];
    for (const row of ordered) {
      if (row[field] != null) value = row[field];
    }
    if (value != null && String(value).trim() !== '') profile[field] = value;
  }

  return Object.keys(profile).length ? profile : null;
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

  // Candidatas: stories no-terminales del epic, en el orden en que el backlog las
  // declara, bloqueadas para el claim.
  //
  // El orden lo mandan `priority` y `sort_order`, que es donde vive el plan: son las
  // mismas dos columnas por las que ordena `list_backlog_items`, y tenerlas y no usarlas
  // aqui hacia que el motor repartiera por otro criterio que el backlog no puede
  // expresar. `created_at` e `id` quedan detras como desempate, no como criterio.
  //
  // Antes ordenaba solo por esos dos, y el resultado era reparto AL AZAR: las stories de
  // un epic las crea el motor en un solo lote —`bmad-create-epics-and-stories`—, asi que
  // el `created_at` empata en las 15 y el desempate lo decidia el UUID. Se vio en
  // produccion el 2026-08-08: de las 15 que quedaban en fm-synth salio primera la de
  // `sort_order` 240 —la ULTIMA del plan, accesibilidad del editor—, que depende de otras
  // cinco todavia sin hacer. El agente verifico, se nego a fabricarlas de paso, reporto el
  // bloqueo dos veces y el freno de estancamiento paro el bucle. Ningun orden de trabajo
  // sobrevive a que el reparto lo decida un identificador aleatorio.
  const candidates = await db('backlog_items')
    .where({ epic_id: ctx.epic_id })
    .whereNotIn('status', TERMINAL_STATUSES)
    .orderBy('priority', 'asc')
    .orderBy('sort_order', 'asc')
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .forUpdate();

  // Sostenidas por OTRO agente (otro puntero running con cursor.story_id), pero
  // sólo mientras su arrendamiento siga vigente. La vigencia se calcula en la BASE
  // (el `now()` de Postgres), no con el reloj de Node: la aplicación y la base viven
  // en máquinas distintas, así que comparar dos relojes haría caducar claims por
  // deriva en vez de por abandono.
  const others = await db('project_state')
    .where({ initiative_id: ctx.initiative_id, step_status: 'running' })
    .whereNot({ agent_name: caller.agent_name })
    .select('*', db.raw("(updated_at < now() - ? * interval '1 millisecond') as lease_expired", [CLAIM_TTL_MS]));

  const heldByOthers = new Set();
  const expiredPointerIds = [];
  for (const o of others) {
    const storyId = o.cursor && o.cursor.story_id;
    // Un puntero sin story_id está conduciendo un paso generativo: no sostiene
    // ninguna unidad, así que su arrendamiento no es asunto de este reparto y no se
    // toca. Sin esta guarda, caducar liberaría trabajo generativo en curso.
    if (!storyId) continue;
    if (o.lease_expired) expiredPointerIds.push(o.id);
    else heldByOthers.add(storyId);
  }

  // Caducar es soltar: si el puntero no se libera, el agente muerto sigue figurando
  // como `running` sobre una story que otro acaba de tomar, y el reparto pasaría a
  // ver dos dueños. Se libera igual que en el camino de abajo (idle + cursor nulo).
  if (expiredPointerIds.length) {
    await db('project_state')
      .whereIn('id', expiredPointerIds)
      .update({ step_status: 'idle', cursor: null, updated_at: db.fn.now() });
  }

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
          // Dos causas muy distintas daban el MISMO `wait`. Una es transitoria —las
          // historias existen y las sostiene otro agente, hay que esperar—; la otra es
          // terminal: la épica no tiene ni una historia, así que no hay nada que
          // esperar y nunca lo habrá (la fase no cierra con la épica vacía y el
          // reparto no puede repartir de un conjunto vacío). Con el mismo mensaje, el
          // agente no puede distinguirlas y el conductor gira hasta el freno de
          // estancamiento. La segunda es `blocked`, y dice qué hacer.
          const vacia = await trx('backlog_items')
            .where({ epic_id: ctx.epic_id })
            .whereNull('deleted_at')
            .count('* as c')
            .first();
          if (!ctx.epic_id || Number(vacia.c) === 0) {
            const huerfanos = Number((await trx('backlog_items')
              .where({ project_url })
              .whereNull('epic_id')
              .whereNull('deleted_at')
              .count('* as c')
              .first()).c);
            return {
              next: 'blocked',
              target_id: null,
              role,
              why: 'la épica de la iniciativa no tiene ninguna historia, así que no hay unidades de '
                + 'trabajo y no las va a haber esperando'
                + (huerfanos
                  ? `. El backlog del proyecto sí tiene ${huerfanos} item(s) fuera de toda épica: el `
                    + 'motor no los ve. Adoptalos con adopt_backlog_items y volvé a pedir apts_next'
                  : '. El backlog del proyecto tampoco tiene items sueltos: creá las historias con '
                    + 'create_backlog_item y adoptalas con adopt_backlog_items, o reponé la iniciativa'),
              args,
            };
          }
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
    // Un artefacto de unidad se busca por la clave de ESTA unidad y de ninguna
    // otra. Si no existe, se sirve `present: false`, que es la verdad: esta story
    // todavia no tiene spec. Antes, al buscar solo por (iniciativa, doc_type), se
    // servia la de otra story como si fuera suya — un fallo mudo, que es la peor
    // clase: el paso recibia contexto ajeno y seguia adelante sin sintoma.
    const query = db('semantic_documents').where({ doc_type: need.doc_type });
    if (isPerStoryDocType(need.doc_type)) {
      // Sin unidad en el cursor no hay forma de saber cual de todas tocaria, y
      // elegir una seria reproducir el fallo. Se declara ausente.
      if (!ctx.story_id) {
        return { kind: 'artifact', doc_type: need.doc_type, present: false, ref: null, slice: null };
      }
      query.where({ scope_key: artifactScopeKey(ctx.initiative_id, need.doc_type, ctx.story_id) });
    } else {
      query.where({ initiative_id: ctx.initiative_id });
    }
    const row = await query
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

// ---- Control de flujo declarado por el paso (metadata.control / metadata.checks) ----
// El corpus BMAD ramifica dentro del paso: `<goto step|anchor>` y `HALT`. El
// importador lo preserva en workflow_steps.metadata.control, y las condiciones que lo
// gobiernan en metadata.checks[].condition_text. El payload sirve esas ramas y el
// cursor las aplica (apts_submit_step), así que el grafo que la base tenía sembrado se
// conduce de verdad: el paso de validación de dev-story vuelve al de implementación.
//
// Es poco y concreto: de los 137 pasos del corpus, 10 declaran `control` y sólo 5
// `goto step:` resuelven a un paso real. La rama que importa es dev-story 8 → 5.
//
// Viajan la rama y la condición; NUNCA checks[].raw. Medido sobre bmad-dev-story:
// control 272 B en los diez pasos y condition_text 1.446 B, contra 13.153 B de `raw`
// —7.343 B en un solo paso, seis veces el presupuesto de un need entero—, lo que
// rompería el coste ~constante por paso del modelo B. Y `raw` es prosa del modelo de
// archivos de BMAD (sprint-status.yaml, {{story_path}}) que APTS sustituyó por la
// base: servirla mandaría al agente a buscar ficheros que no existen. La regla del
// seed ("checks NO como prompt") sigue en pie: viaja la condición, no la prosa.
const CONTROL_CONDITIONS_MAX = 12;
const CONTROL_CONDITION_CHARS = 160;

// Forma canónica de una rama, la MISMA que viaja servida y de vuelta en el submit:
// 'HALT' o `step:<key>`. El agente devuelve un elemento literal de branches[], así que
// no hay vocabulario nuevo que aprender ni que parsear en ninguno de los dos lados, y
// validar es comprobar pertenencia al conjunto servido.
const branchToken = (branch) => {
  if (branch === 'HALT') return 'HALT';
  if (branch && typeof branch === 'object' && typeof branch.goto === 'string') return branch.goto;
  return null;
};

// Ramas que el motor PUEDE honrar, resueltas contra los pasos del propio workflow.
//
// El corpus declara dos cosas que no son direcciones: `goto anchor:*` —un ancla dentro
// de la prosa del paso, que APTS no tiene dónde resolver: seis de las once del corpus,
// las seis en el paso 1 de dev-story— y `goto step:N` hacia un paso que ese workflow no
// trae. Servirlas con `enforced: true` sería volver a mentir, sólo que al revés, así que
// se descartan aquí. De paso, ese paso 1 pasa de ocho ramas a dos.
//
// Se deduplica porque el importador aplana los <goto> a cualquier profundidad y repite:
// servir dos veces la misma rama es puro gasto y el protocolo de eco no distingue
// multiplicidad.
const resolveBranches = (step, stepKeys) => {
  const declared = (step.metadata && Array.isArray(step.metadata.control)) ? step.metadata.control : [];
  if (!declared.length) return [];
  const keys = new Set([...(stepKeys || [])].map((k) => String(k)));
  const out = [];
  const seen = new Set();
  for (const branch of declared) {
    const token = branchToken(branch);
    if (!token || seen.has(token)) continue;
    if (token !== 'HALT' && !(token.startsWith('step:') && keys.has(token.slice(5)))) continue;
    seen.add(token);
    out.push(token === 'HALT' ? 'HALT' : { goto: token });
  }
  return out;
};

// `stepKeys`: las claves de los pasos del workflow, para resolver los `goto step:`.
// El corpus namea cada paso con su `n` de BMAD (`key`), que no coincide con
// `step_order` cuando los n vienen salteados (0, 20, 30), así que el destino se
// resuelve por clave y nunca por posición.
const stepControlFlow = (step, stepKeys) => {
  const metadata = step.metadata || {};
  const branches = resolveBranches(step, stepKeys);
  const conditions = (Array.isArray(metadata.checks) ? metadata.checks : [])
    .map((c) => (c && typeof c.condition_text === 'string' ? c.condition_text.trim() : ''))
    .filter(Boolean)
    .slice(0, CONTROL_CONDITIONS_MAX)
    .map((t) => (t.length > CONTROL_CONDITION_CHARS ? `${t.slice(0, CONTROL_CONDITION_CHARS)}…` : t));
  if (!branches.length && !conditions.length) return null;
  // `enforced` dice si el MOTOR respalda estas ramas o sólo las declara el método. Ya
  // sí: apts_submit_step aplica la que el cliente declare en `output.control`, acotada
  // al conjunto de branches[] y con tope para las retrógradas. El campo se queda —era
  // la marca de capacidad en banda, y su trabajo era exactamente éste: que el cliente
  // no necesitara cambiar para enterarse de que el motor pasó a secundarlas.
  //
  // Describe las ramas. Un paso puede traer condiciones sin ninguna rama honrable
  // (dev-story 3 y 4): ahí no hay nada que respaldar y las condiciones siguen siendo
  // guía del método, no una promesa del motor.
  return { branches, conditions, enforced: true };
};

// Serializa el cursor preservando story_id (claim), answers (elicitación) y visits
// (presupuesto de saltos hacia atrás). Todo lo que no se nombre aquí se pierde en el
// siguiente re-servido del paso: `visits` sin esta línea sería un contador que se
// reinicia solo, es decir, ningún tope.
const serializeCursor = (cursor) => {
  const c = {};
  if (cursor && cursor.story_id) c.story_id = cursor.story_id;
  if (cursor && cursor.answers && Object.keys(cursor.answers).length) c.answers = cursor.answers;
  if (cursor && cursor.visits && Object.keys(cursor.visits).length) c.visits = cursor.visits;
  return Object.keys(c).length ? JSON.stringify(c) : null;
};

// Construye el payload servido de un paso (ADN re-cableado en serve-time + needs).
// mode: 'run' | 'await_input' (F3-T3). En await_input expone `questions`; cuando ya
// hubo input, lo devuelve en `provided_input` para que el paso se reconstruya completo.
const buildStepPayload = async (db, ctx, {
  initiative, workflow, step, role, storyId, mode = 'run', questions = null, providedInput = null,
}) => {
  const needs = [];
  // La unidad reclamada viaja en el contexto: sin ella, un need de artefacto
  // por-story no puede saber cual le toca.
  const ctxConUnidad = { ...ctx, story_id: storyId || null };
  for (const need of step.needs || []) {
    needs.push(await resolveNeed(db, ctxConUnidad, need));
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
  // Las claves hermanas sólo hacen falta para resolver los `goto step:`, así que la
  // consulta la pagan los 10 pasos del corpus que declaran `control`, no los 137.
  const declaresControl = Boolean(step.metadata && Array.isArray(step.metadata.control)
    && step.metadata.control.length);
  const stepKeys = declaresControl
    ? await db('workflow_steps').where({ workflow_id: workflow.id }).pluck('key')
    : [];
  // El perfil viaja SOLO si alguien edito a este agente: sin override, el payload sale
  // byte a byte como salia antes y el contexto no paga nada.
  const roleProfile = await resolveEntityProfile(db, role, ctx.project_url, { requireOverride: true });
  if (roleProfile) payload.role_profile = roleProfile;

  const controlFlow = stepControlFlow(step, stepKeys);
  if (controlFlow) payload.control_flow = controlFlow;
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
// referencia (code_ref); unidades iterables → status de la story reclamada. Luego mueve
// el cursor: a la rama que el caller declare en `output.control` si el paso la declara,
// y si no al próximo paso por step_order (o cierra el workflow y libera el puntero).
//
// El descriptor de output del paso (step.outputs, cableado en T2) decide QUÉ se
// captura; el `output` del caller trae el contenido/referencia. Coherente con la
// completitud a nivel-workflow de T1.5 (el artefacto del paso terminal es el que
// WORKFLOW_COMPLETION verifica).

const crypto = require('crypto');

// Upsert de artefacto tipado (1 fila por initiative+doc_type; version=contador).
const upsertArtifact = async (db, {
  initiativeId, projectUrl, docType, title, content, storyId,
}) => {
  const strategy_key = 'method_artifact';
  const scope_key = artifactScopeKey(initiativeId, docType, storyId);
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
    const steps = await loadSteps(trx, workflow.id);

    // ---- 0. Rama de control declarada por el caller ----
    // Las condiciones del método (`metadata.checks[].condition_text`) son prosa sobre
    // el árbol de trabajo —"ANY validation fails"—, y el importador aplana los <goto>
    // sin atribuirlos: el paso 8 de dev-story trae tres ramas y cuatro condiciones sin
    // nada que las empareje. El motor por tanto no puede ni evaluar ni elegir. Así que
    // el reparto es el mismo que ya rige la captura de outputs —determinista la
    // estructura, generativo el contenido—: el agente aporta el valor de verdad, que es
    // lo único que exige mirar el repositorio, y el motor aporta el grafo (sólo se va a
    // donde el paso declara) y el tope (MAX_STEP_REVISITS).
    //
    // Se valida ANTES de capturar: la transacción commitea al retornar, así que
    // rechazar después dejaría escritas las capturas de un submit que se dice fallido.
    const flow = stepControlFlow(step, steps.map((s) => s.key));
    const branches = (flow && flow.branches) || [];
    const asked = (out.control === undefined || out.control === null) ? null : branchToken(out.control);
    if ((out.control !== undefined && out.control !== null)
        && (!asked || !branches.some((b) => branchToken(b) === asked))) {
      const oferta = branches.map((b) => branchToken(b)).join(', ');
      return {
        ok: false,
        why: `rama de control no declarada por el paso '${step.key}': ${JSON.stringify(out.control)}`
          + `. ${oferta ? `Declaradas: ${oferta}` : 'Este paso no declara ninguna rama honrable'}`
          + '. Enviá en output.control un elemento literal de control_flow.branches, o ninguno para avanzar al paso siguiente',
      };
    }

    // ---- 0.bis. Compuerta de cierre: artefactos `required_for_close` ----
    // Un `extra` sin la marca se captura si viene y se ignora si no. Éste no: la
    // revisión adversaria de la unidad es la condición para cerrarla, y sin este
    // rechazo sería una recomendación con nombre de compuerta.
    //
    // Se comprueba ANTES de capturar y sin excepción para HALT. La captura corre antes
    // que el control, así que un HALT declarado sobre el paso terminal marcaría la story
    // done igual: dejar esa puerta abierta volvería opcional la compuerta con sólo
    // declarar que uno se detiene. Quien no pueda producir la revisión tiene que parar
    // ANTES del paso terminal y reportar el bloqueo, que es lo que el manifiesto manda.
    const sinCerrar = declared.find((d) => d.kind === 'artifact' && d.required_for_close
      && !(typeof out.content === 'string' && out.content.trim()));
    if (sinCerrar) {
      return {
        ok: false,
        why: `el paso '${step.key}' no cierra la unidad sin el artefacto '${sinCerrar.doc_type}': `
          + 'mandá su texto en output.content (y su título en output.title). '
          + 'Si no podés producirlo, no cierres la unidad: reportá el bloqueo y detenete',
      };
    }

    // ---- 0.ter. Compuerta de cierre: la épica no se queda vacía ----
    // Misma marca `required_for_close`, otra clase de output. Se comprueba contra el
    // ESTADO y no contra la forma del payload: rechaza sólo si, tras este submit, la
    // épica seguiría sin un solo hijo. Así un re-submit legítimo —el documento se
    // reescribe y las historias ya están— no rebota, y el único caso que rebota es el
    // que deja el plan sin unidades de trabajo, que es un callejón sin salida: la fase
    // 'implementation' no cierra con la épica vacía y el reparto no tiene qué repartir.
    const historiasRequeridas = declared.find((d) => d.kind === 'backlog_items' && d.required_for_close);
    if (historiasRequeridas) {
      const epicActual = await loadEpic(trx, initiative.id);
      const propuestas = Array.isArray(out.stories)
        ? out.stories.filter((s) => (typeof s === 'string' ? s.trim() : s && typeof s.title === 'string' && s.title.trim()))
        : [];
      const yaHay = epicActual
        ? Number((await trx('backlog_items').where({ epic_id: epicActual.id }).whereNull('deleted_at').count('* as c'))[0].c)
        : 0;
      if (!propuestas.length && yaHay === 0) {
        return {
          ok: false,
          why: `el paso '${step.key}' no cierra el plan con la épica vacía: mandá las historias en `
            + 'output.stories, una lista de { title, description?, acceptance_criteria? } '
            + '(o de títulos). El motor las liga a la épica y a la iniciativa; sin ellas la fase '
            + "'implementation' se queda sin unidades de trabajo y el ciclo no vuelve a avanzar. "
            + 'Si ya las creaste con create_backlog_item, adoptálas primero con adopt_backlog_items',
        };
      }
    }

    // ---- 1. Captura de output según el descriptor del paso ----
    const captured = [];
    for (const decl of declared) {
      if (decl.kind === 'artifact') {
        // `storyId` solo lo usa la clave de los artefactos por-unidad; para los de
        // iniciativa se ignora, asi que pasarlo siempre no cambia nada y evita
        // tener que decidir aqui de que tipo es cada uno.
        const res = await upsertArtifact(trx, {
          initiativeId: initiative.id, projectUrl: project_url,
          docType: decl.doc_type, title: out.title, content: out.content,
          storyId: cursor.story_id || null,
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
        //
        // Y tampoco duplica un HUÉRFANO: si el proyecto ya tiene un item con ese
        // título fuera de toda épica —lo normal cuando alguien pobló el backlog con
        // `create_backlog_item`, que no acepta jerarquía—, se ADOPTA en vez de crear
        // otro. La deduplicación miraba sólo `initiative_id = esta iniciativa`, y los
        // huérfanos lo tienen nulo: re-generar el plan clonaba el backlog entero y
        // dejaba dos copias de cada historia, una visible para el motor y otra no.
        const epic = await loadEpic(trx, initiative.id);
        const proposed = Array.isArray(out.stories) ? out.stories : [];
        const existing = await trx('backlog_items')
          .where({ initiative_id: initiative.id }).whereNull('deleted_at').select('title');
        const seen = new Set(existing.map((r) => r.title));
        const createdIds = [];
        const adoptedIds = [];
        let order = existing.length;
        for (const s of proposed) {
          const title = typeof s === 'string' ? s : (s && s.title);
          if (!title || seen.has(title)) continue;
          seen.add(title);

          const huerfano = await trx('backlog_items')
            .where({ project_url, title })
            .whereNull('epic_id')
            .whereNull('deleted_at')
            .orderBy('created_at', 'asc')
            .first('id', 'status');
          if (huerfano) {
            await trx('backlog_items').where({ id: huerfano.id }).update({
              initiative_id: initiative.id,
              epic_id: epic ? epic.id : null,
              status: methodEntryStatus(huerfano.status),
              sort_order: order++,
              updated_at: trx.fn.now(),
            });
            adoptedIds.push(huerfano.id);
            continue;
          }

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
        captured.push({
          kind: 'backlog_items',
          created: createdIds.length,
          adopted: adoptedIds.length,
          ids: [...createdIds, ...adoptedIds],
        });
      } else if (decl.kind === 'status') {
        // Iterable (dev-story): actualiza la story reclamada + registra code_ref.
        if (cursor.story_id) {
          const to = out.status || decl.value || 'done';
          const cambio = { status: to, updated_at: trx.fn.now() };
          // El hash viajaba en `captured[]` y no se escribia en ningun sitio: se pedia,
          // se transportaba y se tiraba, y APTS no podia decir que commit cerro que
          // unidad. Se guarda solo si viene: un submit sin hash no debe borrar el que
          // una entrega anterior ya dejo.
          const ref = typeof out.code_ref === 'string' && out.code_ref.trim() ? out.code_ref.trim() : null;
          if (ref) cambio.code_ref = ref;
          await trx('backlog_items').where({ id: cursor.story_id }).update(cambio);
          captured.push({ kind: 'status', story_id: cursor.story_id, to, code_ref: ref });
        }
      } else if (decl.kind === 'code_ref') {
        captured.push({ kind: 'code_ref', ref: out.code_ref || null });
      }
    }

    // ---- 2. Avance del cursor: rama declarada, próximo paso, o cierre del workflow ----
    const porQue = typeof out.control_why === 'string' && out.control_why.trim()
      ? out.control_why.trim()
      : null;

    // HALT: el paso NO avanza y el puntero se queda donde está. La unidad sigue
    // reclamada, así que el trabajo no se pierde ni se reparte a otro; lo que se
    // acabó es este submit. Las capturas ya hechas se conservan: el agente produjo
    // algo, y perderlo obligaría a rehacerlo.
    const detener = (why) => trx('project_state').where({ id: caller.id }).update({
      step_status: 'running', cursor: serializeCursor(cursor), updated_at: trx.fn.now(),
    }).then(() => ({ ok: true, captured, advanced_to: null, workflow_complete: false, halted: true, why }));

    if (asked === 'HALT') {
      return detener(`HALT declarado en el paso '${step.key}'${porQue ? `: ${porQue}` : ''}`);
    }

    if (asked) {
      const targetKey = asked.slice(5);
      const target = steps.find((s) => String(s.key) === targetKey);
      // Sólo las retrógradas gastan presupuesto; una arista hacia adelante no puede
      // cerrar un ciclo por sí sola.
      if (target.step_order <= step.step_order) {
        const visits = { ...(cursor.visits || {}) };
        const gastado = (visits[targetKey] || 0) + 1;
        if (gastado > MAX_STEP_REVISITS) {
          // Agotado, se degrada a HALT en vez de avanzar: seguir de largo pasaría por
          // encima de la validación que acaba de fallar tres veces y cerraría la story
          // con lo que no pasó. Al no moverse el cursor, la huella del conductor se
          // congela y el freno de estancamiento vuelve a morder.
          return detener(
            `tope de reintentos del paso '${targetKey}' agotado (${MAX_STEP_REVISITS}); `
            + `el paso '${step.key}' no puede volver a saltar hacia atrás en esta unidad`
            + `${porQue ? `. Último motivo declarado: ${porQue}` : ''}`,
          );
        }
        visits[targetKey] = gastado;
        cursor.visits = visits;
      }
      await trx('project_state').where({ id: caller.id }).update({
        current_step_id: target.id, step_status: 'running',
        cursor: serializeCursor(cursor), updated_at: trx.fn.now(),
      });
      return {
        ok: true, captured, advanced_to: target.key, workflow_complete: false, branch: asked,
      };
    }

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
  // Adopción de items huérfanos: la usan la captura de este módulo y la operación
  // de reparación (method_bootstrap.adoptBacklogItems), que tienen que coincidir.
  PRE_METHOD_STATUSES,
  METHOD_ENTRY_STATUS,
  methodEntryStatus,
  loadActiveInitiative,
  loadEpic,
  LIFECYCLE,
  nextPhase,
  claimDevStory,
  loadRosterKeys,
  resolveEntityProfile,
  ENTITY_PROFILE_FIELDS,
  startPhaseGaps,
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
  stepControlFlow,
  branchToken,
  resolveBranches,
  CONTROL_CONDITIONS_MAX,
  CONTROL_CONDITION_CHARS,
  CLAIM_TTL_MS,
  MAX_STEP_REVISITS,
};
