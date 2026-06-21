// F1 (corrección de esquema F0) — agregar 'brief' al enum doc_type de semantic_documents.
// Motivo: el lifecycle de 4 fases necesita un artefacto tipado para `analysis`
// (Product Brief en BMAD); el enum original (prd|architecture|epics|story_spec|retro)
// no lo cubría. doc_type sigue nullable (NULL pasa el CHECK por semántica SQL).

const DOC_TYPES_OLD = ['prd', 'architecture', 'epics', 'story_spec', 'retro'];
const DOC_TYPES_NEW = ['brief', 'prd', 'architecture', 'epics', 'story_spec', 'retro'];

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
    // Limpiar filas 'brief' antes de restaurar el constraint estrecho (doc_type es nullable).
    await knex('semantic_documents').where({ doc_type: 'brief' }).update({ doc_type: null });
    await swapDocTypeCheck(knex, DOC_TYPES_OLD);
  }
};
