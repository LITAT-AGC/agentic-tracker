const path = require('node:path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const knexFactory = require('knex');
const knexConfig = require('../knexfile');

const DEFAULT_TARGET_ENV = process.env.APTS_REEMBED_TARGET_ENV || 'test';
const DEFAULT_OPENROUTER_EMBEDDING_MODEL = process.env.OPENROUTER_DEFAULT_EMBEDDING_MODEL || 'openai/text-embedding-3-small';
const OPENROUTER_EMBEDDINGS_URL = 'https://openrouter.ai/api/v1/embeddings';
const OPEN_BUG_BACKLOG_STATUSES = new Set(['draft', 'needs_details', 'ready', 'in_progress', 'review', 'blocked']);
const OPENROUTER_EMBEDDING_CONFIG_KEY = 'openrouter_embedding_model';

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

const normalizeTextField = (value) => (typeof value === 'string' ? value.trim() : '');

const parseEmbeddingVector = (value) => {
  if (!Array.isArray(value)) return [];

  return value
    .map((entry) => Number(entry))
    .filter((entry) => Number.isFinite(entry));
};

const vectorNorm = (vector) => Math.sqrt(vector.reduce((accumulator, value) => accumulator + (value * value), 0));

const buildBugEmbeddingText = (backlogItem) => {
  const title = normalizeTextField(backlogItem?.title);
  const description = normalizeTextField(backlogItem?.description);
  const acceptanceCriteria = normalizeTextField(backlogItem?.acceptance_criteria);
  const sourceKind = normalizeTextField(backlogItem?.source_kind);
  const sourceRef = normalizeTextField(backlogItem?.source_ref);

  return [
    title ? `titulo: ${title}` : '',
    description ? `descripcion: ${description}` : '',
    acceptanceCriteria ? `criterios_aceptacion: ${acceptanceCriteria}` : '',
    sourceKind ? `origen: ${sourceKind}` : '',
    sourceRef ? `referencia: ${sourceRef}` : ''
  ]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 16000);
};

const getOpenRouterApiKey = () => {
  const apiKey = normalizeTextField(process.env.OPENROUTER_API_KEY);
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is required to re-embed bug items.');
  }
  return apiKey;
};

const getOpenRouterHeaders = () => {
  const headers = {
    Authorization: `Bearer ${getOpenRouterApiKey()}`,
    'Content-Type': 'application/json',
    'X-Title': 'APTS'
  };

  const referer = normalizeTextField(process.env.PUBLIC_APP_URL);
  if (referer) {
    headers['HTTP-Referer'] = referer;
  }

  return headers;
};

const readOpenRouterResponse = async (response) => {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error?.message || data?.message || `OpenRouter request failed with status ${response.status}`);
  }
  return data;
};

const toNonNegativeInteger = (value) => {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
};

const toNonNegativeNumber = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
};

const getConfigValue = async (connection, key) => {
  const hasConfigTable = await connection.schema.hasTable('config');
  if (!hasConfigTable) return null;
  const entry = await connection('config').where({ key }).first();
  return entry?.value || null;
};

const getEffectiveOpenRouterEmbeddingModel = async (connection) => {
  const configuredModel = await getConfigValue(connection, OPENROUTER_EMBEDDING_CONFIG_KEY);
  return normalizeTextField(configuredModel) || DEFAULT_OPENROUTER_EMBEDDING_MODEL;
};

const persistOpenRouterUsage = async (connection, {
  usageType,
  model,
  usage,
  projectUrl = null,
  backlogItemId = null
}) => {
  if (!usage || typeof usage !== 'object') {
    return;
  }

  const hasUsageTable = await connection.schema.hasTable('openrouter_usage_logs');
  if (!hasUsageTable) {
    return;
  }

  await connection('openrouter_usage_logs').insert({
    usage_type: normalizeTextField(usageType) || 'unknown',
    model: normalizeTextField(model) || 'unknown',
    project_url: normalizeTextField(projectUrl) || null,
    backlog_item_id: backlogItemId || null,
    prompt_tokens: toNonNegativeInteger(usage.prompt_tokens),
    completion_tokens: toNonNegativeInteger(usage.completion_tokens),
    total_tokens: toNonNegativeInteger(usage.total_tokens),
    cost: toNonNegativeNumber(usage.cost),
    is_byok: typeof usage.is_byok === 'boolean' ? usage.is_byok : null,
    raw_usage: usage
  });
};

const requestOpenRouterEmbedding = async (connection, inputText, { projectUrl, backlogItemId } = {}) => {
  const normalizedInput = normalizeTextField(inputText);
  if (!normalizedInput) {
    throw new Error('Embedding input text is required');
  }

  const model = await getEffectiveOpenRouterEmbeddingModel(connection);
  const response = await fetch(OPENROUTER_EMBEDDINGS_URL, {
    method: 'POST',
    headers: getOpenRouterHeaders(),
    body: JSON.stringify({
      model,
      input: normalizedInput
    })
  });

  const data = await readOpenRouterResponse(response);
  await persistOpenRouterUsage(connection, {
    usageType: 'bug_embedding',
    model,
    usage: data?.usage,
    projectUrl,
    backlogItemId
  });

  const embedding = parseEmbeddingVector(data?.data?.[0]?.embedding);
  if (!embedding.length) {
    throw new Error('OpenRouter embedding response did not include a valid vector');
  }

  return {
    model,
    embedding,
    norm: vectorNorm(embedding)
  };
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

        const embeddingResult = await requestOpenRouterEmbedding(db, embeddingInput, {
          projectUrl: item.project_url,
          backlogItemId: item.id
        });

        await db('backlog_items')
          .where({ id: item.id })
          .update({
            bug_embedding: JSON.stringify(embeddingResult.embedding),
            bug_embedding_model: embeddingResult.model,
            bug_embedding_norm: embeddingResult.norm,
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