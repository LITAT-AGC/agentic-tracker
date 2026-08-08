// Ediciones del roster BMAD sin tocar la biblioteca sembrada.
//
// `entities` es la biblioteca global del metodo y la siembra `bmad_seed.js` con
// `onConflict('key').merge()` desde el corpus: cualquier edicion escrita ahi la deshace
// el proximo `npm run seed:method`, en silencio y sin aviso. Por eso las ediciones no
// viven en `entities` sino aqui, en una tabla que el seed no mira.
//
// `scope_project_url` es la clave del diseno: '*' significa global —el valor que ve todo
// proyecto que no diga otra cosa— y una URL de proyecto significa solo ese. Se mezclan en
// ese orden, corpus -> '*' -> proyecto, y un campo nulo hereda del anterior en vez de
// borrarlo, que es lo que permite pisar solo la instruccion sin tener que copiar la
// persona entera. No es FK contra `projects` a proposito: '*' no es un proyecto.

exports.up = async (knex) => {
  await knex.schema.createTable('entity_overrides', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.string('scope_project_url').notNullable().defaultTo('*');
    t.string('entity_key').notNullable();
    t.string('name');
    t.text('persona');
    t.text('principles');
    t.text('communication_style');
    t.text('instruction');
    t.timestamps(true, true);
    t.unique(['scope_project_url', 'entity_key']);
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('entity_overrides');
};
