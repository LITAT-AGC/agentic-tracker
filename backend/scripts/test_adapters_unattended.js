// Comprueba el cierre del cuelgue por permiso de subagente en opencode: el conductor se
// anuncia en el entorno y el plugin del adaptador aplana lo que quedaria en `ask`.
//
// No necesita servidor ni base de datos. Lo que se comprueba es un CONTRATO entre dos
// artefactos descargables que no pueden importarse el uno al otro —el conductor es un
// CommonJS suelto y el generador un ESM del paquete—, asi que el nombre de la marca esta
// escrito dos veces y el unico sitio donde puede volver a juntarse es aqui. Una copia que
// nadie vigila se separa en silencio: este repositorio ya ha pagado ese fallo tres veces.
//
// Se lee el plugin GENERADO y no el generador: es el archivo que se copia al repositorio
// del cliente y el que de verdad corre.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const raiz = path.join(__dirname, '..', '..');
const conductorPath = path.join(raiz, 'integracion', 'conductor', 'apts-loop.js');
const generadorPath = path.join(raiz, 'integracion', 'paquete-apts', 'scripts', 'generate-adapters.js');
const pluginPath = path.join(
  raiz, 'integracion', 'paquete-apts', 'runtime-adapters', 'opencode', '.opencode', 'plugin', 'apts-env.js',
);
const configPath = path.join(raiz, 'integracion', 'paquete-apts', 'runtime-adapters', 'opencode', 'opencode.json');

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

const MARCA = 'APTS_UNATTENDED';

