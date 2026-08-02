// Resuelve la conexión de un seed por entorno, SIN hardcodear `.test`.
//
// Dos clases de seed con políticas distintas:
//   - methodSeedKnex  → seed del MÉTODO (los 6 agentes BMAD + workflows). Va a
//     donde apunte el `.env` de esta máquina. Resuelve por NODE_ENV.
//   - fixtureSeedKnex → fixtures de PRUEBA (toy, demo url-shortener). NUNCA deben
//     tocar la base principal: se bloquean con NODE_ENV=production y siempre van
//     al destino de prueba.
//
// La regla de «la base de prueba exige su propia variable» ya NO se comprueba aquí:
// vive en `knexfile.js`, que es quien resuelve la cadena y falla con nombre si
// falta `PG_TEST_CONNECTION_STRING`. Estaba escrita en los dos sitios.
require('dotenv').config();

const resolveEnv = () => process.env.NODE_ENV || 'development';

// Seed de producción (método). Entorno = override explícito (arg CLI) || NODE_ENV.
// El override hace el deploy inequívoco y cross-platform (Windows/npm no propaga
// `NODE_ENV=x` inline de forma fiable):  node seeds/bmad_seed.js production
function methodSeedKnex(label = 'seed', envOverride) {
  const env = envOverride || resolveEnv();
  const config = require('../../knexfile')[env];
  if (!config) {
    throw new Error(`${label}: no existe configuración knex para entorno='${env}'.`);
  }
  return require('knex')(config);
}

// Fixtures de prueba: jamás en producción, y siempre contra la DB de test dedicada.
function fixtureSeedKnex(label = 'fixture') {
  if (resolveEnv() === 'production') {
    throw new Error(
      `${label}: fixture de prueba BLOQUEADA con NODE_ENV=production. No se siembran datos de prueba en producción.`
    );
  }
  return require('knex')(require('../../knexfile').test);
}

module.exports = { methodSeedKnex, fixtureSeedKnex, resolveEnv };
