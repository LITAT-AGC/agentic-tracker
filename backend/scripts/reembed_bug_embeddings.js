const path = require('node:path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const knexFactory = require('knex');
const knexConfig = require('../knexfile');
// Este script tenia su propia copia de todo: el texto que se embebe, la llamada a
// OpenRouter, la resolucion del modelo y el registro de consumo. Dos cosas malas
// salian de ahi. Una, el `fetch` no llevaba plazo de espera, asi que un proveedor
// mudo dejaba el re-embebido colgado sin limite, elemento a elemento. Y dos, el
// modelo se resolvia solo por `openrouter_embedding_model`, mientras que la
// busqueda vive de `getEffectiveEmbeddingModel(db, 'bug_dedup')`, que mira antes
// `embedding_strategy:bug_dedup:model`: con esa clave puesta, este script
// re-embebia con un modelo distinto al que luego compara la busqueda, y los
// vectores dejaban de ser comparables en silencio. Reescribir vectores con un
// modelo que no es el de la busqueda es justo lo contrario de lo que hace falta.
const {
  buildBugEmbeddingText,
  createContentHash,
  normalizeTextField,
  requestEmbedding
} = require('./lib/semantic_embeddings');

const DEFAULT_TARGET_ENV = process.env.APTS_REEMBED_TARGET_ENV || 'test';
const OPEN_BUG_BACKLOG_STATUSES = new Set(['draft', 'needs_details', 'ready', 'in_progress', 'review', 'blocked']);
// La misma clave de estrategia que usa la busqueda de bugs duplicados en
// `backend/index.js`. Si aqui dijera otra cosa, volveria la divergencia.
const BUG_EMBEDDING_STRATEGY_KEY = 'bug_dedup';
// Se conserva el valor historico de `usage_type`: la tabla ya tiene filas con
// `bug_embedding` y no hay motivo para partir la serie.
const BUG_EMBEDDING_USAGE_TYPE = 'bug_embedding';

const parseArgs = (argv) => {
  const options = {
    targetEnv: DEFAULT_TARGET_ENV,
    projects: [],
    limit: null,
    onlyMissing: false,
    openOnly: false,
    dryRun: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--project') {
      options.projects.push(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg.startsWith('--project=')) {
      options.projects.push(arg.slice('--project='.length));
      continue;
    }

    if (arg === '--target-env') {
      options.targetEnv = argv[index + 1] || options.targetEnv;
      index += 1;
      continue;
    }

    if (arg.startsWith('--target-env=')) {
      options.targetEnv = arg.slice('--target-env='.length) || options.targetEnv;
      continue;
    }

    if (arg === '--limit') {
      options.limit = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg.startsWith('--limit=')) {
      options.limit = Number(arg.slice('--limit='.length));
      continue;
    }

    if (arg === '--only-missing') {
      options.onlyMissing = true;
      continue;
    }

    if (arg === '--open-only') {
      options.openOnly = true;
      continue;
    }

    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
  }

  options.projects = options.projects.filter(Boolean);
  options.limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : null;
  return options;
};

const buildQuery = (connection, options) => {
  const query = connection('backlog_items')
    .where({ item_type: 'bug' })
    .whereNull('deleted_at')
    .orderBy('updated_at', 'desc');

  if (options.projects.length) {
    query.whereIn('project_url', options.projects);
  }

  if (options.openOnly) {
    query.whereIn('status', [...OPEN_BUG_BACKLOG_STATUSES]);
  }

  if (options.onlyMissing) {
    query.where((builder) => {
      builder.whereNull('bug_embedding').orWhere('bug_embedding', '');
    });
  }

  if (options.limit) {
    query.limit(options.limit);
  }

  return query;
};

const buildNonBugCleanupQuery = (connection, options) => {
  const query = connection('backlog_items')
    .whereNot({ item_type: 'bug' })
    .where((builder) => {
      builder.whereNotNull('bug_embedding')
        .orWhereNotNull('bug_embedding_model')
        .orWhereNotNull('bug_embedding_norm')
        .orWhereNotNull('bug_embedding_hash')
        .orWhereNotNull('bug_embedding_updated_at');
    });

  if (options.projects.length) {
    query.whereIn('project_url', options.projects);
  }

  return query;
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  const targetConfig = knexConfig[options.targetEnv];

  if (!targetConfig) {
    throw new Error(`Unknown target env '${options.targetEnv}'. Expected one of: ${Object.keys(knexConfig).join(', ')}`);
  }

  const db = knexFactory(targetConfig);

  try {
    const candidates = await buildQuery(db, options).select(
      'id',
      'project_url',
      'title',
      'description',
      'acceptance_criteria',
      'source_kind',
      'source_ref',
      'status',
      'bug_embedding'
    );

    if (options.dryRun) {
      console.log(JSON.stringify({
        dry_run: true,
        target_env: options.targetEnv,
        selected: candidates.length,
        projects: options.projects,
        open_only: options.openOnly,
        only_missing: options.onlyMissing,
        limit: options.limit,
        sample: candidates.slice(0, 10).map((item) => ({
          id: item.id,
          project_url: item.project_url,
          status: item.status,
          has_embedding: Boolean(normalizeTextField(item.bug_embedding)),
          title: item.title
        }))
      }, null, 2));
      return;
    }

    let embedded = 0;
    let skipped = 0;
    let failed = 0;
    let cleared = 0;

    for (const item of candidates) {
      try {
        const embeddingInput = buildBugEmbeddingText(item);
        if (!embeddingInput) {
          skipped += 1;
          continue;
        }

        const embeddingResult = await requestEmbedding(db, BUG_EMBEDDING_STRATEGY_KEY, embeddingInput, {
          usageType: BUG_EMBEDDING_USAGE_TYPE,
          projectUrl: item.project_url,
          backlogItemId: item.id
        });

        // El hash acompana al vector porque es lo que deja que la escritura del
        // item decida no volver a embeber. Si este script lo dejara sin tocar, el
        // vector seria nuevo y el hash viejo, y la siguiente escritura pagaria una
        // llamada para reescribir lo que acaba de escribirse aqui.
        await db('backlog_items')
          .where({ id: item.id })
          .update({
            bug_embedding: JSON.stringify(embeddingResult.embedding),
            bug_embedding_model: embeddingResult.model,
            bug_embedding_norm: embeddingResult.norm,
            bug_embedding_hash: createContentHash(embeddingInput),
            bug_embedding_updated_at: db.fn.now(),
            updated_at: db.fn.now()
          });

        embedded += 1;
      } catch (error) {
        failed += 1;
        console.warn(`Failed to re-embed ${item.id}: ${error.message}`);
      }
    }

    if (!options.onlyMissing) {
      const nonBugItemsUpdated = await buildNonBugCleanupQuery(db, options)
        .update({
          bug_embedding: null,
          bug_embedding_model: null,
          bug_embedding_norm: null,
          bug_embedding_hash: null,
          bug_embedding_updated_at: null,
          updated_at: db.fn.now()
        });

      cleared = Number(nonBugItemsUpdated || 0);
    }

    console.log(JSON.stringify({
      target_env: options.targetEnv,
      processed: candidates.length,
      embedded,
      skipped,
      failed,
      cleared_non_bug_embeddings: cleared,
      projects: options.projects,
      open_only: options.openOnly,
      only_missing: options.onlyMissing,
      limit: options.limit
    }, null, 2));
  } finally {
    await db.destroy();
  }
};

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});