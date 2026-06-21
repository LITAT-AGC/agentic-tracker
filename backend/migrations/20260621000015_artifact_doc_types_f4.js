// F4-T1 — agregar 'readiness' y 'sprint_plan' al enum doc_type de semantic_documents.
// Motivo: el modelo de completitud (Opción-A: existe-el-output) no expresa los
// workflows de proceso/validación de implementation/solutioning si no producen un
// artefacto re-chequeable. Decisión del operador (F4): modelarlos como productores
// de doc tipado, igual que brief/prd/architecture/epics — fiel a BMAD, que escribe
// readiness report / sprint status / story spec como documentos .md.
//   · check-implementation-readiness → 'readiness'
//   · bmad-sprint-planning          → 'sprint_plan'
//   · bmad-create-story             → 'story_spec' (ya en el enum)
// Aditiva; doc_type sigue nullable (NULL pasa el CHECK por semántica SQL).

const DOC_TYPES_OLD = ['brief', 'prd', 'architecture', 'epics', 'story_spec', 'retro'];
const DOC_TYPES_NEW = ['brief', 'prd', 'architecture', 'epics', 'story_spec', 'retro',
  'readiness', 'sprint_plan'];

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
    // Limpiar filas de los nuevos doc_types antes de restaurar el constraint estrecho.
    await knex('semantic_documents').whereIn('doc_type', ['readiness', 'sprint_plan']).update({ doc_type: null });
    await swapDocTypeCheck(knex, DOC_TYPES_OLD);
  }
};
