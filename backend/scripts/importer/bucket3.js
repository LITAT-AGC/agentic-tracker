// F2-T3 — Triage del balde 3 (routing/gates deterministas), lógica pura.
//
// REGLA (ledger, riesgo §9): el balde 3 NUNCA se auto-compila. Los `<check if>`
// son lenguaje natural. Esto NO genera primitivas ejecutables: agrupa las
// condiciones por patrón léxico para TRIAGE HUMANO y propone una lista de
// primitivas a implementar en backend (F3-T1). La clasificación es una ayuda,
// no autoridad — cada condición se confirma a mano antes de implementar.
//
// Categorías:
//   runtime      — ramas conversacionales / input de usuario / elicitación.
//                  NO son primitivas de servidor → estado await-input del goteo (F3).
//   file_model   — chequeos del modelo-de-archivos de BMAD (sprint-status.yaml,
//                  story files, sharding). Bajo APTS el estado vive en DB →
//                  MOOT o mapea a artifact-exists. No requieren primitiva nueva.
//   maps_existing— gate determinista que mapea a una primitiva YA implementada
//                  (artifact-exists / count-threshold / all-children-status).
//   needs_new    — gate determinista de servidor SIN primitiva equivalente →
//                  candidato a primitiva NUEVA (la propuesta sale de acá).

const EXISTING_PRIMITIVES = ['artifact-exists', 'count-threshold', 'all-children-status'];

// Orden importa: runtime y file_model se chequean antes que los gates de estado.
const RULES = [
  { cat: 'runtime', re: /\b(user|{user_name})\b.*\b(choose|chooses|chose|provide|provides|provided|says|say|confirm|confirms|expresses|approv)|^\s*(yes|no)\b|no or revise|choice\s*==|mode\s*(is|==)|option|unclear|ambiguous|user input|asks for/i },
  { cat: 'file_model', re: /\bfile\b.*(exist|exists|not found|does not exist)|sprint.?status.*(exist|file)|story file|sharded|single file|architecture file is|\.yaml|\.md\b|frontmatter|baseline_commit/i },
  { cat: 'maps_existing', re: /\b(is\s*'?done'?|epic is complete|all\s+.*\b(done|complete|pass|satisfied)|status\s*(is|==).*\b(done|review|ready[- ]for[- ]dev|in[- ]progress)|exists?\b)/i },
  { cat: 'needs_new', re: /\b(>|<|>=|<=)\b|\bnum(ber)?\b|threshold|>= ?90|> ?10|< ?1|story_num|epic_num|completion_percentage|debt_count|required field|any (invalid|required|status).*(missing|invalid)|unrecognized|development_status missing|not one of|severity/i },
];

const classifyCondition = (text) => {
  const t = (text || '').trim();
  if (!t) return 'runtime'; // sin condición textual → tratada como rama de control
  for (const r of RULES) if (r.re.test(t)) return r.cat;
  // default conservador: estado/igualdad simple → mapea a existentes; si no, runtime.
  if (/\b(is|==|!=|exists?)\b/i.test(t)) return 'maps_existing';
  return 'runtime';
};

// Propuesta de primitivas NUEVAS (juicio de ingeniería, NO auto-derivado).
// Cada una se confirma en F3-T1 contra las condiciones reales del bucket needs_new.
const PROPOSED_PRIMITIVES = [
  {
    key: 'entity-status',
    name: 'Entity status equals',
    category: 'gate',
    description:
      'Verdadero si una entidad concreta (story/epic/initiative) está en el status dado. ' +
      'Complementa all-children-status (agregado) con el chequeo de UNA unidad. ' +
      'Cubre: "epic status is done", "story status == review", "current_status == ready-for-dev".',
    params_schema: { target: 'string', status: 'string' },
  },
  {
    key: 'count-compare',
    name: 'Count comparison',
    category: 'gate',
    description:
      'Comparación numérica general (>, >=, <, <=, ==) de un conteo/índice contra un umbral. ' +
      'Generaliza count-threshold (que solo hace >= min). ' +
      'Cubre: "story_num > 1", "completion_percentage >= 90", "debt_count > 10", "prev_epic_num < 1".',
    params_schema: { metric: 'string', op: 'string', value: 'number' },
  },
  {
    key: 'next-sibling-exists',
    name: 'Next sibling exists',
    category: 'router',
    description:
      'Verdadero si existe el siguiente hermano en una secuencia (p. ej. epic siguiente, ' +
      'story siguiente en el sprint). Enruta el cierre de ciclo épico/sprint. ' +
      'Cubre: "next epic found/NOT found", "first story in epic", "previous story exists".',
    params_schema: { sequence: 'string', from: 'string' },
  },
];

// Analiza el corpus IR → triage agrupado + propuesta.
const analyzeBucket3 = (corpus) => {
  const structured = corpus.filter((ir) => ir.dialect === 'structured');
  const conditions = [];
  for (const ir of structured) {
    for (const s of ir.steps) {
      for (const c of s.checks) {
        conditions.push({
          skill: ir.key,
          step: s.n,
          condition: c.condition_text,
          category: classifyCondition(c.condition_text),
        });
      }
    }
  }
  const byCat = { runtime: [], file_model: [], maps_existing: [], needs_new: [] };
  for (const c of conditions) byCat[c.category].push(c);

  // routing inter-fase declarativo (CSV) — esto YA es regla determinista (no <check>).
  const routing = corpus
    .filter((ir) => ir.routing)
    .map((ir) => ({
      skill: ir.key,
      phase: ir.phase,
      preceded_by: ir.routing.preceded_by,
      followed_by: ir.routing.followed_by,
      required: ir.routing.required,
      outputs: ir.routing.outputs,
    }));

  return {
    totalConditions: conditions.length,
    byCat,
    routing,
    existingPrimitives: EXISTING_PRIMITIVES,
    proposedPrimitives: PROPOSED_PRIMITIVES,
  };
};

module.exports = { analyzeBucket3, classifyCondition, PROPOSED_PRIMITIVES, EXISTING_PRIMITIVES };
