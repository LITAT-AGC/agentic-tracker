// `journal` como tipo de accion de `agent_logs`.
//
// El conductor lleva un diario JSONL local con cada decision que toma —reintentos de red,
// paradas, cambios de estado— y ese diario vivia solo en el disco de quien lo corria. Lo
// que APTS guardaba de una ejecucion desatendida eran las transiciones de la tarea; el
// porque de cada una, no.
//
// Se reusa `agent_logs` en vez de abrir tabla propia: el panel ya lee esa tabla, ya la
// filtra por `action_type` y el filtro se arma solo con los valores presentes. Lo unico
// que hacia falta era que la columna aceptara el valor nuevo, y es un CHECK, no un enum
// nativo de Postgres, asi que se reescribe (mismo camino que la migracion 005 con
// `backlog_items.status`).

const ACCIONES = ['read', 'write', 'update', 'error', 'heartbeat', 'journal'];
const ACCIONES_PREVIAS = ['read', 'write', 'update', 'error', 'heartbeat'];

const lista = (valores) => valores.map((valor) => `'${valor}'`).join(', ');

exports.up = async (knex) => {
  if (knex.client.config.client !== 'pg') return;

  await knex.raw('ALTER TABLE agent_logs DROP CONSTRAINT IF EXISTS agent_logs_action_type_check');
  await knex.raw('ALTER TABLE agent_logs ALTER COLUMN action_type TYPE text');
  await knex.raw(
    `ALTER TABLE agent_logs ADD CONSTRAINT agent_logs_action_type_check CHECK (action_type IN (${lista(ACCIONES)}))`
  );
};

exports.down = async (knex) => {
  if (knex.client.config.client !== 'pg') return;

  // Las filas del diario no se borran: pierden el matiz y se quedan como lo que son, una
  // actualizacion. Borrarlas seria perder el rastro de una ejecucion por deshacer un CHECK.
  await knex('agent_logs').where({ action_type: 'journal' }).update({ action_type: 'update' });
  await knex.raw('ALTER TABLE agent_logs DROP CONSTRAINT IF EXISTS agent_logs_action_type_check');
  await knex.raw(
    `ALTER TABLE agent_logs ADD CONSTRAINT agent_logs_action_type_check CHECK (action_type IN (${lista(ACCIONES_PREVIAS)}))`
  );
};
