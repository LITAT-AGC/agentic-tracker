require('dotenv').config();

const path = require('node:path');

const sqliteDatabasePath = (fileName) => path.join(__dirname, fileName);
const migrationsDirectory = path.join(__dirname, 'migrations');

module.exports = {
  development: {
    client: 'better-sqlite3',
    connection: {
      filename: sqliteDatabasePath('apts.db')
    },
    useNullAsDefault: true,
    migrations: {
      directory: migrationsDirectory
    }
  },

  test: {
    client: 'better-sqlite3',
    connection: {
      filename: sqliteDatabasePath('apts_test.db')
    },
    useNullAsDefault: true,
    migrations: {
      directory: migrationsDirectory
    }
  },

  production: {
    client: 'pg',
    connection: process.env.DATABASE_URL,
    pool: {
      min: 2,
      max: 10
    },
    migrations: {
      directory: migrationsDirectory,
      tableName: 'knex_migrations'
    }
  }
};
