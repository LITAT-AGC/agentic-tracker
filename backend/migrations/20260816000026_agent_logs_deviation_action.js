// `rejected` como tipo de accion de `agent_logs`: cada vez que el contrato le dice que no
// a un agente.
//
// Hasta ahora, cuando un agente intentaba algo que la superficie no permite, el rechazo
// vivia en el log de la aplicacion —rotado, sin consultar y sin agrupar— y en el mejor de
// los casos en el diario JSONL del conductor, en el disco de quien lo corriera. Es decir:
// la pregunta «¿que reglas estan intentando romper los agentes, y cuantas veces?» no se
// podia contestar, y las que se arreglaban salian de que un humano estuviera mirando un
// log en el momento justo. Asi se encontro la del 2026-08-16 —un agente cerrando la tarea
// que el conductor le presto— y no hay ninguna razon para creer que fuera la unica.
//
// El valor de esto no es el registro: es la LISTA. Con las filas en la tabla,
//
//   SELECT technical_details->>'rule', technical_details->>'outcome', count(*)
//     FROM agent_logs WHERE action_type = 'deviation'
//    GROUP BY 1, 2 ORDER BY 3 DESC;
//
// contesta la pregunta, y las reglas que hay que convertir en muro se priorizan con datos
// en vez de con anecdotas.
//
// `deviation` y no `rejected` porque hay DOS clases y las dos importan:
//   · `outcome: 'rejected'` — el servidor dijo que no. Esa se ve sola.
//   · `outcome: 'allowed'`  — el agente hizo algo que el contrato le pide que no haga y el
//                             servidor no tiene forma de impedirselo. Esta no se veia por
//                             ningun lado, y es la que mas dice sobre si las reglas
//                             escritas se estan siguiendo.
// Nombrar la columna por el rechazo habria dejado la segunda sin sitio, que es justo la
// mitad que hacia falta empezar a mirar.
//
// Se reusa `agent_logs` en vez de abrir tabla propia, por lo mismo que la migracion 022:
// el panel ya lee esa tabla y arma su filtro con los valores presentes. Y por lo mismo se
// reescribe el CHECK, que no es un enum nativo.

const ACCIONES = ['read', 'write', 'update', 'error', 'heartbeat', 'journal', 'deviation'];
const ACCIONES_PREVIAS = ['read', 'write', 'update', 'error', 'heartbeat', 'journal'];

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

  // Las filas se BORRAN, al reves que en la migracion 022. Alli el matiz se perdia y la
  // fila seguia siendo una actualizacion de verdad; aqui no: un rechazo degradado a
  // `error` se mezclaria con los errores del sistema y ensuciaria justo la consulta que
  // esta tabla viene a permitir. Lo que se pierde son observaciones reproducibles —vuelven
  // solas en cuanto un agente reincida— y no rastro de ninguna ejecucion.
  await knex('agent_logs').where({ action_type: 'deviation' }).del();
  await knex.raw('ALTER TABLE agent_logs DROP CONSTRAINT IF EXISTS agent_logs_action_type_check');
  await knex.raw(
    `ALTER TABLE agent_logs ADD CONSTRAINT agent_logs_action_type_check CHECK (action_type IN (${lista(ACCIONES_PREVIAS)}))`
  );
};
