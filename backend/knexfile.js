// Dos destinos, no tres. El `.env` de cada maquina decide donde cae cada uno.
//
// Antes habia tres entornos y dos de ellos —`development` y `production`— resolvian
// exactamente la misma cadena de conexion. El nombre `production` no aportaba nada:
// elegirlo no llevaba a produccion, llevaba a lo que dijera `PG_CONNECTION_STRING`.
// Eso hacia que un comando `--env production` desde una maquina de desarrollo
// escribiera en la base de desarrollo mientras parecia estar desplegando.
//
// Ahora hay una sola configuracion principal. `development` y `production` siguen
// existiendo como nombres del MISMO objeto, porque el servidor arranca con
// `knexConfig[process.env.NODE_ENV]` y varios scripts aceptan `--target-env`: si la
// clave desapareciera, se caerian. Son alias, y lo dicen.
//
// Las dos cadenas se exigen por separado y NINGUNA hereda de la otra:
//   - principal:  PG_CONNECTION_STRING (o DATABASE_URL)
//   - de prueba:  PG_TEST_CONNECTION_STRING, y solo esa
//
// El fallback de test a la principal era la trampa peor de las dos: sin
// PG_TEST_CONNECTION_STRING, todo lo que se creyera «de prueba» aterrizaba en la
// base principal sin un solo aviso. Ahora falta la variable y falla, con nombre.

require('dotenv').config();

const path = require('node:path');

const sqliteDatabasePath = (fileName) => path.join(__dirname, fileName);
const migrationsDirectory = path.join(__dirname, 'migrations');

const requireConnectionString = (connectionString, { label, variables }) => {
  if (typeof connectionString === 'string' && connectionString.trim()) {
    return connectionString.trim();
  }

  throw new Error(
    `knexfile: falta la cadena de conexion ${label}. Definí ${variables} en el .env de esta maquina. `
    + 'No hay herencia entre la conexion principal y la de prueba: cada una exige la suya.'
  );
};

const createPostgresConfig = (connectionString) => ({
  client: 'pg',
  connection: connectionString,
  pool: {
    min: 2,
    max: 10
  },
  migrations: {
    directory: migrationsDirectory,
    tableName: 'knex_migrations'
  }
});

const sqliteLegacyConfig = {
  client: 'better-sqlite3',
  connection: {
    filename: sqliteDatabasePath('apts.db')
  },
  useNullAsDefault: true,
  migrations: {
    directory: migrationsDirectory
  }
};

// Cada destino se resuelve al pedirlo, no al cargar el archivo. Si se resolvieran
// los dos de golpe, un servidor sin base de prueba no arrancaria por faltarle una
// variable que no piensa usar. Se memoiza para no rehacer el objeto en cada acceso.
const memoize = (build) => {
  let cached = null;
  return () => {
    if (!cached) cached = build();
    return cached;
  };
};

// La conexion principal: la que use esta maquina. En un servidor de produccion
// apunta a produccion; en un portatil, a la base de trabajo. El nombre del entorno
// no cambia el destino, lo cambia el .env.
const mainConfig = memoize(() => createPostgresConfig(requireConnectionString(
  process.env.PG_CONNECTION_STRING || process.env.DATABASE_URL,
  { label: 'principal', variables: 'PG_CONNECTION_STRING (o DATABASE_URL)' }
)));

// La de prueba: variable propia y obligatoria. Sin ella no se resuelve nada.
const testConfig = memoize(() => createPostgresConfig(requireConnectionString(
  process.env.PG_TEST_CONNECTION_STRING,
  { label: 'de prueba', variables: 'PG_TEST_CONNECTION_STRING' }
)));

module.exports = {
  // Alias del mismo destino. No son dos bases: son dos nombres.
  get development() { return mainConfig(); },
  get production() { return mainConfig(); },

  get test() { return testConfig(); },

  // Legacy profile reserved for one-time SQLite -> PostgreSQL data migration.
  sqlite_legacy: sqliteLegacyConfig
};
