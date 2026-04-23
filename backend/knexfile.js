require('dotenv').config();

module.exports = {
  development: {
    client: 'better-sqlite3',
    connection: {
      filename: './apts.db'
    },
    useNullAsDefault: true
  },

  test: {
    client: 'better-sqlite3',
    connection: {
      filename: './apts_test.db'
    },
    useNullAsDefault: true,
    migrations: {
      directory: './migrations'
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
      tableName: 'knex_migrations'
    }
  }
};
