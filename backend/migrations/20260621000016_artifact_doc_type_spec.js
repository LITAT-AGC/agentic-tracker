// F5-1 — agregar 'spec' al enum doc_type de semantic_documents.
// Motivo: el bootstrap conducible desde cliente (create_initiative) guarda la spec
// del proyecto como artefacto tipado ligado a la iniciativa — el server no tiene
// acceso al FS del repo cliente. Decisión #3 del ledger F5-0 (firmada 2026-06-21):
// la spec entra como semantic_documents recuperable por doc_type; el primer step
// generativo (product-brief) la consumirá como `need` (cableado en F5-3; hoy ese
// step trae needs[] vacío). Aditiva; doc_type sigue nullable (NULL pasa el CHECK).

const DOC_TYPES_OLD = ['brief', 'prd', 'architecture', 'epics', 'story_spec', 'retro',
  'readiness', 'sprint_plan'];
const DOC_TYPES_NEW = [...DOC_TYPES_OLD, 'spec'];

const swapDocTypeCheck = (knex, values) => knex.raw(`
  ALTER TABLE semantic_documents DROP CONSTRAINT IF EXISTS semantic_documents_doc_type_check;
  ALTER TABLE semantic_documents ADD CONSTRAINT semantic_documents_doc_type_check
    CHECK (doc_type IN (${values.map((v) => `'${v}'`).join(', ')}));
`);

exports.up = async (knex) => {
  if (knex.client.config.client === 'pg') {
    await swapDocTypeCheck(knex, DOC_TYPES_NEW);
  }
};

exports.down = async (knex) => {
  if (knex.client.config.client === 'pg') {
    // Limpiar filas 'spec' antes de restaurar el constraint estrecho (doc_type es nullable).
    await knex('semantic_documents').where({ doc_type: 'spec' }).update({ doc_type: null });
    await swapDocTypeCheck(knex, DOC_TYPES_OLD);
  }
};
