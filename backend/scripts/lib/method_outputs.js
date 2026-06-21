// F3-T2 — Fuente ÚNICA de "qué produce cada workflow" (output server-observable).
//
// Decisión del operador (2026-06-21): los `outputs[]` per-step de T2 se derivan de
// la MISMA fuente que la completitud a nivel-workflow de T1.5 y se adjuntan al paso
// terminal → coherentes POR CONSTRUCCIÓN (no hay drift posible entre ambos).
//
// De este mapa se derivan, sin duplicar:
//   · T1.5 `WORKFLOW_COMPLETION` (la primitiva que verifica que el output exista) —
//     vía `buildWorkflowCompletion()` en method_resolver.js.
//   · T2 `outputs[]` del paso terminal + `needs[]` upstream — vía
//     scripts/importer/wiring.js, cableados en el seed.
//
// Editable-by-design (data del método). Keys = workflow key del corpus. Los
// workflows ausentes (research, ux, help, …) no producen output server-observable
// estructurado en v1 (sus pasos quedan con outputs:[]).
//
// `provisional`: el output no mapea a un doc_type del enum; se gatea por estado-
// servidor (hay historias bajo el epic). Se afina en F4 (el gate F3 sólo recorre
// analysis→planning, con specs limpias brief/prd).

const WORKFLOW_OUTPUTS = {
  // Artefactos tipados (doc_type del enum) → completitud por artifact-exists.
  'bmad-product-brief': { output: { kind: 'artifact', doc_type: 'brief' } },
  'bmad-prd': { output: { kind: 'artifact', doc_type: 'prd' } },
  'bmad-create-architecture': { output: { kind: 'artifact', doc_type: 'architecture' } },
  'bmad-create-epics-and-stories': { output: { kind: 'artifact', doc_type: 'epics' } },
  // Producen unidades de backlog (no doc_type) → completitud por count-threshold (provisional F4).
  'bmad-create-story': { output: { kind: 'backlog_items' }, provisional: true },
  'bmad-sprint-planning': { output: { kind: 'backlog_items' }, provisional: true },
  'bmad-check-implementation-readiness': { output: { kind: 'backlog_items' }, provisional: true },
  // Ejecutor per-historia (iterable): cierra cuando todas las historias están done.
  'bmad-dev-story': { output: { kind: 'status', value: 'done' }, iterable: true },
};

// Descriptor de output → primitiva que verifica que está satisfecho (completitud).
// Es el puente T2-output ↔ T1.5-completitud: misma fuente, no se pueden contradecir.
const outputToCompletion = (output) => {
  if (output.kind === 'artifact') {
    return { primitive: 'artifact-exists', params: { doc_type: output.doc_type } };
  }
  if (output.kind === 'backlog_items') {
    return { primitive: 'count-threshold', params: { parent: 'epic', min: 1 } };
  }
  if (output.kind === 'status' && output.value === 'done') {
    return { primitive: 'all-children-status', params: { parent: 'epic', status: 'done' } };
  }
  return null;
};

// Construye el mapa de completitud a nivel-workflow (consumido por el resolver T1.5).
const buildWorkflowCompletion = () => {
  const completion = {};
  for (const [key, spec] of Object.entries(WORKFLOW_OUTPUTS)) {
    const c = outputToCompletion(spec.output);
    if (c) completion[key] = spec.provisional ? { ...c, provisional: true } : c;
  }
  return completion;
};

module.exports = { WORKFLOW_OUTPUTS, outputToCompletion, buildWorkflowCompletion };
