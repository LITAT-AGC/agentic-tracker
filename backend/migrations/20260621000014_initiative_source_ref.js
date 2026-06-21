// F3-T1.5 — Scoping de librería de método por iniciativa.
// toy y bmad coexisten en workflow_definitions (tabla GLOBAL) compartiendo
// phase+track; seleccionar workflows por fase es ambiguo. `source_ref` apunta a
// la librería que la iniciativa usa ('bmad:v6.8.0' | 'fixture:f1-toy'), igual que
// la convención source_ref ya usada en workflow_definitions/entities. El resolver
// filtra workflow_definitions.source_ref = initiatives.source_ref.
// Nullable: iniciativas legacy sin librería seleccionada → el resolver no filtra.

exports.up = (knex) =>
  knex.schema.alterTable('initiatives', (t) => {
    t.string('source_ref').index();
  });

exports.down = (knex) =>
  knex.schema.alterTable('initiatives', (t) => {
    t.dropColumn('source_ref');
  });
