// Desviaciones del contrato: lo que un agente intenta y no debia.
//
// Vive aparte de `index.js` porque tiene DOS clientes con vistas distintas y ninguno de los
// dos ve lo que ve el otro. La capa HTTP ve todo rechazo de la superficie MCP, con la
// identidad ya resuelta; el motor de metodo ve el contenido de lo que se entrega, que la
// capa HTTP no puede juzgar. Una copia en cada sitio se habria separado a la primera.
//
// Dos clases, y las dos importan:
//   · `rejected` — el servidor dijo que no. Esa se ve sola en cualquier log.
//   · `allowed`  — el agente hizo algo que el contrato le pide que no haga y el servidor no
//                  tiene forma de impedirselo, o no debe. Esta no se veia por ningun lado, y
//                  es la que de verdad contesta si las reglas escritas se estan siguiendo.
//
// Para que sirva de algo tiene que poder AGRUPARSE: la pregunta es «¿que reglas se rompen y
// cuantas veces?», que es un GROUP BY y no una lectura. De ahi que el detalle vaya en campos
// de `technical_details` y no dentro de la frase.
//
//   SELECT technical_details->>'rule', technical_details->>'outcome', count(*)
//     FROM agent_logs WHERE action_type = 'deviation'
//    GROUP BY 1, 2 ORDER BY 3 DESC;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Solo el 4xx del CLIENTE cuenta como desviacion. Se dejan fuera a proposito:
//   · 5xx      — culpa del servidor, y ya se registra como `error`;
//   · 401/403  — configuracion o credenciales, no una regla del metodo incomprendida;
//   · 429      — ritmo, tampoco una regla.
const esRechazoDeContrato = (status) => Number.isInteger(status)
  && status >= 400 && status < 500
  && ![401, 403, 429].includes(status);

// `conn` es knex o una transaccion. Con transaccion, la observacion vive y muere con la
// operacion que la produjo, que es lo correcto: una desviacion que se revirtio no ocurrio.
//
// Best-effort de verdad. Esto es instrumentacion, y una instrumentacion capaz de tumbar la
// operacion que observa no vale nada: nunca lanza.
const registrarDesviacion = (conn, {
  operacion, carga, error, identidad, regla, resultado = 'rejected', taskId,
}) => {
  try {
    const status = (error && error.statusCode) || null;
    // El rechazo se filtra por codigo; lo permitido no tiene codigo que filtrar, y por eso
    // no pasa por aqui: quien lo registra ya decidio que era una desviacion.
    if (resultado === 'rejected' && !esRechazoDeContrato(status)) return Promise.resolve();

    const agente = (identidad && identidad.agent_name) || (carga && carga.agent_name) || null;
    const proyecto = (identidad && identidad.project_url)
      || (carga && (carga.project_url || carga.url)) || null;
    const tarea = taskId || (UUID.test(String((carga && carga.task_id) || '')) ? carga.task_id : null);

    return conn('agent_logs').insert({
      task_id: tarea,
      action_type: 'deviation',
      agent_name: agente,
      message: `${regla || operacion}: ${String((error && error.message) || resultado).slice(0, 500)}`,
      technical_details: JSON.stringify({
        rule: regla || operacion || null,
        outcome: resultado,
        operation: operacion || null,
        status,
        code: (error && error.code) || null,
        project_url: proyecto,
        // La carga NO se guarda entera: trae texto de trabajo del agente y podria traer
        // secretos. Solo las claves, que es lo que sirve para reconocer el patron.
        argument_keys: carga && typeof carga === 'object' ? Object.keys(carga).sort() : [],
      }),
    }).catch(() => { /* la instrumentacion no puede hacer ruido */ });
  } catch (_) {
    return Promise.resolve();
  }
};

module.exports = { registrarDesviacion, esRechazoDeContrato };
