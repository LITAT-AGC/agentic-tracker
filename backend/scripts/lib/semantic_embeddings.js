const crypto = require('node:crypto');

// El modelo por defecto ya no es de un proveedor concreto, así que la variable
// nueva no lo nombra; la vieja sigue leyéndose para no romper los despliegues que
// ya la tienen puesta. `backend/index.js` importa esta constante en vez de repetirla,
// para que el panel no pueda anunciar un modelo por defecto distinto del que se usa.
const DEFAULT_EMBEDDING_MODEL = process.env.EMBEDDING_DEFAULT_MODEL
  || process.env.OPENROUTER_DEFAULT_EMBEDDING_MODEL
  || 'openai/text-embedding-3-small';
const OPENROUTER_EMBEDDINGS_URL = 'https://openrouter.ai/api/v1/embeddings';
// El proveedor no se elige con una clave aparte: lo dice el propio identificador del
// modelo. Todo lo de Workers AI se llama `@cf/...`, así que `@cf/baai/bge-m3` sale por
// Cloudflare y `openai/text-embedding-3-small` por OpenRouter. Una segunda clave sólo
// serviría para contradecir a la primera, y el modelo ya viaja en `bug_embedding_model`
// y en `openrouter_usage_logs`, con lo que el proveedor queda registrado de paso.
const CLOUDFLARE_MODEL_PREFIX = '@cf/';

// F6-2-T4: hasta ahora este `fetch` no llevaba plazo de espera, así que si
// OpenRouter no respondía, la escritura de backlog que lo dispara se quedaba
// esperando sin límite —y en modo lote, una vez por elemento—. El cliente remoto sí
// impone plazo y corta, con lo que el pedido se perdía sin saber en qué estado quedó.
// Cada proveedor tiene el suyo: OPENROUTER_EMBEDDING_TIMEOUT_MS y
// CLOUDFLARE_EMBEDDING_TIMEOUT_MS.
const readTimeoutMs = (rawValue, fallbackMs) => {
  const configured = Number.parseInt(rawValue || '', 10);
  return Number.isInteger(configured) && configured > 0 ? configured : fallbackMs;
};
const OPENROUTER_EMBEDDING_TIMEOUT_MS = readTimeoutMs(process.env.OPENROUTER_EMBEDDING_TIMEOUT_MS, 10000);
const CLOUDFLARE_EMBEDDING_TIMEOUT_MS = readTimeoutMs(process.env.CLOUDFLARE_EMBEDDING_TIMEOUT_MS, 10000);
const STRATEGY_MODEL_CONFIG_PREFIX = 'embedding_strategy:';
const LEGACY_STRATEGY_MODEL_CONFIG = {
  bug_dedup: 'openrouter_embedding_model'
};

const normalizeTextField = (value) => (typeof value === 'string' ? value.trim() : '');

// Una fila con el vector corrupto es un dato malo, no un fallo del servicio: se
// descarta. Antes el `JSON.parse` iba sin guarda, y como esto se llama dentro del
// recorrido de candidatos de la busqueda, una sola fila ilegible tumbaba la busqueda
// entera. Devolver `[]` la deja fuera y el resto sigue comparandose.
const parseEmbeddingVector = (value) => {
  let rawValue = value;

  if (typeof value === 'string') {
    try {
      rawValue = JSON.parse(value);
    } catch {
      return [];
    }
  }

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

  return DEFAULT_EMBEDDING_MODEL;
};

const resolveEmbeddingProvider = (model) => (
  normalizeTextField(model).startsWith(CLOUDFLARE_MODEL_PREFIX) ? 'cloudflare' : 'openrouter'
);

const EMBEDDING_PROVIDER_LABELS = {
  cloudflare: 'Cloudflare',
  openrouter: 'OpenRouter'
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

const getCloudflareAccountId = () => {
  const accountId = normalizeTextField(process.env.CLOUDFLARE_ACCOUNT_ID);
  if (!accountId) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID is required to request embeddings.');
  }
  return accountId;
};

const getCloudflareApiToken = () => {
  const apiToken = normalizeTextField(process.env.CLOUDFLARE_API_TOKEN);
  if (!apiToken) {
    throw new Error('CLOUDFLARE_API_TOKEN is required to request embeddings.');
  }
  return apiToken;
};

const getCloudflareHeaders = () => {
  const headers = {
    Authorization: `Bearer ${getCloudflareApiToken()}`,
    'Content-Type': 'application/json'
  };

  // La pasarela de IA es opcional y no cambia la respuesta: sólo hace que la llamada
  // quede registrada y cacheada en AI Gateway. Se manda sólo si está configurada,
  // porque nombrar una pasarela que no existe es un 404 en vez de un embedding.
  const gatewayId = normalizeTextField(process.env.CLOUDFLARE_AI_GATEWAY_ID);
  if (gatewayId) {
    headers['cf-aig-gateway-id'] = gatewayId;
  }

  return headers;
};

