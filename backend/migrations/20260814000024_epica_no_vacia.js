// La épica no se queda vacía — `required_for_close` en el `extra` de backlog_items del
// paso terminal de `bmad-create-epics-and-stories`.
//
// La completitud del workflow es `artifact-exists` del doc 'epics', y las historias
// eran un `extra` sin marca: un submit con el documento y sin `out.stories` cerraba la
// planificación con la épica vacía. Eso no tiene vuelta atrás — 'implementation' no
// cierra con cero hijos (`all-children-status` es false a propósito) y `claimDevStory`
// no reparte de un conjunto vacío—, así que el ciclo respondía `wait` para siempre. Se
// vio en un cliente real el 2026-08-14. El razonamiento entero vive en
// scripts/lib/method_outputs.js, que es la fuente única.
//
// El wiring per-step se deriva de esa fuente y se aplica AL SEMBRAR (seeds/bmad_seed.js
// vía scripts/importer/wiring.js). Las librerías ya sembradas —producción— no vuelven a
// pasar por el seed, así que el descriptor nuevo hay que escribirlo aquí. Va hardcodeado
// a propósito, igual que en 20260808000018: es un backfill de datos, y leerlo del módulo
// lo haría cambiar solo el día que la fuente cambie, que es justo lo que una migración no
// debe hacer.

const OUTPUTS_NEW = [
  { kind: 'artifact', doc_type: 'epics' },
  { kind: 'backlog_items', required_for_close: true },
];
const OUTPUTS_OLD = [
  { kind: 'artifact', doc_type: 'epics' },
  { kind: 'backlog_items' },
];

// El paso terminal es el de mayor step_order, igual que en el wiring del seed
// (outputsByIndex marca el último). Se recorre por workflow porque puede haber varias
// librerías sembradas (source_ref distinto) con la misma key.
const recablearTerminal = async (knex, outputs) => {
  const wfs = await knex('workflow_definitions')
    .where({ key: 'bmad-create-epics-and-stories' })
    .select('id');
  let tocados = 0;
  for (const wf of wfs) {
    const terminal = await knex('workflow_steps')
      .where({ workflow_id: wf.id })
      .orderBy('step_order', 'desc')
      .first('id');
    if (!terminal) continue;
    await knex('workflow_steps').where({ id: terminal.id }).update({
      outputs: JSON.stringify(outputs),
      updated_at: knex.fn.now(),
    });
    tocados += 1;
  }
  return tocados;
};

exports.up = async (knex) => {
  await recablearTerminal(knex, OUTPUTS_NEW);
};

exports.down = async (knex) => {
  await recablearTerminal(knex, OUTPUTS_OLD);
};
