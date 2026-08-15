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

const LOOP_CONDUCTOR_INVOCATION_BY_RUNTIME = {
  claudecode: {
    agent_cmd: 'claude -p "$(cat {prompt_file})" --model {model} --permission-mode acceptEdits',
    // En Windows `shell: true` resuelve a `cmd.exe`, donde `$(cat ...)` no existe.
    agent_cmd_windows: 'type {prompt_file} | claude -p --model {model} --permission-mode acceptEdits',
    model_escalation_example: 'claude-sonnet-5,claude-opus-5'
  },
  opencode: {
    // `-f` adjunta el archivo, asi que el prompt nunca pasa por la linea de shell y
    // esta forma vale igual en Windows: no necesita variante.
    agent_cmd: 'opencode run -m {model} -f {prompt_file} "Implementa la unidad descrita en el archivo adjunto"',
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
