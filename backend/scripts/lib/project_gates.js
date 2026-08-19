// Las compuertas de un proyecto: los comandos que su gente declaro, y la evidencia que el
// paso terminal exige antes de dejar cerrar una unidad.
//
// El 2026-08-19 una unidad del cliente "tickets" (US-KAN-02) cerro con `npm run lint` en
// rojo: tres errores en un fichero que la propia corrida acababa de crear. El agente no
// corrio el lint ni una vez en 561 turnos —cinco veces en la unidad anterior, cero en
// esta— y su documento de revision enumera lo que si comprobo (tests, build, e2e) sin
// mencionarlo. No mintio: se lo salto, y nada se lo pidio.
//
// Es exactamente el tercer escalon del ESTADO: una regla **verificable**. El servidor no
// alcanza al arbol de procesos del cliente, asi que no puede correr el lint ni verlo
// correr; lo unico que puede hacer es **exigir evidencia en vez de creerse la promesa**.
// Y a diferencia de la forma de la revision adversaria —que se cuenta y no se rechaza
// porque acoplaria el motor al vocabulario de una plantilla OPCIONAL—, aqui no hay
// acoplamiento posible: los comandos no los pone el motor ni un prompt descargable, los
// declaro el proyecto en sus propias `project_constraints`. Un proyecto que no declara
// ninguna compuerta no ve ninguna exigencia nueva, que es la propiedad que hace que esto
// se pueda estrenar sin plantar el ciclo de nadie.
//
// La evidencia es el codigo de salida y no un booleano a proposito. `passed: true` es una
// opinion y se puede escribir sin haber hecho nada; `exit_code` nombra una observacion
// concreta que el agente tuvo que ir a buscar. No lo hace infalsificable —nada lo hace,
// el servidor no esta ahi—, pero mueve la unica salida que le queda al agente de
// «omitirlo en silencio» a «declarar un cero que no vio», que es una linea que se cruza a
// sabiendas y que ademas queda contada como desviacion.

const PREFIJO_CONFIG = 'project_constraints:';

const objetoJsonOVacio = (valor) => {
  if (typeof valor !== 'string') return {};
  try {
    const parsed = JSON.parse(valor);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch (_) {
    return {};
  }
};

// Las constraints viven en DOS sitios y se mezclan siempre en el mismo orden: lo que
// hay en `projects.description` es el fondo, y la clave de `config` lo pisa —ahi escribe
// `set_project_constraints`, y un null explicito suyo tiene que poder borrar—.
//
// Esta lectura esta aqui y no en `index.js` porque ahora tiene dos clientes: la
// operacion `get_project_constraints`, que la publica, y el motor de metodo, que la usa
// para saber que exigir. Una copia en cada sitio se habria separado a la primera, y el
// dia que se separara la compuerta empezaria a pedir un comando que el proyecto ya no
// declara —o peor, a no pedir el que si—.
const leerConstraintsCrudas = async (conn, projectUrl) => {
  const proyecto = await conn('projects').where({ url: projectUrl }).first();
  if (!proyecto) return null;

  const hayConfig = await conn.schema.hasTable('config');
  const fila = hayConfig
    ? await conn('config').where({ key: `${PREFIJO_CONFIG}${projectUrl}` }).first()
    : null;

  return {
    ...objetoJsonOVacio(proyecto.description),
    ...objetoJsonOVacio(fila && fila.value),
  };
};

// Las tres que un proyecto puede declarar hoy. Se deriva del mismo mapa que publica
// `set_project_constraints`: si maniana aparece una cuarta constraint que sea un comando,
// se aniade aqui y la compuerta la exige sola.
const COMPUERTAS = [
  { clave: 'lint', campo: 'lint_command' },
  { clave: 'test', campo: 'test_command' },
  { clave: 'typecheck', campo: 'typecheck_command' },
];

const compuertasDeclaradas = (constraints) => {
  const c = constraints && typeof constraints === 'object' ? constraints : {};
  return COMPUERTAS
    .map(({ clave, campo }) => ({ clave, comando: typeof c[campo] === 'string' ? c[campo].trim() : '' }))
    .filter(({ comando }) => comando.length > 0);
};

// Pura, y separada de la lectura para que se pueda probar sin base: dado lo que el
// proyecto declara y lo que el agente entrega, dice que falta y que esta en rojo.
//
// `faltan` y `fallan` se devuelven por separado porque son dos fallos distintos y el
// mensaje tiene que decir cual es: uno se arregla corriendo el comando, el otro
// arreglando el codigo. Confundirlos manda al agente a corregir lo que no esta roto.
const revisarCompuertas = (declaradas, entregado) => {
  const dado = entregado && typeof entregado === 'object' && !Array.isArray(entregado)
    ? entregado
    : {};
  const faltan = [];
  const fallan = [];

  for (const { clave, comando } of declaradas) {
    const prueba = dado[clave];
    if (!prueba || typeof prueba !== 'object' || Array.isArray(prueba)) {
      faltan.push({ clave, comando, porque: 'sin evidencia' });
      continue;
    }
    // Se acepta el numero y la cadena de un numero: un `exit_code` leido de la salida de
    // un shell llega de las dos formas segun por donde pase, y rechazar "0" por venir
    // entrecomillado seria rechazar la verdad por la puntuacion.
    const codigo = typeof prueba.exit_code === 'string' && /^-?\d+$/.test(prueba.exit_code.trim())
      ? Number(prueba.exit_code.trim())
      : prueba.exit_code;
    if (!Number.isInteger(codigo)) {
      faltan.push({ clave, comando, porque: 'sin exit_code entero' });
      continue;
    }
    if (codigo !== 0) fallan.push({ clave, comando, exit_code: codigo });
  }

  return { faltan, fallan };
};

// El mensaje del rechazo. Nombra los comandos LITERALES del proyecto y la forma exacta de
// la respuesta, porque el agente que lo recibe no tiene otra cosa: si el `why` no le dice
// que mandar, el rechazo no es una compuerta sino una pared, y una unidad que no cierra
// para el ciclo entero.
const porQueRechaza = (stepKey, { faltan, fallan }) => {
  const partes = [];
  if (fallan.length) {
    partes.push(
      `estas compuertas del proyecto estan en rojo: ${
        fallan.map((f) => `${f.clave} (${f.comando}) salio con ${f.exit_code}`).join('; ')
      }. Arreglalo y volve a correrlas antes de cerrar`,
    );
  }
  if (faltan.length) {
    partes.push(
      `falta la evidencia de: ${faltan.map((f) => `${f.clave} (${f.comando}) — ${f.porque}`).join('; ')}`,
    );
  }
  const ejemplo = [...fallan, ...faltan]
    .map((g) => `"${g.clave}": { "command": "${g.comando}", "exit_code": 0 }`)
    .join(', ');
  return `el paso '${stepKey}' no cierra la unidad sin acreditar las compuertas que el proyecto `
    + `declara en project_constraints: ${partes.join('. ')}. `
    + `Corre cada comando de verdad y manda su codigo de salida en output.gates, asi: `
    + `{ ${ejemplo} }. Si alguna no puede pasar, no cierres la unidad: reporta el bloqueo y detenete`;
};

module.exports = {
  PREFIJO_CONFIG,
  COMPUERTAS,
  objetoJsonOVacio,
  leerConstraintsCrudas,
  compuertasDeclaradas,
  revisarCompuertas,
  porQueRechaza,
};
