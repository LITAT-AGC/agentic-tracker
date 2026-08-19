// Como se invoca el conductor del bucle, por runtime. FUENTE UNICA.
//
// Estas lineas vivian solo en el README del conductor, que es un artefacto
// descargable, y eso dejaba un agujero: un cliente que leia el manifiesto sabia que
// el conductor existe pero no podia siquiera PREGUNTAR al operador que runtime
// quiere sin bajarse antes el manual. Ahora van como dato en el manifiesto, dentro
// del bloque de registro del mismo runtime, porque son la misma clase de cosa: lo
// que cambia de un programa cliente a otro.
//
// Vive aqui y no en `backend/index.js` para que se pueda comprobar sin levantar el
// servidor, igual que `contract_check.mjs` y `semantic_embeddings.js`. Es CommonJS
// porque `buildMcpRuntimeRegistrations` la necesita al construir el manifiesto, que
// es sincrono.
//
// Los nombres de modelo son de la CLI y no de APTS: el conductor sustituye `{model}`
// como texto opaco, asi que la escalera de opencode lleva `proveedor/modelo` y la de
// Claude Code no. Van como EJEMPLO y no como valor por defecto a proposito: elegir
// modelo es del operador, y esta constante no es quien para decidirlo.
const path = require('node:path');
const fs = require('node:fs/promises');

// Las dos lineas piden a la CLI que hable JSON, y que lo hable MIENTRAS TRABAJA. El
// conductor no lo exige y no lo configura: lee lo que venga. Es lo unico que le permite
// anotar lo que costo cada story —tokens, coste y sesion— en vez de solo su duracion y su
// codigo de salida, porque eso vive dentro de la sesion del agente y desde fuera no se
// puede medir de ninguna otra forma.
//
// `stream-json` y no `json` en Claude Code, desde 2026-08-15. `--output-format json`
// imprime UN objeto al terminar, que sirve para la contabilidad y es inutil para cualquier
// cosa en vivo: la consola se quedaba muda veinte minutos —el propio README lo documentaba
// como precio pagado— y `--session-stream` no tendria nada que enviar. El objeto final
// sigue siendo el mismo `type:"result"`, asi que el lector del coste no cambia. `--verbose`
// no es adorno: en modo `-p`, Claude Code lo exige junto con `stream-json`.
//
// Opencode no cambia: su `--format json` ya es NDJSON, o sea ya era stream.
const LOOP_CONDUCTOR_INVOCATION_BY_RUNTIME = {
  claudecode: {
    // `bypassPermissions` y NO `acceptEdits`, desde 2026-08-18. Las dos lineas publicaron
    // `acceptEdits` durante tres versiones creyendolo el hermano de `--auto` de opencode, y
    // NO LO ES: `acceptEdits` auto-acepta EDICIONES DE ARCHIVO y nada mas. `WebFetch`,
    // `Bash` y `Task` siguen preguntando, y en modo `-p` preguntar es morir —no hay nadie
    // para contestar—. La plantilla de revision publicada empieza leyendo el manifiesto por
    // `WebFetch`, asi que una corrida desatendida se plantaba en su PRIMERA herramienta.
    //
    // Y se plantaba de la peor manera: Claude Code trata la peticion sin respuesta como
    // final normal de la sesion, imprime el «necesito autorizacion» como resultado y sale
    // con codigo 0. El conductor lo lee como turno bueno y para con 14 —el codigo de «todo
    // fue bien»—, de modo que la corrida entera se declara sana sin haber tocado una linea.
    // Solo el contraste contra `apts_status` lo delata. Medido contra Claude Code 2.1.234
    // conduciendo el cliente `tickets` con claude-sonnet-5: dos arranques en falso, 15 y 20
    // segundos, $0,35, backlog inmovil en 17/26.
    //
    // Es peligroso por definicion —aprueba todo, incluido `Bash` arbitrario— y va en la
    // linea publicada por exactamente la misma razon que `--auto` en la de opencode, que ya
    // esta escrita ahi abajo: esta es la linea de una corrida DESATENDIDA. Quien no quiera
    // esa cesion no debe rebajar el modo, sino conducir con la CLI delante.
    agent_cmd: 'claude -p "$(cat {prompt_file})" --model {model} --permission-mode bypassPermissions --output-format stream-json --verbose',
    // En Windows `shell: true` resuelve a `cmd.exe`, donde `$(cat ...)` no existe.
    agent_cmd_windows: 'type {prompt_file} | claude -p --model {model} --permission-mode bypassPermissions --output-format stream-json --verbose',
    model_escalation_example: 'claude-sonnet-5,claude-opus-5'
  },
  opencode: {
    // `-f` adjunta el archivo, asi que el prompt nunca pasa por la linea de shell y
    // esta forma vale igual en Windows: no necesita variante.
    //
    // El MENSAJE VA ANTES DE `-f`, y no es cosmetico: en opencode 1.18.18 `-f/--file` es
    // un flag de tipo array (yargs) y se traga el positional que venga detras, asi que la
    // forma obvia —`-f {prompt_file} "mensaje"`— muere con «Error: File not found:
    // Implementa la unidad descrita en el archivo adjunto» antes de resolver el modelo, y
    // el conductor lo reporta como `agente_fallo` (exit 20), que manda a buscar el fallo
    // en la story. Lo encontro un cliente real el 2026-08-15 y se reprodujo aqui contra la
    // CLI de verdad. `--auto` es boolean, asi que puede ir donde sea.
    //
    // `--auto` es el hermano de `--permission-mode bypassPermissions`: en headless, `opencode
    // run` AUTO-RECHAZA los permisos que su config deja en "ask", de modo que sin el la
    // sesion muere en el primer comando de shell. Es peligroso por definicion —aprueba
    // todo lo que no este explicitamente denegado— y va en la linea publicada por la misma
    // razon que su equivalente de Claude Code: esta linea es la de una corrida DESATENDIDA,
    // y una que se planta esperando una aprobacion que nadie va a dar no sirve de nada.
    //
    // El hermano es `bypassPermissions` y no `acceptEdits`, que es lo que decia aqui hasta
    // el 2026-08-18: la equivalencia estaba bien pensada y mal escrita, y el arreglo esta
    // contado arriba, en el bloque de claudecode.
    //
    // `--print-logs` manda el registro de la CLI a stderr, y no es para leerlo: es lo que hace
    // que el vigilante de silencio del conductor mida ACTIVIDAD y no charla del stream. En
    // opencode los dos no son lo mismo —comprobado contra 1.18.18 leyendo su binario—: el
    // stream `--format json` descarta todo evento cuya sesion no sea la principal y solo emite
    // una herramienta cuando ya termino, asi que el proceso calla durante TODA herramienta
    // larga aunque este trabajando. Una revision adversaria en subagentes, que es justo lo que
    // la plantilla publicada pide, calla de principio a fin. Sin esta bandera el freno de los
    // veinte minutos corta corridas sanas.
    agent_cmd: 'opencode run --format json --print-logs -m {model} --auto "Implementa la unidad descrita en el archivo adjunto" -f {prompt_file}',
    model_escalation_example: 'anthropic/claude-sonnet-5,anthropic/claude-opus-5'
  }
};

