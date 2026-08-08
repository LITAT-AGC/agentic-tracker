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
// F4-T1: los workflows de proceso/validación se modelan como productores de doc
// tipado (decisión del operador), igual que brief/prd/… — fiel a BMAD, que escribe
// readiness report / sprint status / story spec como documentos. Esto elimina los
// count-threshold `provisional` de F3-T1.5: TODOS los required de fase cierran por
// artifact-exists (uniforme, sin depender de stories que aún no existen).

const WORKFLOW_OUTPUTS = {
  // Artefactos tipados (doc_type del enum) → completitud por artifact-exists.
  'bmad-product-brief': { output: { kind: 'artifact', doc_type: 'brief' } },
  'bmad-prd': { output: { kind: 'artifact', doc_type: 'prd' } },
  'bmad-create-architecture': { output: { kind: 'artifact', doc_type: 'architecture' } },
  // F4-T1: produce el doc 'epics' (gatea completitud) Y, como efecto del motor
  // (server-authoritative), crea los backlog_items ligados al epic/initiative desde
  // el contenido que genera el agente (out.stories). `extra` = descriptores
  // adicionales del paso terminal que NO gatean completitud (sólo los captura submit).
  'bmad-create-epics-and-stories': {
    output: { kind: 'artifact', doc_type: 'epics' },
    extra: [{ kind: 'backlog_items' }],
  },
  // F4-T1: docs de proceso/validación (doc_types agregados en migración 015).
  'bmad-check-implementation-readiness': { output: { kind: 'artifact', doc_type: 'readiness' } },
  'bmad-sprint-planning': { output: { kind: 'artifact', doc_type: 'sprint_plan' } },
  // `scope: 'story'` — el UNICO artefacto que no es de la iniciativa sino de la
  // unidad. Sin esta marca, `story_spec` se guardaba en la misma fila que todos
  // los demas (`initiative:<id>:<doc_type>`) y por tanto habia UNA sola para la
  // iniciativa entera: la primera story que escribia la suya se la servia despues
  // a todas las demas como `needs[]`. Lo encontro un agente el 2026-08-08
  // trabajando el importador SysEx y recibiendo la especificacion de la historia
  // 1.3; se dio cuenta y tiro de `get_backlog_item`, pero el fallo es silencioso
  // —no da error, da el contexto equivocado— y el siguiente podia no verlo.
  'bmad-create-story': { output: { kind: 'artifact', doc_type: 'story_spec', scope: 'story' } },
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

// Los doc_type que son de la UNIDAD y no de la iniciativa. Derivado del mismo mapa
// que todo lo demas, para que marcar el alcance en un sitio baste.
//
// Ojo con la completitud: `WORKFLOW_COMPLETION` sigue evaluando `artifact-exists`
// a nivel de iniciativa tambien para estos, y se deja asi a proposito. Ese
// predicado gatea el AVANCE DE FASE, no el contexto que se sirve; hacerlo
// por-story convertiria "hay una spec" en "hay una spec de cada story", que es
// otra decision —mas estricta y capaz de plantar una iniciativa en marcha— y no
// es la que este arreglo viene a tomar.
const perStoryDocTypes = () => new Set(
  Object.values(WORKFLOW_OUTPUTS)
    .filter((spec) => spec.output.kind === 'artifact' && spec.output.scope === 'story')
    .map((spec) => spec.output.doc_type),
);

// Construye el mapa de completitud a nivel-workflow (consumido por el resolver T1.5).
const buildWorkflowCompletion = () => {
  const completion = {};
  for (const [key, spec] of Object.entries(WORKFLOW_OUTPUTS)) {
    const c = outputToCompletion(spec.output);
    if (c) completion[key] = spec.provisional ? { ...c, provisional: true } : c;
  }
  return completion;
};

module.exports = { WORKFLOW_OUTPUTS, outputToCompletion, buildWorkflowCompletion, perStoryDocTypes };