const readCloudflareResponse = async (response) => {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    // Cloudflare no contesta con la forma de error de OpenAI ni siquiera en su punto
    // compatible: el motivo viaja en el `errors[]` del sobre de su API v4. Leer sólo
    // `error.message` dejaba el mensaje en el genérico del código HTTP —comprobado:
    // un token sin permiso sobre la cuenta responde 401 con
    // `{"errors":[{"code":10000,"message":"Authentication error"}]}`—.
    const message = data?.errors?.[0]?.message
      || data?.error?.message
      || data?.message
      || `status ${response.status}`;
    throw new Error(`Cloudflare embedding request failed: ${message}`);
  }
  return data;
};

const requestOpenRouterEmbeddingVector = async (model, inputText) => {
  let response;
  try {
    response = await fetch(OPENROUTER_EMBEDDINGS_URL, {
      method: 'POST',
      headers: getOpenRouterHeaders(),
      body: JSON.stringify({
        model,
        input: inputText
      }),
      signal: AbortSignal.timeout(OPENROUTER_EMBEDDING_TIMEOUT_MS)
    });
  } catch (error) {
    // El mensaje nombra a OpenRouter a propósito: es lo que reconoce
    // isSemanticProviderError() para tratarlo como fallo del proveedor (503) y,
    // en las escrituras, para que runNonBlockingSemanticOperation lo absorba.
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new Error(`OpenRouter embedding request timed out after ${OPENROUTER_EMBEDDING_TIMEOUT_MS} ms`);
    }
    throw error;
  }

  const data = await readOpenRouterResponse(response);

  return {
    embedding: parseEmbeddingVector(data?.data?.[0]?.embedding),
    usage: data?.usage
  };
};

// Se usa el punto compatible con OpenAI de Workers AI —`/ai/v1/embeddings`— y no el
// nativo `/ai/run/{modelo}`, porque habla exactamente el mismo pedido y la misma
// respuesta que OpenRouter: `{model, input}` fuera, `data[0].embedding` y `usage`
// dentro. Así el registro de consumo sigue contando tokens también para Cloudflare,
// que por el camino nativo no vienen.
const requestCloudflareEmbeddingVector = async (model, inputText) => {
  const embeddingsUrl = `https://api.cloudflare.com/client/v4/accounts/${getCloudflareAccountId()}/ai/v1/embeddings`;

  let response;
  try {
    response = await fetch(embeddingsUrl, {
      method: 'POST',
      headers: getCloudflareHeaders(),
      body: JSON.stringify({
        model,
        input: inputText
      }),
      signal: AbortSignal.timeout(CLOUDFLARE_EMBEDDING_TIMEOUT_MS)
    });
  } catch (error) {
    // Mismo motivo que arriba, con la palabra que reconoce isSemanticProviderError():
    // el texto lleva «embedding», así que un plazo vencido de Cloudflare también sale
    // como 503 del proveedor y no como 500 nuestro.
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new Error(`Cloudflare embedding request timed out after ${CLOUDFLARE_EMBEDDING_TIMEOUT_MS} ms`);
    }
    throw error;
  }

  const data = await readCloudflareResponse(response);

  // Se aceptan las dos formas a propósito. Si la llamada sale por AI Gateway con una
  // pasarela que devuelve el sobre nativo de Workers AI, el vector viene en
  // `result.data[0]` en vez de en `data[0].embedding`; leer sólo una de las dos
  // convertiría eso en «respuesta sin vector» sin decir por qué.
  return {
    embedding: parseEmbeddingVector(data?.data?.[0]?.embedding ?? data?.result?.data?.[0]),
    usage: data?.usage
  };
};

const EMBEDDING_PROVIDERS = {
  cloudflare: requestCloudflareEmbeddingVector,
  openrouter: requestOpenRouterEmbeddingVector
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

// La tabla se sigue llamando `openrouter_usage_logs` y ahora guarda también las
// llamadas a Cloudflare: no hace falta columna de proveedor porque el modelo ya lo
// dice —`@cf/...` es Cloudflare— y una columna nueva sería un segundo sitio donde
// equivocarse. Lo que Cloudflare no da es coste en dólares (factura en neuronas), así
// que esas filas van con `cost = 0` y sus tokens sí cuentan.
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
  const provider = resolveEmbeddingProvider(model);

  const { embedding, usage } = await EMBEDDING_PROVIDERS[provider](model, normalizedInput);

  // El consumo se apunta antes de mirar el vector, como antes: si el proveedor cobró
  // la llamada, la fila tiene que existir aunque la respuesta no sirva.
  await persistOpenRouterUsage(connection, {
    usageType,
    model,
    usage,
    projectUrl,
    backlogItemId
  });

  if (!embedding.length) {
    throw new Error(`${EMBEDDING_PROVIDER_LABELS[provider]} embedding response did not include a valid vector`);
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
  resolveEmbeddingProvider,
  truncateText,
  vectorNorm,
  buildBugEmbeddingText,
  DEFAULT_EMBEDDING_MODEL
};