const main = async () => {
  console.log('Permisos de una corrida desatendida (opencode)\n');

  const conductor = fs.readFileSync(conductorPath, 'utf8');
  const generador = fs.readFileSync(generadorPath, 'utf8');
  const plugin = fs.readFileSync(pluginPath, 'utf8');

  // --- Las dos copias del nombre --------------------------------------------

  comprobar('el conductor declara la marca', () => {
    assert.match(conductor, new RegExp(`MARCA_DESATENDIDA\\s*=\\s*'${MARCA}'`));
  });

  comprobar('el generador declara la misma marca', () => {
    assert.match(generador, new RegExp(`UNATTENDED_ENV\\s*=\\s*'${MARCA}'`));
  });

  comprobar('el plugin generado la lleva dentro', () => {
    assert.match(plugin, new RegExp(`UNATTENDED_ENV = "${MARCA}"`));
  });

  // Lo que hace que la marca sirva de algo: que el conductor la PONGA en el entorno del
  // hijo. Sin esto las tres comprobaciones de arriba pasarian con el nombre bien escrito
  // y sin nadie que lo escriba.
  comprobar('el conductor la mete en el entorno del agente al lanzarlo', () => {
    assert.match(conductor, /env:\s*\{\s*\.\.\.process\.env,\s*\[MARCA_DESATENDIDA\]:\s*'1'\s*\}/);
  });

  // --- El archivo comiteado conserva su `ask` --------------------------------
  //
  // Es la mitad que se defiende sola: si alguien "arregla" esto poniendo `allow` aqui,
  // la sesion interactiva de una persona deja de preguntar y nadie se entera.
  comprobar('el opencode.json generado sigue pidiendo permiso para la shell', () => {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\/\/.*\n/, ''));
    assert.equal(config.permission.bash['*'], 'ask');
  });

  // --- El aplanado ----------------------------------------------------------

  const modulo = await import(pathToFileURL(pluginPath).href);
  const arrancar = async () => modulo.AptsEnv({ directory: __dirname, worktree: __dirname });

  const permisosDeEjemplo = () => ({
    edit: 'allow',
    bash: { 'git push*': 'deny', '*': 'ask' },
    webfetch: 'ask',
    question: 'deny',
  });

  const conMarca = async (valor, permission) => {
    const antes = process.env[MARCA];
    if (valor === null) delete process.env[MARCA];
    else process.env[MARCA] = valor;
    try {
      const plug = await arrancar();
      const config = { permission, mcp: {} };
      await plug.config(config);
      return config.permission;
    } finally {
      if (antes === undefined) delete process.env[MARCA];
      else process.env[MARCA] = antes;
    }
  };

  const sinMarca = await conMarca(null, permisosDeEjemplo());
  comprobar('sin la marca no toca nada: la sesion con persona delante sigue preguntando', () => {
    assert.deepEqual(sinMarca, permisosDeEjemplo());
  });

  const marcada = await conMarca('1', permisosDeEjemplo());
  comprobar('con la marca, `ask` pasa a `allow` en todas sus formas', () => {
    assert.equal(marcada.bash['*'], 'allow');
    assert.equal(marcada.webfetch, 'allow');
  });

  // Lo que separa esto de «desactivar los permisos», que es otra cosa: el `deny` es la
  // UNICA clase de regla que un subagente de opencode si hereda del padre, asi que es el
  // unico freno que le queda a una corrida desatendida. Aplanarlo lo dejaria sin ninguno.
  comprobar('con la marca, `deny` se queda como esta', () => {
    assert.equal(marcada.bash['git push*'], 'deny');
    assert.equal(marcada.question, 'deny');
    assert.equal(marcada.edit, 'allow');
  });

  // --- Los `ask` que opencode trae incorporados -----------------------------
  //
  // No viven en `config.permission`, asi que aplanar lo declarado no los alcanza: costo una
  // tercera corrida el 2026-08-15, con un subagente colgado leyendo un `.env.test`. Se
  // siembran, y tienen que quedar DELANTE de lo que declare el proyecto, porque el evaluador
  // de opencode es `findLast` y lo ultimo gana.
  comprobar('con la marca, se siembran los `ask` incorporados de opencode', () => {
    assert.equal(marcada.read['*.env'], 'allow');
    assert.equal(marcada.read['*.env.*'], 'allow');
    assert.equal(marcada.external_directory['*'], 'allow');
    assert.equal(marcada.doom_loop, 'allow');
  });

  comprobar('y van delante de lo que declara el proyecto, no detras', () => {
    const claves = Object.keys(marcada);
    assert.ok(claves.indexOf('read') < claves.indexOf('bash'),
      `las semillas tienen que preceder a lo declarado: ${claves.join(', ')}`);
  });

  // Lo que hace que sembrar no sea imponer: un proyecto que declara SU regla sobre la misma
  // capacidad tiene que seguir ganando. Sin la fusion por patrones, declarar `read` en el
  // proyecto reemplazaria la semilla entera y devolveria el `.env` a su `ask` sin que nadie
  // lo notara.
  const conReadPropio = await conMarca('1', { read: { '*.env.local': 'deny' } });
  comprobar('un `read` del proyecto se fusiona con la semilla y su deny gana', () => {
    assert.equal(conReadPropio.read['*.env.*'], 'allow');
    assert.equal(conReadPropio.read['*.env.local'], 'deny');
    const patrones = Object.keys(conReadPropio.read);
    assert.ok(patrones.indexOf('*.env.*') < patrones.indexOf('*.env.local'),
      `el patron del proyecto tiene que ir el ultimo: ${patrones.join(', ')}`);
  });

  comprobar('sin la marca no se siembra nada', () => {
    assert.equal(sinMarca.read, undefined);
    assert.equal(sinMarca.doom_loop, undefined);
  });

  const apagada = await conMarca('0', permisosDeEjemplo());
  comprobar('`0` no cuenta como marca puesta', () => {
    assert.equal(apagada.bash['*'], 'ask');
  });

  const vacia = await conMarca('', permisosDeEjemplo());
  comprobar('la cadena vacia tampoco', () => {
    assert.equal(vacia.bash['*'], 'ask');
  });

  // El otro trabajo del mismo gancho no puede haberse roto al meter este: son
  // independientes y comparten funcion. Se resuelve FUERA del comprobador, que es sincrono:
  // pasarle una funcion `async` lo dejaria dando por buena una promesa que nadie espera.
  process.env.APTS_API_KEY = 'clave-de-mentira';
  const conMcp = {
    permission: { bash: { '*': 'ask' } },
    mcp: { apts: { type: 'remote', url: 'https://apts.informaticos.ar/mcp', headers: { Authorization: '{env:APTS_API_KEY}' } } },
  };
  await (await arrancar()).config(conMcp);
  delete process.env.APTS_API_KEY;

  comprobar('el gancho sigue reescribiendo las cabeceras del MCP', () => {
    assert.equal(conMcp.mcp.apts.headers.Authorization, 'Bearer clave-de-mentira');
  });

  console.log(`\n${pasadas} comprobaciones`);
  if (process.exitCode) console.error('\nHay fallos.');
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
