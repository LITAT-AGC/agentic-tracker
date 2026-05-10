const crypto = require('node:crypto');

const DEFAULT_OPENROUTER_EMBEDDING_MODEL = process.env.OPENROUTER_DEFAULT_EMBEDDING_MODEL || 'openai/text-embedding-3-small';
const OPENROUTER_EMBEDDINGS_URL = 'https://openrouter.ai/api/v1/embeddings';
const STRATEGY_MODEL_CONFIG_PREFIX = 'embedding_strategy:';
const LEGACY_STRATEGY_MODEL_CONFIG = {
  bug_dedup: 'openrouter_embedding_model'
};

const normalizeTextField = (value) => (typeof value === 'string' ? value.trim() : '');

const parseEmbeddingVector = (value) => {
  const rawValue = typeof value === 'string'
    ? JSON.parse(value)
    : value;

  if (!Array.isArray(rawValue)) {
    return [];
  }

  return rawValue
    .map((entry) => Number(entry))
    .filter((entry) => Number.isFinite(entry));
};

const vectorNorm = (vector) => Math.sqrt(vector.reduce((accumulator, value) => accumulator + (value * value), 0));

const cosineSimilarity = (leftVector, rightVector, leftNorm = null, rightNorm = null) => {
  if (!Array.isArray(leftVector) || !Array.isArray(rightVector) || leftVector.length !== rightVector.length || !leftVector.length) {
    return Number.NaN;
  }

  const safeLeftNorm = Number.isFinite(leftNorm) ? leftNorm : vectorNorm(leftVector);
  const safeRightNorm = Number.isFinite(rightNorm) ? rightNorm : vectorNorm(rightVector);

  if (!safeLeftNorm || !safeRightNorm) {
    return Number.NaN;
  }

  let dotProduct = 0;
  for (let index = 0; index < leftVector.length; index += 1) {
    dotProduct += leftVector[index] * rightVector[index];
  }

  return dotProduct / (safeLeftNorm * safeRightNorm);
};

const truncateText = (value, maxLength = 16000) => normalizeTextField(value).slice(0, maxLength);

const createContentHash = (value) => crypto
  .createHash('sha256')
  .update(String(value || ''), 'utf8')
  .digest('hex');

const getConfigValue = async (connection, key) => {
  const hasConfigTable = await connection.schema.hasTable('config');
  if (!hasConfigTable) {
    return null;
  }

  const entry = await connection('config').where({ key }).first();
  return entry?.value || null;
};

const getStrategyModelConfigKey = (strategyKey) => `${STRATEGY_MODEL_CONFIG_PREFIX}${strategyKey}:model`;

const getEffectiveEmbeddingModel = async (connection, strategyKey) => {
  const strategyConfigKey = getStrategyModelConfigKey(strategyKey);
  const configuredStrategyModel = normalizeTextField(await getConfigValue(connection, strategyConfigKey));
  if (configuredStrategyModel) {
    return configuredStrategyModel;
  }

  const legacyConfigKey = LEGACY_STRATEGY_MODEL_CONFIG[strategyKey];
  if (legacyConfigKey) {
    const legacyModel = normalizeTextField(await getConfigValue(connection, legacyConfigKey));
    if (legacyModel) {
      return legacyModel;
    }
  }

  return DEFAULT_OPENROUTER_EMBEDDING_MODEL;
};

const getOpenRouterApiKey = () => {
  const apiKey = normalizeTextField(process.env.OPENROUTER_API_KEY);
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is required to request embeddings.');
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
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return parsed;
};

const toNonNegativeNumber = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return parsed;
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

const requestEmbedding = async (connection, strategyKey, inputText, {
  usageType = `semantic_${strategyKey}`,
  projectUrl = null,
  backlogItemId = null
} = {}) => {
  const normalizedInput = normalizeTextField(inputText);
  if (!normalizedInput) {
    throw new Error('Embedding input text is required');
  }

  const model = await getEffectiveEmbeddingModel(connection, strategyKey);
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
    usageType,
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

const buildBugEmbeddingText = (backlogItem) => {
  const title = normalizeTextField(backlogItem?.title);
  const description = normalizeTextField(backlogItem?.description);
  const acceptanceCriteria = normalizeTextField(backlogItem?.acceptance_criteria);
  const sourceKind = normalizeTextField(backlogItem?.source_kind);
  const sourceRef = normalizeTextField(backlogItem?.source_ref);

  return truncateText([
    title ? `titulo: ${title}` : '',
    description ? `descripcion: ${description}` : '',
    acceptanceCriteria ? `criterios_aceptacion: ${acceptanceCriteria}` : '',
    sourceKind ? `origen: ${sourceKind}` : '',
    sourceRef ? `referencia: ${sourceRef}` : ''
  ]
    .filter(Boolean)
    .join('\n\n'));
};

module.exports = {
  createContentHash,
  cosineSimilarity,
  getEffectiveEmbeddingModel,
  normalizeTextField,
  parseEmbeddingVector,
  requestEmbedding,
  truncateText,
  vectorNorm,
  buildBugEmbeddingText
};