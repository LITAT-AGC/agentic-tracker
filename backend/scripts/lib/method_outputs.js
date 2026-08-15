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
  //
  // `required_for_close` porque este `extra` es la razón de ser del workflow, y sin
  // la marca era un adorno: la completitud del workflow es `artifact-exists` del doc
  // 'epics', así que un submit con el documento y sin `out.stories` cerraba la
  // planificación con la épica VACÍA. Y una épica vacía no tiene vuelta atrás: la
  // fase 'implementation' no cierra nunca —`all-children-status` con cero hijos es
  // false a propósito— y `claimDevStory` no reparte nada porque no hay hijos, así que
  // el ciclo responde `wait` para siempre. Se vio en un cliente real el 2026-08-14
  // (proyecto "tickets"): 21 items en el backlog, `backlog: {total: 0}` para el motor.
  // La compuerta se comprueba contra el estado —rechaza sólo si la épica se quedaría
  // sin hijos—, no contra la forma del payload.
  'bmad-create-epics-and-stories': {
    output: { kind: 'artifact', doc_type: 'epics' },
    extra: [{ kind: 'backlog_items', required_for_close: true }],
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
  //
  // El `extra` es la revisión adversaria (`bmad-code-review`), y está AQUÍ y no en la
  // espina de la fase a propósito. La espina se recorre en orden y activa el primer
  // workflow no-completo, y dev-story sólo está completo cuando TODAS las historias
  // están done: un `bmad-code-review` colgado detrás de él correría una vez, al final,
  // sobre el lote entero. Y su completitud sería `artifact-exists` a nivel de
  // iniciativa, así que un solo documento cerraría el workflow para las 25 historias.
  // La revisión no es una compuerta de la FASE —no dice nada sobre si implementation
  // terminó—, es una compuerta de la UNIDAD. Declarada como output del paso terminal
  // de dev-story corre por historia por construcción, y se captura en el mismo submit
  // que cierra la unidad.
  //
  // `required_for_close`: sin ese artefacto el submit terminal se rechaza. Es lo que
  // separa una compuerta de un adorno; un `extra` sin la marca sólo se captura si viene.
  'bmad-dev-story': {
    output: { kind: 'status', value: 'done' },
    extra: [{
      kind: 'artifact', doc_type: 'code_review', scope: 'story', required_for_close: true,
    }],
    iterable: true,
  },
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
//
// Mira el output primario Y los `extra`: el alcance es del artefacto, no del papel que
// juega en la completitud. Si sólo mirara el primario, `code_review` —que es un extra—
// se guardaria con la clave de la iniciativa y las 25 historias compartirian una sola
// fila de revision, que es exactamente el fallo mudo que `story_spec` acaba de costar.
const perStoryDocTypes = () => new Set(
  Object.values(WORKFLOW_OUTPUTS)
    .flatMap((spec) => [spec.output, ...(spec.extra || [])])
    .filter((o) => o.kind === 'artifact' && o.scope === 'story')
    .map((o) => o.doc_type),
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
