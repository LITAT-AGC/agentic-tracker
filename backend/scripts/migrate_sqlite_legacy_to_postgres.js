#!/usr/bin/env node

require('dotenv').config();

const fs = require('node:fs');
const knex = require('knex');
const knexConfig = require('../knexfile');

const TABLES = [
  { name: 'projects', primaryKey: 'url' },
  { name: 'tasks', primaryKey: 'id' },
  { name: 'backlog_items', primaryKey: 'id' },
  { name: 'agent_logs', primaryKey: 'id' },
  { name: 'config', primaryKey: 'key' }
];
const POSTGRES_AUTOINCREMENT_TABLES = [
  { tableName: 'agent_logs', columnName: 'id' }
];

const BATCH_SIZE = 200;

const chunkArray = (items, size) => {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
};

const normalizeSourceRow = (tableName, row) => {
  if (tableName !== 'agent_logs') {
    return row;
  }

  return {
    ...row,
    technical_details: null
  };
};

const syncPostgresSequence = async (connection, { tableName, columnName = 'id' }) => {
  if (connection.client.config.client !== 'pg') {
    return false;
  }

  const sequenceResult = await connection.raw(
    'SELECT pg_get_serial_sequence(?, ?) AS sequence_name',
    [tableName, columnName]
  );
  const sequenceName = sequenceResult.rows?.[0]?.sequence_name;

  if (!sequenceName) {
    return false;
  }

  await connection.raw(
    'SELECT setval(?::regclass, COALESCE((SELECT MAX(??) FROM ??), 0) + 1, false)',
    [sequenceName, columnName, tableName]
  );

  return true;
};

const syncPostgresAutoIncrementSequences = async (connection, sequenceTargets) => {
  const synced = [];

  for (const sequenceTarget of sequenceTargets) {
    const didSync = await syncPostgresSequence(connection, sequenceTarget);
    if (didSync) {
      synced.push(`${sequenceTarget.tableName}.${sequenceTarget.columnName || 'id'}`);
    }
  }

  return synced;
};

const main = async () => {
  const shouldTruncateTarget = process.argv.includes('--truncate-target');

  const sourceConfig = knexConfig.sqlite_legacy;
  const targetConfig = knexConfig.development;

  if (!sourceConfig || sourceConfig.client !== 'better-sqlite3') {
    throw new Error('sqlite_legacy configuration was not found in backend/knexfile.js');
  }

  if (!targetConfig || targetConfig.client !== 'pg') {
    throw new Error('development configuration must point to PostgreSQL before running migration');
  }

  const sourceFile = sourceConfig.connection?.filename;
  if (!sourceFile || !fs.existsSync(sourceFile)) {
    throw new Error(`SQLite legacy file not found: ${sourceFile || '(undefined)'}`);
  }

  const sourceDb = knex(sourceConfig);
  const targetDb = knex(targetConfig);

  try {
    await sourceDb.raw('select 1');
    await targetDb.raw('select 1');

    const rowCountByTable = {};

    for (const table of TABLES) {
      const [{ count }] = await sourceDb(table.name).count({ count: '*' });
      rowCountByTable[table.name] = Number(count || 0);
    }

    console.log('SQLite legacy rows detected:', rowCountByTable);

    await targetDb.transaction(async (transaction) => {
      if (shouldTruncateTarget) {
        await transaction.raw('TRUNCATE TABLE agent_logs, backlog_items, tasks, projects, config RESTART IDENTITY CASCADE');
      }

      for (const table of TABLES) {
        const rows = await sourceDb(table.name).select('*');
        if (!rows.length) {
          continue;
        }

        const normalizedRows = rows.map((row) => normalizeSourceRow(table.name, row));
        const chunks = chunkArray(normalizedRows, BATCH_SIZE);

        for (const chunk of chunks) {
          await transaction(table.name)
            .insert(chunk)
            .onConflict(table.primaryKey)
            .merge();
        }

        console.log(`Migrated ${rows.length} row(s) for table ${table.name}`);
      }
    });

    const syncedSequences = await syncPostgresAutoIncrementSequences(targetDb, POSTGRES_AUTOINCREMENT_TABLES);

    if (syncedSequences.length > 0) {
      console.log('Synced PostgreSQL sequences:', syncedSequences.join(', '));
    }

    console.log('SQLite -> PostgreSQL migration completed successfully.');
  } finally {
    await Promise.allSettled([sourceDb.destroy(), targetDb.destroy()]);
  }
};

main().catch((error) => {
  console.error('Migration failed:', error.message);
  process.exitCode = 1;
});
