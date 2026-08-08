// Revisión adversaria por unidad — 'code_review' en el enum + recableado del paso
// terminal de bmad-dev-story.
//
// `bmad-code-review` está sembrado desde el importador y describe justo lo que hacía
// falta (tres capas en paralelo: Blind Hunter, Edge Case Hunter, Acceptance Auditor),
// pero nunca corría: su routing dice `required: false` y la espina de fase se arma sólo
// con los required. Colgarlo de la espina tampoco servía —se recorre en orden y
// dev-story sólo cierra cuando TODAS las historias están done, así que la revisión
// caería una vez, al final, sobre el lote entero—, así que la revisión entra como
// output del paso terminal de dev-story: por unidad por construcción. El razonamiento
// entero vive en scripts/lib/method_outputs.js, que es la fuente única.
//
// El wiring per-step se deriva de esa fuente y se aplica AL SEMBRAR (seeds/bmad_seed.js
// vía scripts/importer/wiring.js). Las librerías ya sembradas —producción -- no vuelven
// a pasar por el seed, así que el descriptor nuevo hay que escribirlo aquí. Va
// hardcodeado a propósito: es un backfill de datos, y leerlo del módulo lo haría
// cambiar sola el día que la fuente cambie, que es justo lo que una migración no debe
// hacer.

const DOC_TYPES_OLD = ['brief', 'prd', 'architecture', 'epics', 'story_spec', 'retro',
  'readiness', 'sprint_plan', 'spec'];
const DOC_TYPES_NEW = [...DOC_TYPES_OLD, 'code_review'];

const OUTPUTS_NEW = [
  { kind: 'status', value: 'done' },
  {
    kind: 'artifact', doc_type: 'code_review', scope: 'story', required_for_close: true,
  },
];
const OUTPUTS_OLD = [{ kind: 'status', value: 'done' }];

const swapDocTypeCheck = (knex, values) => knex.raw(`
  ALTER TABLE semantic_documents DROP CONSTRAINT IF EXISTS semantic_documents_doc_type_check;
  ALTER TABLE semantic_documents ADD CONSTRAINT semantic_documents_doc_type_check
    CHECK (doc_type IN (${values.map((v) => `'${v}'`).join(', ')}));
`);

// El paso terminal es el de mayor step_order, igual que en el wiring del seed
// (outputsByIndex marca el último). Se recorre por workflow porque puede haber varias
// librerías sembradas (source_ref distinto) con la misma key.
const recablearTerminal = async (knex, outputs) => {
  const wfs = await knex('workflow_definitions').where({ key: 'bmad-dev-story' }).select('id');
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
  if (knex.client.config.client === 'pg') {
    await swapDocTypeCheck(knex, DOC_TYPES_NEW);
  }
  await recablearTerminal(knex, OUTPUTS_NEW);
};

exports.down = async (knex) => {
  await recablearTerminal(knex, OUTPUTS_OLD);
  if (knex.client.config.client === 'pg') {
    // doc_type es nullable, así que las revisiones ya escritas sobreviven al CHECK
    // estrecho como filas sin tipo en vez de romper la reversión.
    await knex('semantic_documents').where({ doc_type: 'code_review' }).update({ doc_type: null });
    await swapDocTypeCheck(knex, DOC_TYPES_OLD);
  }
};
