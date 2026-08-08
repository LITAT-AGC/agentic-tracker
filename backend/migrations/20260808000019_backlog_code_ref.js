// `code_ref` en backlog_items: el commit que cerro la unidad.
//
// El contrato ya lo pedia y el motor ya lo recibia. `dev_story_completion_rule` manda
// entregar `output: { status: "done", code_ref: "<hash>" }` en el paso terminal, y
// `applySubmit` lo devolvia dentro de `captured[]`... y ahi se acababa: no habia donde
// escribirlo. Un hash que se pide, se transporta y se tira, de modo que APTS no podia
// decir que commit cerro que historia. Lo noto el operador el 2026-08-08 mirando lo poco
// que quedaba de una ejecucion de 34 minutos.
//
// Va en `backlog_items` y no en una tabla de eventos porque el dato es de la unidad y hay
// uno: el submit terminal ocurre una vez por historia. Nullable, porque las historias ya
// cerradas no lo tienen y no se puede inventar.

exports.up = async (knex) => {
  await knex.schema.alterTable('backlog_items', (t) => {
    t.string('code_ref');
  });
};

exports.down = async (knex) => {
  await knex.schema.alterTable('backlog_items', (t) => {
    t.dropColumn('code_ref');
  });
};
