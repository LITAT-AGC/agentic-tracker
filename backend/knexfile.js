require('dotenv').config();

const path = require('node:path');

const sqliteDatabasePath = (fileName) => path.join(__dirname, fileName);
const migrationsDirectory = path.join(__dirname, 'migrations');

const ensureConnectionString = (connectionString, environmentName) => {
  if (typeof connectionString === 'string' && connectionString.trim()) {
    return connectionString.trim();
  }

  throw new Error(`Database client for ${environmentName} is PostgreSQL but no connection string was found. Set PG_CONNECTION_STRING or DATABASE_URL.`);
};

const createPostgresConfig = (connectionString, { production = false } = {}) => ({
  client: 'pg',
  connection: connectionString,
  pool: {
    min: 2,
    max: 10
  },
  migrations: {
    directory: migrationsDirectory,
    ...(production ? { tableName: 'knex_migrations' } : {})
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

const postgresConnection = ensureConnectionString(
  process.env.PG_CONNECTION_STRING || process.env.DATABASE_URL,
  process.env.NODE_ENV || 'development'
);

const postgresTestConnection = ensureConnectionString(
  process.env.PG_TEST_CONNECTION_STRING || process.env.PG_CONNECTION_STRING || process.env.DATABASE_URL,
  'test'
);

module.exports = {
  development: createPostgresConfig(postgresConnection),

  test: createPostgresConfig(postgresTestConnection),

  production: createPostgresConfig(postgresConnection, { production: true }),

  // Legacy profile reserved for one-time SQLite -> PostgreSQL data migration.
  sqlite_legacy: sqliteLegacyConfig
};