const defaultReadmePath = path.join(__dirname, '..', '..', '..', 'integracion', 'conductor', 'README.md');

// El README repite estas lineas porque tiene que poder leerse suelto, y una copia que
// nadie vigila se separa en silencio: este repositorio ya ha pagado ese fallo dos
// veces. Aqui se comprueba que cada linea publicada aparece LITERALMENTE en el README.
//
// La comprobacion es de subcadena y no de estructura a proposito: el README es prosa y
// sus bloques cambian de forma, pero el comando es el comando. Se compara contra el
// archivo del repositorio, que es exactamente el que se sirve como artefacto.
const checkLoopConductorInvocations = async ({ readmePath = defaultReadmePath } = {}) => {
  let readme;
  try {
    readme = await fs.readFile(readmePath, 'utf8');
  } catch (cause) {
    const error = new Error(`Loop conductor README is unreadable at ${readmePath}`);
    error.code = 'LOOP_CONDUCTOR_README_UNREADABLE';
    error.details = [{ path: readmePath, cause: cause?.message || String(cause) }];
    throw error;
  }

  const problems = [];
  let checked = 0;
  for (const [runtime, invocation] of Object.entries(LOOP_CONDUCTOR_INVOCATION_BY_RUNTIME)) {
    for (const [field, value] of Object.entries(invocation)) {
      if (typeof value !== 'string' || !value) continue;
      checked += 1;
      if (!readme.includes(value)) problems.push({ runtime, field, value });
    }
  }

  if (problems.length) {
    const error = new Error('Loop conductor invocations published in the manifest are missing from its README');
    error.code = 'LOOP_CONDUCTOR_DRIFT';
    error.details = problems;
    throw error;
  }

  return {
    runtimes: Object.keys(LOOP_CONDUCTOR_INVOCATION_BY_RUNTIME).length,
    invocations: checked
  };
};

module.exports = {
  LOOP_CONDUCTOR_INVOCATION_BY_RUNTIME,
  checkLoopConductorInvocations,
  defaultReadmePath
};
