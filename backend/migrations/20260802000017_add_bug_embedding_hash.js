// El vector de dedupe se regeneraba en cada escritura del item, tocara o no el
// texto que se embebe. El camino hermano —el documento de cobertura— ya no lo
// hacia: guarda `generated_from_hash` junto al vector y compara antes de llamar.
// Esta columna es lo que le faltaba a `backlog_items` para poder hacer lo mismo.
//
// Se deja nula en las filas existentes a proposito: un hash desconocido no
// coincide con ninguno, asi que el primer paso por cada bug vuelve a embeber una
// vez —lo que ya ocurria siempre— y a partir de ahi corta.
exports.up = async (knex) => {
  await knex.schema.alterTable('backlog_items', (t) => {
    t.string('bug_embedding_hash');
  });
};

exports.down = async (knex) => {
  await knex.schema.alterTable('backlog_items', (t) => {
    t.dropColumn('bug_embedding_hash');
  });
};
