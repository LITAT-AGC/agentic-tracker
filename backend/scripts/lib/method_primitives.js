// F1-T2 — Primitivas base de gate (lógica de servidor pura) + cascada de
// prioridad intra-fase. Mismo patrón que scripts/lib/semantic_documents.js:
// funciones puras que reciben `db` (knex/trx, perfil `test`) y datos resueltos,
// sin estado propio ni Express.
//
// Contrato de una primitiva (firma única):
//   async (db, ctx, params) => { pass, observed, detail }
//     db     : handle knex/trx
//     ctx    : estado de instancia YA resuelto a ids reales (no símbolos):
//              { initiative_id, project_url, epic_id, story_id? }
//     params : workflow_steps.metadata.primitive_params (verbatim del contrato fijado por la fixture)
//     pass     : boolean (resultado del gate)
//     observed : valor medido real (para el `why` de apts_next en T3 y la medición de contexto en T5)
//     detail   : string corto legible
//
// El registro EN CÓDIGO (IMPLEMENTED_KEYS) es la fuente de verdad de qué está
// implementado; `primitives_palette.implemented` se reconcilia desde acá
// (reconcilePrimitiveRegistry) como hint de catálogo/UI, no como autoridad.

const HANDLER_REF = 'scripts/lib/method_primitives.js';

// Estados que cuentan como "terminado" para unidades de trabajo (stories).
const TERMINAL_STATUSES = ['done', 'archived'];

// ---- Resolución parent -> hijos (extensible). Solo 'epic' se ejercita en la fixture. ----
const countChildren = async (db, ctx, parent) => {
  if (parent === 'epic') {
    if (!ctx.epic_id) return 0;
    const [{ c }] = await db('backlog_items').where({ epic_id: ctx.epic_id }).count('* as c');
    return Number(c);
  }
  if (parent === 'initiative') {
    const [{ c }] = await db('epics').where({ initiative_id: ctx.initiative_id }).count('* as c');
    return Number(c);
  }
  throw new Error(`count/parent no soportado: ${parent}`);
};

const countChildrenWithStatus = async (db, ctx, parent, status) => {
  if (parent === 'epic') {
    if (!ctx.epic_id) return 0;
    const [{ c }] = await db('backlog_items').where({ epic_id: ctx.epic_id, status }).count('* as c');
    return Number(c);
  }
  if (parent === 'initiative') {
    const [{ c }] = await db('epics').where({ initiative_id: ctx.initiative_id, status }).count('* as c');
    return Number(c);
  }
  throw new Error(`all-children-status/parent no soportado: ${parent}`);
};

// ---- Las 3 primitivas ----

// Verdadero si la iniciativa tiene un artefacto del doc_type dado (o cualquiera si se omite).
// Un semantic_document sin doc_type es un doc legacy, no un artefacto.
const artifactExists = async (db, ctx, params = {}) => {
  let q = db('semantic_documents').where({ initiative_id: ctx.initiative_id });
  q = params.doc_type ? q.where({ doc_type: params.doc_type }) : q.whereNotNull('doc_type');
  const row = await q.orderBy('version', 'desc').first('doc_type', 'version');
  const pass = Boolean(row);
  return {
    pass,
    observed: row ? { doc_type: row.doc_type, version: row.version } : null,
    detail: pass
      ? `artefacto ${row.doc_type} v${row.version} presente`
      : `falta artefacto${params.doc_type ? ` ${params.doc_type}` : ''}`,
  };
};

// Verdadero si el conteo de hijos del parent alcanza min.
const countThreshold = async (db, ctx, params = {}) => {
  const { parent, min } = params;
  const count = await countChildren(db, ctx, parent);
  const pass = count >= min;
  return {
    pass,
    observed: { parent, count, min },
    detail: `${count}/${min} hijos de ${parent}`,
  };
};

// Verdadero si TODOS los hijos del parent están en el status dado.
// Borde: conjunto vacío => false (no "vacuamente verdadero"); una épica sin
// historias no debe pasar el gate "todas done".
const allChildrenStatus = async (db, ctx, params = {}) => {
  const { parent, status } = params;
  const total = await countChildren(db, ctx, parent);
  const matching = total === 0 ? 0 : await countChildrenWithStatus(db, ctx, parent, status);
  const pass = total > 0 && matching === total;
  return {
    pass,
    observed: { parent, total, matching, status },
    detail: total === 0
      ? `sin hijos de ${parent}`
      : `${matching}/${total} hijos de ${parent} en ${status}`,
  };
};

const PRIMITIVES = {
  'artifact-exists': artifactExists,
  'count-threshold': countThreshold,
  'all-children-status': allChildrenStatus,
};

const IMPLEMENTED_KEYS = Object.keys(PRIMITIVES);

