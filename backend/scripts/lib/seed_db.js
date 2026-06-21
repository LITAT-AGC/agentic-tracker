// Resuelve la conexión de un seed por entorno, SIN hardcodear `.test`.
//
// Dos clases de seed con políticas distintas:
//   - methodSeedKnex  → seed del MÉTODO (los 6 agentes BMAD + workflows). Va a
//     cualquier entorno, incluido producción. Resuelve por NODE_ENV.
//   - fixtureSeedKnex → fixtures de PRUEBA (toy, demo url-shortener). NUNCA deben
//     tocar producción: doble guarda (bloquea NODE_ENV=production y exige una DB
//     de test dedicada para no caer por fallback a la DB principal).

// Carga .env antes de leer process.env (las guardas dependen de PG_TEST_CONNECTION_STRING,
// que vive en .env; knexfile también hace esto, pero aquí se valida ANTES de requerirlo).
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
  if (!process.env.PG_TEST_CONNECTION_STRING) {
    throw new Error(
      `${label}: falta PG_TEST_CONNECTION_STRING. Las fixtures exigen una DB de test dedicada ` +
        `para no caer por fallback a la DB principal (PG_CONNECTION_STRING / DATABASE_URL).`
    );
  }
  return require('knex')(require('../../knexfile').test);
}

module.exports = { methodSeedKnex, fixtureSeedKnex, resolveEnv };
