// Comprueba la fuente unica de las lineas `--agent-cmd` del conductor y el auto-chequeo
// que la ata al README.
//
// No necesita servidor ni base de datos: la constante y el chequeo viven en
// `scripts/lib/loop_conductor_invocations.js` justamente para eso. El README de mentira
// se escribe en un directorio temporal; el de verdad se comprueba en su sitio, que es la
// unica forma de que este test detecte la separacion real.

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  LOOP_CONDUCTOR_INVOCATION_BY_RUNTIME,
  checkLoopConductorInvocations,
  defaultReadmePath
} = require('./lib/loop_conductor_invocations');

let pasadas = 0;
const comprobar = (descripcion, fn) => {
  try {
    fn();
    pasadas += 1;
    console.log(`  ok  ${descripcion}`);
  } catch (error) {
    console.error(`  FALLO  ${descripcion}`);
    console.error(`         ${error.message}`);
    process.exitCode = 1;
  }
};

const fallaCon = async (codigo, fn) => {
  try {
    await fn();
  } catch (error) {
    return error?.code === codigo
      ? error
      : (() => { throw new Error(`esperaba ${codigo} y llego ${error?.code || error?.message}`); })();
  }
  throw new Error(`esperaba que fallara con ${codigo} y no fallo`);
};

const main = async () => {
  console.log('Fuente unica de la invocacion del conductor\n');

  // --- La forma de la constante ---------------------------------------------
  const runtimes = Object.keys(LOOP_CONDUCTOR_INVOCATION_BY_RUNTIME);

  comprobar('publica exactamente los dos runtimes soportados', () => {
    assert.deepEqual(runtimes.sort(), ['claudecode', 'opencode']);
  });

  for (const [runtime, invocacion] of Object.entries(LOOP_CONDUCTOR_INVOCATION_BY_RUNTIME)) {
    comprobar(`${runtime}: el comando lleva {prompt_file} y {model}`, () => {
      assert.ok(invocacion.agent_cmd.includes('{prompt_file}'), 'sin {prompt_file} el conductor no arranca');
      // Si hay escalera de modelo configurada, el conductor EXIGE {model} en el comando.
      // Publicar una escalera de ejemplo junto a un comando sin {model} seria publicar
      // una pareja que el propio conductor rechaza.
      assert.ok(invocacion.agent_cmd.includes('{model}'), 'sin {model} la escalera publicada no serviria');
    });

    comprobar(`${runtime}: la escalera de ejemplo son dos modelos separados por coma`, () => {
      const escalones = String(invocacion.model_escalation_example).split(',');
      assert.equal(escalones.length, 2);
      assert.ok(escalones.every((escalon) => escalon.trim().length > 0));
    });
  }

  comprobar('la escalera de opencode lleva proveedor/modelo y la de Claude Code no', () => {
    // Los nombres son de la CLI, no de APTS. Confundirlos es el error que el manual
    // documenta y el conductor no puede detectar: sustituye {model} sin validar.
    assert.ok(LOOP_CONDUCTOR_INVOCATION_BY_RUNTIME.opencode.model_escalation_example.includes('/'));
    assert.ok(!LOOP_CONDUCTOR_INVOCATION_BY_RUNTIME.claudecode.model_escalation_example.includes('/'));
  });

  comprobar('solo Claude Code declara variante de Windows', () => {
    // La via de opencode adjunta el prompt con -f, asi que nunca pasa por cmd.exe.
    assert.equal(typeof LOOP_CONDUCTOR_INVOCATION_BY_RUNTIME.claudecode.agent_cmd_windows, 'string');
    assert.equal(LOOP_CONDUCTOR_INVOCATION_BY_RUNTIME.opencode.agent_cmd_windows, undefined);
  });

  comprobar('la variante de Windows no usa $(cat ...) y conserva el modo de permisos', () => {
    const enWindows = LOOP_CONDUCTOR_INVOCATION_BY_RUNTIME.claudecode.agent_cmd_windows;
    assert.ok(!enWindows.includes('$(cat'), 'cmd.exe no expande $(...)');
    // Sin esto la CLI pide permiso y una corrida desatendida se planta esperando.
    assert.ok(enWindows.includes('--permission-mode acceptEdits'));
  });

  // --- El auto-chequeo contra el README de verdad -----------------------------
  const real = await checkLoopConductorInvocations();

  comprobar('el README del conductor contiene las cinco lineas publicadas', () => {
    assert.equal(real.runtimes, 2);
    assert.equal(real.invocations, 5); // 3 de claudecode + 2 de opencode
  });

  // --- La tercera copia: el README del repositorio ----------------------------
  //
  // El README raiz vuelve a escribir estos comandos para quien clona APTS. NO entra en el
  // auto-chequeo del arranque a proposito —no se sirve a ningun cliente, y que el servidor
  // se niegue a arrancar por una doc interna seria un radio equivocado—, pero se ata aqui,
  // que es donde una separacion se ve antes de que llegue a nadie.
  const readmeRepo = await fs.readFile(
    path.join(__dirname, '..', '..', 'README.md'),
    'utf8'
  );

  for (const [runtime, invocacion] of Object.entries(LOOP_CONDUCTOR_INVOCATION_BY_RUNTIME)) {
    comprobar(`${runtime}: el README del repositorio dice lo mismo que la constante`, () => {
      for (const [campo, valor] of Object.entries(invocacion)) {
        if (typeof valor !== 'string' || !valor) continue;
        assert.ok(readmeRepo.includes(valor), `falta ${campo}: ${valor}`);
      }
    });
  }

  // --- El auto-chequeo detectando la separacion -------------------------------
  const temporal = await fs.mkdtemp(path.join(os.tmpdir(), 'apts-conductor-'));
  const readmeReal = await fs.readFile(defaultReadmePath, 'utf8');

  const readmeMutilado = path.join(temporal, 'README-sin-opencode.md');
  await fs.writeFile(
    readmeMutilado,
    readmeReal.replace(LOOP_CONDUCTOR_INVOCATION_BY_RUNTIME.opencode.agent_cmd, 'opencode run {prompt_file}'),
    'utf8'
  );

  const separacion = await fallaCon('LOOP_CONDUCTOR_DRIFT', () =>
    checkLoopConductorInvocations({ readmePath: readmeMutilado }));

  comprobar('un comando editado en el README y no en la constante aborta, y se nombra', () => {
    assert.equal(separacion.details.length, 1);
    assert.equal(separacion.details[0].runtime, 'opencode');
    assert.equal(separacion.details[0].field, 'agent_cmd');
  });

  // La comprobacion es literal a proposito: `--model` y `--modelo` no son lo mismo, y
  // una separacion real empieza casi siempre por un caracter.
  const claudeCmd = LOOP_CONDUCTOR_INVOCATION_BY_RUNTIME.claudecode.agent_cmd;
  const readmeCasiIgual = path.join(temporal, 'README-casi.md');
  await fs.writeFile(
    readmeCasiIgual,
    readmeReal.split(claudeCmd).join(claudeCmd.replace('--model ', '--modelo ')),
    'utf8'
  );

  const casi = await fallaCon('LOOP_CONDUCTOR_DRIFT', () =>
    checkLoopConductorInvocations({ readmePath: readmeCasiIgual }));

  comprobar('un cambio de un solo caracter tambien lo detecta', () => {
    assert.equal(casi.details.length, 1);
    assert.equal(casi.details[0].runtime, 'claudecode');
    assert.equal(casi.details[0].field, 'agent_cmd');
    // El error lleva el valor que se esperaba, que es lo que hace accionable el aborto.
    assert.equal(casi.details[0].value, claudeCmd);
  });

  const ilegible = await fallaCon('LOOP_CONDUCTOR_README_UNREADABLE', () =>
    checkLoopConductorInvocations({ readmePath: path.join(temporal, 'no-existe.md') }));

  comprobar('un README ilegible aborta con su propio codigo, no con el de separacion', () => {
    assert.ok(ilegible.details[0].path.endsWith('no-existe.md'));
  });

  await fs.rm(temporal, { recursive: true, force: true });

  console.log(`\n${pasadas} comprobaciones en verde.`);
  if (process.exitCode) console.error('Hay fallos.');
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
