// F3-T2 — Derivación del wiring per-step (needs[]/outputs[]/iterable) desde la IR.
//
// Diferido de F2 (los 137 steps bmad quedaron con needs/outputs NULL e
// iterable=false): acá se computan desde datos ya presentes en la IR — `routing`
// (preceded_by/outputs) — y desde la fuente única de outputs (method_outputs.js).
// Lógica pura; el seed (seeds/bmad_seed.js) la aplica al cargar.
//
// Reglas (acordadas con el operador 2026-06-21):
//   · outputs[]  → SOLO el paso terminal del workflow lleva el output del workflow
//     (derivado de WORKFLOW_OUTPUTS); los previos quedan outputs:[]. Misma fuente
//     que la completitud T1.5 → coherentes por construcción.
//   · needs[]    → dependencias upstream desde routing.preceded_by (mapeadas a su
//     artefacto vía WORKFLOW_OUTPUTS); uniformes por workflow (cada paso reinyecta
//     un slice acotado en serve-time = costo-B). Refinamiento per-step = F4.
//   · iterable   → true para el ejecutor per-unidad (dev-story), marcado en WORKFLOW_OUTPUTS.

const { WORKFLOW_OUTPUTS } = require('../lib/method_outputs');

// Dependencias upstream (artefactos que el workflow consume) desde preceded_by.
// Sólo upstream que produce un ARTEFACTO (doc_type) se vuelve un need recuperable;
// los que producen backlog_items/estado se resuelven por target_id/contexto, no por slice.
const deriveNeeds = (ir) => {
  const pb = (ir.routing && ir.routing.preceded_by) || [];
  const refs = Array.isArray(pb) ? pb : [pb];
  const needs = [];
  const seen = new Set();
  for (const ref of refs) {
    const baseKey = String(ref).split(':')[0]; // descarta refs a sub-pasos (key:substep)
    const spec = WORKFLOW_OUTPUTS[baseKey];
    if (spec && spec.output.kind === 'artifact' && !seen.has(spec.output.doc_type)) {
      needs.push({ kind: 'artifact', doc_type: spec.output.doc_type, source: 'upstream', from: baseKey });
      seen.add(spec.output.doc_type);
    }
  }
  return needs;
};

// Wiring completo de una IR: needs (uniforme), iterable (uniforme), outputs por índice.
const deriveWiring = (ir) => {
  const spec = WORKFLOW_OUTPUTS[ir.key] || null;
  const needs = deriveNeeds(ir);
  const iterable = Boolean(spec && spec.iterable);
  const n = ir.steps.length;
  const outputsByIndex = ir.steps.map((_step, i) => (spec && i === n - 1 ? [spec.output] : []));
  return { needs, iterable, outputsByIndex };
};

module.exports = { deriveWiring, deriveNeeds };