const evaluatePrimitive = (db, key, ctx, params) => {
  const fn = PRIMITIVES[key];
  if (!fn) throw new Error(`primitiva no implementada: ${key}`);
  return fn(db, ctx, params || {});
};

// ---- Cascada de prioridad intra-fase ----
// resolvePhaseStep camina el grafo de steps de UNA fase de forma determinista y
// devuelve el verdicto de esa fase. T3 (apts_next) le pone encima la lógica
// inter-fase + roles + multi-agente.
//
// Verdicto:
//   { kind:'actionable', step, why, needs }   -> hay un generative que ejecutar
//   { kind:'phase_done', why, observed }       -> la fase está completa
//   { kind:'blocked',    step, why }           -> ciclo de gate (seguridad)

// ¿Quedan unidades de trabajo sin terminar bajo el epic? (para steps iterables)
const hasUnfinishedUnits = async (db, ctx) => {
  if (!ctx.epic_id) return false;
  const [{ c }] = await db('backlog_items')
    .where({ epic_id: ctx.epic_id })
    .whereNotIn('status', TERMINAL_STATUSES)
    .count('* as c');
  return Number(c) > 0;
};

// ¿Los outputs declarados del generative ya existen en el estado?
const outputsSatisfied = async (db, ctx, step) => {
  const outputs = step.outputs || [];
  if (outputs.length === 0) return false; // un generative sin outputs siempre es accionable
  for (const out of outputs) {
    if (out.kind === 'artifact') {
      const { pass } = await artifactExists(db, ctx, { doc_type: out.doc_type });
      if (!pass) return false;
    } else if (out.kind === 'backlog_items') {
      const { pass } = await countThreshold(db, ctx, { parent: 'epic', min: 1 });
      if (!pass) return false;
    } else if (out.kind === 'code_ref' || (out.kind === 'status' && out.value === 'done')) {
      // step iterable (dev-story): satisfecho <=> no quedan unidades sin terminar
      if (await hasUnfinishedUnits(db, ctx)) return false;
    } else {
      throw new Error(`output kind no soportado en cascada: ${out.kind}`);
    }
  }
  return true;
};

const resolvePhaseStep = async (db, ctx, _workflow, steps) => {
  const byKey = new Map(steps.map((s) => [s.key, s]));
  const ordered = [...steps].sort((a, b) => a.step_order - b.step_order);
  const nextByOrder = (step) => ordered.find((s) => s.step_order > step.step_order) || null;

  let cursor = ordered[0];
  const visited = new Set();

  while (cursor) {
    if (visited.has(cursor.key)) {
      return { kind: 'blocked', step: cursor, why: `ciclo de gate en '${cursor.key}'` };
    }
    visited.add(cursor.key);

    if (cursor.kind === 'generative') {
      const satisfied = await outputsSatisfied(db, ctx, cursor);
      if (!satisfied) {
        return {
          kind: 'actionable',
          step: cursor,
          needs: cursor.needs || [],
          why: `paso '${cursor.key}': ${cursor.goal}`,
        };
      }
      cursor = nextByOrder(cursor);
      continue;
    }

    // deterministic (gate)
    const params = (cursor.metadata && cursor.metadata.primitive_params) || {};
    const verdict = await evaluatePrimitive(db, cursor.primitive_key, ctx, params);
    const rules = cursor.next_rules || {};
    const goto = verdict.pass ? rules.on_pass && rules.on_pass.goto : rules.on_fail && rules.on_fail.goto;

    if (goto === '__phase_done__') {
      return {
        kind: 'phase_done',
        why: `gate '${cursor.key}' superado: ${verdict.detail}`,
        observed: verdict.observed,
      };
    }
    const target = byKey.get(goto);
    if (!target) {
      return { kind: 'blocked', step: cursor, why: `goto inválido '${goto}' en gate '${cursor.key}'` };
    }
    cursor = target;
  }

  return { kind: 'phase_done', why: 'fin de steps sin gate de cierre' };
};

// ---- Reconciliación del catálogo (opción A aprobada) ----
// Idempotente: marca implemented=true + handler_ref para las keys del registro
// en código. No toca keys ausentes del registro.
const reconcilePrimitiveRegistry = async (db) => {
  const updated = await db('primitives_palette')
    .whereIn('key', IMPLEMENTED_KEYS)
    .update({ implemented: true, handler_ref: HANDLER_REF, updated_at: db.fn.now() });
  return updated;
};

module.exports = {
  PRIMITIVES,
  IMPLEMENTED_KEYS,
  HANDLER_REF,
  evaluatePrimitive,
  resolvePhaseStep,
  reconcilePrimitiveRegistry,
  // exportadas para tests/harness
  artifactExists,
  countThreshold,
  allChildrenStatus,
  outputsSatisfied,
};
