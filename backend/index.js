require('dotenv').config();
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const createKnex = require('knex');
const express = require('express');
const cors = require('cors');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const pino = require('pino');
const pinoHttp = require('pino-http');
const { z } = require('zod');
const knexConfig = require('./knexfile');
const {
  deleteSemanticDocumentsForBacklogItem,
  estimateEmbeddingCost,
  getProjectBacklogCoverageStatus,
  searchProjectBacklogCoverage,
  syncBacklogCoverageDocument,
  syncBacklogCoverageDocuments,
  syncProjectBacklogCoverageDocuments
} = require('./scripts/lib/semantic_documents');
const {
  aptsNext,
  aptsWorkflowStep,
  aptsSubmitStep,
  methodStatus,
  setMethodStatus,
  STORY_METHOD_STATUSES
} = require('./scripts/lib/method_resolver');
const { createInitiative, setAgentRole } = require('./scripts/lib/method_bootstrap');
// Deuda de F6 que esto cierra: la llamada de embedding estaba implementada dos
// veces —aquí y en la librería—, con el mismo `fetch`, las mismas cabeceras y el
// mismo plazo copiados. Se conserva una sola: la de la librería.
const { requestEmbedding: requestLibraryEmbedding } = require('./scripts/lib/semantic_embeddings');
const rootPackage = require('../package.json');
const db = createKnex(knexConfig[process.env.NODE_ENV || 'development']);

const app = express();
app.set('trust proxy', 1);

const isProduction = process.env.NODE_ENV === 'production';
const usePrettyLogs = process.env.PINO_PRETTY !== 'false' && !isProduction;
const ignoredHttpLogPaths = (process.env.HTTP_LOG_IGNORE_PATHS || '/api/login')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);

const shouldIgnoreHttpLog = (req) => ignoredHttpLogPaths
  .some((pathPrefix) => req.url === pathPrefix || req.url.startsWith(`${pathPrefix}?`));

const isFrontendServiceRequest = (req) => {
  const requestPath = req.path || req.url || '';

  if (requestPath === '/api/login') return true;
  if (requestPath.startsWith('/api/dashboard')) return true;
  return /^\/api\/tasks\/[^/]+\/resolve(?:\?|$)/.test(requestPath);
};

const buildReceivedParams = (req) => {
  const payload = {};

  if (req.params && Object.keys(req.params).length > 0) {
    payload.path = req.params;
  }

  if (req.query && Object.keys(req.query).length > 0) {
    payload.query = req.query;
  }

  if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
    payload.body = req.body;
  }

  return payload;
};

const logger = pino({
  level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.body.password',
      'req.body.token',
      'req.body.apts_api_key',
      'req.body.api_key',
      'received.body.password',
      'received.body.token',
      'received.body.apts_api_key',
      'received.body.api_key'
    ],
    censor: '[REDACTED]'
  },
  ...(usePrettyLogs
    ? {
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname'
        }
      }
    }
    : {})
});

app.use(pinoHttp({
  logger,
  autoLogging: false
}));

// Remote MCP surface (F6-1). Kept out of the /api tree on purpose: it is agent
// surface, not dashboard API. Its own body parser runs inside the route with a
// 4 MB cap (decision #6); every other route keeps the express default (100 kb).
const MCP_ROUTE_PATH = '/mcp';
const MCP_MAX_MESSAGE_SIZE = '4mb';

const defaultJsonParser = express.json();
const mcpJsonParser = express.json({ limit: MCP_MAX_MESSAGE_SIZE });

app.use((req, res, next) => {
  if ((req.path || req.url) === MCP_ROUTE_PATH) return next();
  return defaultJsonParser(req, res, next);
});
app.use((req, res, next) => {
  res.on('finish', () => {
    if (shouldIgnoreHttpLog(req)) return;

    const route = req.path || req.url;
    const received = buildReceivedParams(req);
    const payload = { route, received, status_code: res.statusCode };

    if (res.statusCode >= 500) {
      logger.error(payload, 'HTTP request');
      return;
    }

    if (res.statusCode >= 400) {
      logger.warn(payload, 'HTTP request');
      return;
    }

    if (isFrontendServiceRequest(req)) return;
    logger.info(payload, 'HTTP request');
  });

  next();
});

const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',')
  : ['http://localhost:5173', 'http://localhost:47302'];

app.use(cors({
  origin: allowedOrigins,
  credentials: true
}));

app.use(session({
  secret: process.env.SESSION_SECRET || 'super-secret-key',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
}));

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5 });
// Single global counter shared by agent surface and dashboard (decision #6):
// raised from 100 to 600/min because on the remote surface every operation is
// its own HTTP request, plus initialize + tools/list on connect.
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 600 });

const authenticateAgent = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }
  const token = authHeader.split(' ')[1];
  if (token !== (process.env.APTS_API_KEY || 'default-dev-key')) {
    return res.status(403).json({ error: 'Invalid API Key' });
  }
  next();
};

const BACKLOG_ITEM_TYPES = ['feature', 'bug', 'chore', 'research'];
const BACKLOG_STATUSES = ['draft', 'needs_details', 'ready', 'in_progress', 'review', 'blocked', 'done', 'archived'];
const TASK_STATUSES = ['todo', 'in_progress', 'review', 'done', 'stalled'];
// F6-2-T2: mismos valores que declara la migración `20260620000010_bmad_hierarchy.js`
// para las columnas `initiatives.track` y `initiatives.phase`. Sin comprobarlos en la
// ruta, un valor inválido llegaba a la base y salía como 500 con el detalle interno.
const INITIATIVE_TRACKS = ['quick', 'method', 'enterprise'];
const INITIATIVE_PHASES = ['analysis', 'planning', 'solutioning', 'implementation', 'done'];
const TASK_RESUMABLE_STATUSES = new Set(['todo', 'in_progress', 'stalled']);
const TASK_STATUS_TRANSITIONS = {
  todo: new Set(['in_progress', 'stalled']),
  in_progress: new Set(['todo', 'review', 'stalled']),
  review: new Set(['in_progress', 'done', 'stalled']),
  stalled: new Set(['todo', 'in_progress']),
  done: new Set([])
};
const TASK_ACTIVITY_FRESHNESS_MS = 15 * 60 * 1000;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
// Plazos de espera de las llamadas externas. Sin ellos, un proveedor que no responde
// deja al que llama esperando sin límite, y en modo lote se multiplica por elemento.
// El del embedding vive en `scripts/lib/semantic_embeddings.js`, que es desde F6 la
// única implementación de esa llamada; la variable de entorno sigue siendo
// `OPENROUTER_EMBEDDING_TIMEOUT_MS`.
//
// El webhook es un servicio de terceros y su entrega ya tolera fallos, así que el
// plazo es más corto: nadie debería esperar por él.
const WEBHOOK_DELIVERY_TIMEOUT_MS = (() => {
  const configured = Number.parseInt(process.env.WEBHOOK_DELIVERY_TIMEOUT_MS || '', 10);
  return Number.isInteger(configured) && configured > 0 ? configured : 5000;
})();
// Las dos llamadas del panel. Estaban sin plazo: F6-2-T4 las dejó fuera a propósito
// porque no se alcanzan desde las 21 operaciones, y quedaron anotadas como deuda.
// El listado de modelos es una lectura barata; la de chat es una generación de un
// modelo de lenguaje, que tarda legítimamente mucho más, así que no comparten valor.
const OPENROUTER_MODELS_TIMEOUT_MS = (() => {
  const configured = Number.parseInt(process.env.OPENROUTER_MODELS_TIMEOUT_MS || '', 10);
  return Number.isInteger(configured) && configured > 0 ? configured : 10000;
})();
const OPENROUTER_CHAT_TIMEOUT_MS = (() => {
  const configured = Number.parseInt(process.env.OPENROUTER_CHAT_TIMEOUT_MS || '', 10);
  return Number.isInteger(configured) && configured > 0 ? configured : 120000;
})();
const DEFAULT_OPENROUTER_MODEL = process.env.OPENROUTER_DEFAULT_MODEL || 'google/gemini-2.0-flash-lite-001';
const DEFAULT_OPENROUTER_EMBEDDING_MODEL = process.env.OPENROUTER_DEFAULT_EMBEDDING_MODEL || 'openai/text-embedding-3-small';
const CONFIG_KEYS = {
  openrouterModel: 'openrouter_model',
  openrouterEmbeddingModel: 'openrouter_embedding_model'
};
const AUTO_TRIAGE_BACKLOG_STATUSES = new Set(['draft', 'needs_details', 'ready']);
const OPEN_BUG_BACKLOG_STATUSES = new Set(['draft', 'needs_details', 'ready', 'in_progress', 'review', 'blocked']);
const MAX_SEMANTIC_SEARCH_TOP_K = 20;
const DEFAULT_SEMANTIC_SEARCH_TOP_K = 5;
const DEFAULT_SEMANTIC_SEARCH_THRESHOLD = 0.78;
const DEFAULT_BACKLOG_COVERAGE_SEARCH_THRESHOLD = 0.6;
const MAX_OPEN_BUGS_FOR_STARTUP_EMBEDDING = 10;
const MAX_BATCH_SIZE = 100;
const SQLITE_LEGACY_BATCH_SIZE = 200;
const RESPONSE_VIEW_MODES = ['full', 'compact'];
const DEFAULT_RESPONSE_VIEW = 'compact';
const PROJECT_CONTEXT_INCLUDE_SECTIONS = ['tasks', 'backlog', 'logs'];
const DEFAULT_TASK_DETAIL_LOG_LIMIT = 20;
const MAX_TASK_DETAIL_LOG_LIMIT = 100;
// read_project_context paginates the tasks and backlog sections so a project with
// dozens of epics cannot blow up an agent's context window in a single call. The
// caller controls the window via {tasks,backlog}_limit/_offset; these are the
// applied defaults and the hard ceiling per section.
const DEFAULT_PROJECT_CONTEXT_SECTION_LIMIT = 50;
const MAX_PROJECT_CONTEXT_SECTION_LIMIT = 200;
// list_backlog_items is the regla-7 listing path agents are told to use, so it
// gets the same safe-default page size and hard ceiling: an unbounded `limit`
// would return an entire project's backlog in a single call.
const DEFAULT_BACKLOG_LIST_LIMIT = 50;
const MAX_BACKLOG_LIST_LIMIT = 200;
const COMPACT_TEXT_EXCERPT_LIMIT = 240;
const PROJECT_CONSTRAINTS_CONFIG_PREFIX = 'project_constraints:';
const BACKLOG_COMPACT_SELECT_COLUMNS = [
  'id',
  'project_url',
  'title',
  'description',
  'acceptance_criteria',
  'item_type',
  'status',
  'priority',
  'sort_order',
  'source_kind',
  'source_ref',
  'active_task_id',
  'llm_analysis_summary',
  'llm_confidence',
  'llm_recommendation_status',
  'created_at',
  'updated_at',
  'deleted_at'
];
const TASK_COMPACT_SELECT_COLUMNS = [
  'id',
  'project_url',
  'title',
  'agent_name',
  'status',
  'context',
  'last_heartbeat',
  'created_at',
  'updated_at'
];
const SQLITE_LEGACY_TABLES = [
  { name: 'projects', primaryKey: 'url' },
  { name: 'tasks', primaryKey: 'id' },
  { name: 'backlog_items', primaryKey: 'id' },
  { name: 'agent_logs', primaryKey: 'id' },
  { name: 'config', primaryKey: 'key' }
];
const POSTGRES_AUTOINCREMENT_TABLES = [
  { tableName: 'agent_logs', columnName: 'id' }
];

const parseJsonArray = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value;

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
};

const chunkArray = (items, chunkSize) => {
  const chunks = [];

  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }

  return chunks;
};

const normalizeSqliteLegacyRow = (tableName, row) => {
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

const toNumberOrNull = (value) => {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const parseBooleanFlag = (value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return false;

  const normalized = value.trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalized);
};

const unwrapMatchingQuotes = (value) => {
  if (typeof value !== 'string') return value;

  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;

  const startsWithDouble = trimmed.startsWith('"') && trimmed.endsWith('"');
  const startsWithSingle = trimmed.startsWith("'") && trimmed.endsWith("'");

  if (!startsWithDouble && !startsWithSingle) return trimmed;
  return trimmed.slice(1, -1).trim();
};

const normalizeInputString = (value, { unwrapQuotes = false, lowercase = false } = {}) => {
  if (typeof value !== 'string') return null;

  let normalized = value.trim();
  if (unwrapQuotes) {
    normalized = unwrapMatchingQuotes(normalized);
  }
  if (lowercase) {
    normalized = normalized.toLowerCase();
  }

  return normalized;
};

const normalizeResponseView = (value) => {
  const normalized = normalizeInputString(value, { lowercase: true });
  return normalized || DEFAULT_RESPONSE_VIEW;
};

const validateResponseView = (value) => {
  const normalized = normalizeResponseView(value);
  if (!RESPONSE_VIEW_MODES.includes(normalized)) {
    throw createHttpError(400, `Invalid view. Supported values: ${RESPONSE_VIEW_MODES.join(', ')}`);
  }
  return normalized;
};

const parseOptionalNonNegativeInteger = (value, fieldName, { max = Number.MAX_SAFE_INTEGER } = {}) => {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  const normalized = normalizeInputString(String(value), { unwrapQuotes: true });
  if (!normalized) {
    return undefined;
  }

  if (!/^\d+$/.test(normalized)) {
    throw createHttpError(400, `${fieldName} must be a non-negative integer`);
  }

  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw createHttpError(400, `${fieldName} must be a non-negative integer`);
  }

  if (parsed > max) {
    throw createHttpError(400, `${fieldName} must be <= ${max}`);
  }

  return parsed;
};

const parseCommaSeparatedUuidList = (value, fieldName) => {
  if (value === undefined || value === null || value === '') {
    return [];
  }

  const rawValue = Array.isArray(value) ? value.join(',') : value;
  if (typeof rawValue !== 'string') {
    throw createHttpError(400, `${fieldName} must be a comma-separated UUID list`);
  }

  const ids = rawValue
    .split(',')
    .map((entry) => normalizeInputString(entry, { unwrapQuotes: true }))
    .filter(Boolean);

  if (!ids.length) {
    return [];
  }

  const invalidId = ids.find((id) => !UUID_REGEX.test(id));
  if (invalidId) {
    throw createHttpError(400, `${fieldName} contains invalid UUID: ${invalidId}`);
  }

  return [...new Set(ids)];
};

const parseProjectContextInclude = (value) => {
  if (value === undefined || value === null || value === '') {
    return new Set(PROJECT_CONTEXT_INCLUDE_SECTIONS);
  }

  const rawValue = Array.isArray(value) ? value.join(',') : value;
  if (typeof rawValue !== 'string') {
    throw createHttpError(400, `Invalid include. Supported values: ${PROJECT_CONTEXT_INCLUDE_SECTIONS.join(', ')}`);
  }

  const requestedSections = rawValue
    .split(',')
    .map((entry) => normalizeInputString(entry, { lowercase: true }))
    .filter(Boolean);

  if (!requestedSections.length) {
    return new Set(PROJECT_CONTEXT_INCLUDE_SECTIONS);
  }

  const invalidSection = requestedSections
    .find((section) => !PROJECT_CONTEXT_INCLUDE_SECTIONS.includes(section));

  if (invalidSection) {
    throw createHttpError(400, `Invalid include section '${invalidSection}'. Supported values: ${PROJECT_CONTEXT_INCLUDE_SECTIONS.join(', ')}`);
  }

  return new Set(requestedSections);
};

const isUuid = (value) => typeof value === 'string' && UUID_REGEX.test(value);

const normalizeSchemaInputString = (value, options = {}) => {
  if (typeof value !== 'string') return value;
  return normalizeInputString(value, options);
};

const zodErrorMessage = (validationError) => validationError.issues?.[0]?.message || 'Invalid request payload';

const createHttpError = (statusCode, message, options = {}) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = options.code || null;
  error.expose = typeof options.expose === 'boolean'
    ? options.expose
    : statusCode < 500;
  error.details = options.details || null;
  error.cause = options.cause || null;
  return error;
};

const getErrorStatusCode = (error) => {
  const parsedStatusCode = Number(error?.statusCode);
  if (!Number.isInteger(parsedStatusCode) || parsedStatusCode < 400 || parsedStatusCode > 599) {
    return 500;
  }

  return parsedStatusCode;
};

const shouldExposeError = (error, statusCode = getErrorStatusCode(error)) => {
  if (typeof error?.expose === 'boolean') {
    return error.expose;
  }

  return statusCode < 500;
};

const serializeErrorForLog = (error) => ({
  message: error?.message || 'Unknown error',
  status_code: getErrorStatusCode(error),
  code: error?.code || null,
  details: error?.details || null,
  cause: error?.cause?.message || null,
  stack: error?.stack || null
});

// F6-2: la construcción del cuerpo de error se separa del envío por la respuesta
// HTTP, porque la superficie MCP remota ejecuta en proceso y necesita el mismo
// cuerpo exacto (sin `res`) para traducirlo al error que devolvía el cliente.
const buildApiErrorPayload = (error, {
  fallbackMessage = 'Internal server error',
  responseBody = {}
} = {}) => {
  const statusCode = getErrorStatusCode(error);
  const publicMessage = shouldExposeError(error, statusCode)
    ? (error?.message || fallbackMessage)
    : fallbackMessage;

  const payload = {
    error: publicMessage,
    ...responseBody
  };

  if (error?.code) {
    payload.code = error.code;
  }

  if (error?.details && statusCode < 500) {
    payload.details = error.details;
  }

  return { statusCode, payload };
};

const sendApiError = (res, error, {
  fallbackMessage = 'Internal server error',
  logMessage = 'Request failed',
  logContext = {},
  responseBody = {}
} = {}) => {
  const { statusCode, payload } = buildApiErrorPayload(error, { fallbackMessage, responseBody });

  const logPayload = {
    ...logContext,
    error: serializeErrorForLog(error)
  };

  if (statusCode >= 500) {
    logger.error(logPayload, logMessage);
  } else {
    logger.warn(logPayload, logMessage);
  }

  return res.status(statusCode).json(payload);
};

const sendBatchRouteError = (res, error, {
  strict = false,
  fallbackMessage = 'Batch operation failed',
  logMessage = 'Batch operation failed',
  logContext = {}
} = {}) => {
  if (strict) {
    return sendApiError(res, error, {
      fallbackMessage,
      logMessage,
      logContext,
      responseBody: {
        strict: true,
        failed_index: Number.isInteger(error?.failedIndex) ? error.failedIndex : null
      }
    });
  }

  return sendApiError(res, error, {
    fallbackMessage,
    logMessage,
    logContext
  });
};

const isSemanticProviderError = (error) => {
  const message = String(error?.message || '').toLowerCase();
  return message.includes('openrouter')
    || message.includes('embedding')
    || message.includes('api key is required');
};

const normalizeSemanticError = (error, {
  unavailableMessage = 'Semantic processing is temporarily unavailable',
  internalMessage = 'Semantic processing failed',
  unavailableCode = 'SEMANTIC_SERVICE_UNAVAILABLE',
  internalCode = 'SEMANTIC_PROCESSING_FAILED'
} = {}) => {
  if (error?.statusCode) {
    return error;
  }

  if (isSemanticProviderError(error)) {
    return createHttpError(503, unavailableMessage, {
      code: unavailableCode,
      expose: true,
      cause: error
    });
  }

  return createHttpError(500, internalMessage, {
    code: internalCode,
    expose: false,
    cause: error
  });
};

const runNonBlockingSemanticOperation = async (operation, logContext = {}) => {
  try {
    return await operation();
  } catch (error) {
    const normalizedError = normalizeSemanticError(error, {
      unavailableMessage: 'Semantic indexing is temporarily unavailable',
      internalMessage: 'Semantic indexing failed',
      unavailableCode: 'SEMANTIC_SIDE_EFFECT_UNAVAILABLE',
      internalCode: 'SEMANTIC_SIDE_EFFECT_FAILED'
    });

    logger.warn({
      ...logContext,
      error: serializeErrorForLog(normalizedError)
    }, 'Non-blocking semantic operation failed');

    return {
      status: 'failed',
      code: normalizedError.code
    };
  }
};

const normalizeBatchRequestBody = (body) => {
  if (Array.isArray(body)) {
    if (body.length === 0) {
      return { error: 'Batch payload must include at least one item' };
    }

    if (body.length > MAX_BATCH_SIZE) {
      return { error: `Batch payload exceeds maximum size of ${MAX_BATCH_SIZE} items` };
    }

    return { isBatch: true, items: body };
  }

  return { isBatch: false, items: [body || {}] };
};

const executeBatchOperation = async (items, handler) => {
  const results = [];

  for (let index = 0; index < items.length; index += 1) {
    try {
      const data = await handler(items[index], index);
      results.push({ index, success: true, data });
    } catch (error) {
      results.push({
        index,
        success: false,
        error: error.message,
        status_code: Number.isInteger(error.statusCode) ? error.statusCode : 500
      });
    }
  }

  return results;
};

const executeStrictBatchOperation = async (items, handler) => {
  const deferredWebhooks = [];

  const results = await db.transaction(async (transaction) => {
    const strictResults = [];

    for (let index = 0; index < items.length; index += 1) {
      try {
        const data = await handler(items[index], index, {
          connection: transaction,
          deferredWebhooks
        });
        strictResults.push({ index, success: true, data });
      } catch (error) {
        const strictError = createHttpError(
          Number.isInteger(error.statusCode) ? error.statusCode : 500,
          error.message
        );
        strictError.failedIndex = index;
        strictError.processed = index;
        throw strictError;
      }
    }

    return strictResults;
  });

  for (const event of deferredWebhooks) {
    await notifyWebhook(event.project_url, event.payload);
  }

  return results;
};

const shouldUseStrictBatchMode = (req, isBatch) => {
  if (!isBatch) return false;
  return parseBooleanFlag(req.query.strict);
};

// F6-2: valida los elementos de un lote con el mismo mensaje indexado que usaban
// las rutas. Lo comparten las rutas express y la superficie MCP remota.
const parseBatchItems = (items, schema) => {
  const parsedItems = [];

  for (let index = 0; index < items.length; index += 1) {
    const parsed = schema.safeParse(items[index] || {});
    if (!parsed.success) {
      throw createHttpError(400, `Invalid payload at index ${index}: ${zodErrorMessage(parsed.error)}`);
    }
    parsedItems.push(parsed.data);
  }

  return parsedItems;
};

// F6-2: igual que arriba, el cuerpo de la respuesta de lote se construye aparte
// del envío para que la superficie remota devuelva exactamente lo mismo.
const buildBatchOperationResponse = (results, { successStatus = 200 } = {}) => {
  const failed = results.filter((item) => !item.success).length;
  const succeeded = results.length - failed;

  return {
    statusCode: failed > 0 ? 207 : successStatus,
    payload: {
      success: failed === 0,
      processed: results.length,
      succeeded,
      failed,
      results
    }
  };
};

const sendBatchOperationResponse = (res, results, { successStatus = 200 } = {}) => {
  const { statusCode, payload } = buildBatchOperationResponse(results, { successStatus });
  return res.status(statusCode).json(payload);
};

// F6-2-T2: zod 4 ignora `invalid_type_error` —la clave es `error`—, así que hasta
// ahora un campo ausente daba "Invalid input: expected string, received undefined"
// sin decir cuál. Con `error` como función se distingue "falta el campo" de "el
// tipo es otro"; el mensaje de un check concreto (.min, .regex) sigue mandando.
const missingOrInvalidTypeMessage = (requiredMessage, invalidTypeMessage) => (issue) => (
  issue?.input === undefined || issue?.input === null ? requiredMessage : invalidTypeMessage
);

const nonEmptyStringSchema = (
  requiredMessage,
  invalidTypeMessage = requiredMessage,
  options = {}
) => z.preprocess(
  (value) => normalizeSchemaInputString(value, options),
  z.string({ error: missingOrInvalidTypeMessage(requiredMessage, invalidTypeMessage) }).min(1, requiredMessage)
);

const optionalStringSchema = (invalidTypeMessage, options = {}) => z.preprocess(
  (value) => {
    if (value === undefined) return undefined;
    return normalizeSchemaInputString(value, options);
  },
  z.string({ error: invalidTypeMessage }).optional()
);

const optionalNullableStringSchema = (invalidTypeMessage, options = {}) => z.preprocess(
  (value) => {
    if (value === undefined) return undefined;
    if (value === null || value === '') return null;
    return normalizeSchemaInputString(value, options);
  },
  z.string({ error: invalidTypeMessage }).nullable().optional()
);

const enumFieldSchema = (
  allowedValues,
  invalidTypeMessage,
  invalidValueMessage,
  { optional = false } = {}
) => {
  const schema = z.preprocess(
    (value) => {
      if (optional && value === undefined) return undefined;
      return normalizeSchemaInputString(value, { unwrapQuotes: true, lowercase: true });
    },
    z.string({ error: invalidTypeMessage })
      .refine((value) => allowedValues.includes(value), { message: invalidValueMessage })
  );

  return optional ? schema.optional() : schema;
};

const integerFieldSchema = (invalidMessage, { optional = false, min, max } = {}) => {
  const schema = z.preprocess(
    (value) => {
      if (optional && value === undefined) return undefined;
      if (value === null || value === '') return value;
      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return value;
        const parsed = Number(trimmed);
        return Number.isFinite(parsed) ? parsed : value;
      }
      return value;
    },
    (() => {
      let integerSchema = z.number({ error: invalidMessage }).int(invalidMessage);
      if (typeof min === 'number') integerSchema = integerSchema.min(min, invalidMessage);
      if (typeof max === 'number') integerSchema = integerSchema.max(max, invalidMessage);
      return integerSchema;
    })()
  );

  return optional ? schema.optional() : schema;
};

const numberFieldSchema = (invalidMessage, { optional = false, min, max } = {}) => {
  let numberSchema = z.number({ error: invalidMessage });

  if (typeof min === 'number') {
    numberSchema = numberSchema.min(min, invalidMessage);
  }

  if (typeof max === 'number') {
    numberSchema = numberSchema.max(max, invalidMessage);
  }

  const schema = z.preprocess(
    (value) => {
      if (optional && value === undefined) return undefined;
      if (value === null || value === '') return value;
      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return value;
        const parsed = Number(trimmed);
        return Number.isFinite(parsed) ? parsed : value;
      }
      return value;
    },
    numberSchema
  );

  return optional ? schema.optional() : schema;
};

const uuidFieldSchema = (
  invalidMessage,
  { optional = false, nullable = false } = {}
) => {
  let schema = z.preprocess(
    (value) => {
      if (optional && value === undefined) return undefined;
      if (nullable && (value === null || value === '')) return null;
      return normalizeSchemaInputString(value, { unwrapQuotes: true });
    },
    z.string({ error: invalidMessage }).regex(UUID_REGEX, invalidMessage)
  );

  if (nullable) {
    schema = schema.nullable();
  }

  if (optional) {
    schema = schema.optional();
  }

  return schema;
};

const taskIdParamSchema = z.object({
  id: uuidFieldSchema('Task id must be a valid UUID')
});

const backlogIdParamSchema = z.object({
  id: uuidFieldSchema('Backlog item id must be a valid UUID')
});

const registerTaskBodySchema = z.object({
  project_url: nonEmptyStringSchema('Project url is required', 'Project url is required', { unwrapQuotes: true }),
  title: nonEmptyStringSchema('Title is required', 'Title must be a string'),
  // F6-2-T2: obligatorios en el servidor. El cliente ya los exigía; sin él en el
  // camino remoto, dejarlos opcionales era perder el rastro de quién hizo qué.
  agent_name: nonEmptyStringSchema('Agent name is required', 'Agent name must be a string'),
  agent_email: nonEmptyStringSchema('Agent email is required', 'Agent email must be a string'),
  context: z.preprocess(
    (value) => {
      if (value === undefined || value === null) return undefined;
      return normalizeSchemaInputString(value);
    },
    z.string({ error: 'Context must be a string' }).optional()
  ),
  backlog_item_id: uuidFieldSchema('Backlog item id must be a valid UUID', { optional: true })
});

const taskStatusUpdateBodySchema = z.object({
  status: enumFieldSchema(TASK_STATUSES, 'Invalid task status', 'Invalid task status'),
  // F6-2-T2: los tres pasan a obligatorios; `agent_email` ni siquiera existía en el
  // esquema, así que el servidor lo descartaba en silencio.
  project_url: nonEmptyStringSchema('Project url is required', 'Project url must be a string', { unwrapQuotes: true }),
  agent_name: nonEmptyStringSchema('Agent name is required', 'Agent name must be a string'),
  agent_email: nonEmptyStringSchema('Agent email is required', 'Agent email must be a string')
});

const taskStatusUpdateBatchBodySchema = taskStatusUpdateBodySchema.extend({
  task_id: uuidFieldSchema('Task id must be a valid UUID')
});

const logAgentProgressBodySchema = z.object({
  // F6-2-T2: `agent_name` pasa a obligatorio. `branch` NO: la rama cambia durante
  // la sesión y el servidor no ve el repositorio del cliente, así que queda
  // opcional de verdad, como preveía la decisión #1.
  agent_name: nonEmptyStringSchema('Agent name is required', 'Agent name must be a string'),
  branch: optionalStringSchema('Branch must be a string', { unwrapQuotes: true }),
  message: nonEmptyStringSchema('Message is required', 'Message must be a string'),
  technical_details: z.unknown().optional()
});

const logAgentProgressBatchBodySchema = logAgentProgressBodySchema.extend({
  task_id: uuidFieldSchema('Task id must be a valid UUID')
});

const reportBlockerBodySchema = z.object({
  project_url: nonEmptyStringSchema('Project url is required', 'Project url is required', { unwrapQuotes: true }),
  task_id: uuidFieldSchema('Task id must be a valid UUID'),
  error_message: nonEmptyStringSchema('Error message is required', 'Error message must be a string'),
  // F6-2-T2: obligatorio en el servidor, como ya lo exigía el cliente.
  agent_name: nonEmptyStringSchema('Agent name is required', 'Agent name must be a string')
});

const heartbeatBodySchema = z.object({
  agent_name: optionalStringSchema('Agent name must be a string'),
  project_url: optionalStringSchema('Project url must be a string', { unwrapQuotes: true })
});

const heartbeatBatchBodySchema = heartbeatBodySchema.extend({
  task_id: uuidFieldSchema('Task id must be a valid UUID')
});

const backlogIdBodySchema = z.object({
  backlog_item_id: uuidFieldSchema('Backlog item id must be a valid UUID')
});

const semanticBugSearchBodySchema = z.object({
  url: nonEmptyStringSchema('Project url is required', 'Project url is required', { unwrapQuotes: true }),
  query_text: nonEmptyStringSchema('Query text is required', 'Query text must be a string'),
  // F6-2-T2: antes se aceptaba cualquier entero y la ruta lo recortaba en silencio,
  // mientras que el cliente lo rechazaba. Ahora rechazan los dos caminos.
  top_k: integerFieldSchema(`top_k must be an integer between 1 and ${MAX_SEMANTIC_SEARCH_TOP_K}`, {
    optional: true,
    min: 1,
    max: MAX_SEMANTIC_SEARCH_TOP_K
  }),
  threshold: numberFieldSchema('threshold must be a number between 0 and 1', { optional: true, min: 0, max: 1 }),
  include_closed: z.preprocess(
    (value) => {
      if (value === undefined) return undefined;
      if (typeof value === 'boolean') return value;
      if (typeof value === 'string') return parseBooleanFlag(value);
      return value;
    },
    z.boolean({ error: 'include_closed must be a boolean' }).optional()
  ),
  exclude_backlog_item_id: uuidFieldSchema('exclude_backlog_item_id must be a valid UUID', { optional: true, nullable: true })
});

const dashboardSemanticSearchBodySchema = z.object({
  query_text: nonEmptyStringSchema('Query text is required', 'Query text must be a string'),
  top_k: integerFieldSchema('top_k must be an integer between 1 and 20', { optional: true }),
  threshold: numberFieldSchema('threshold must be a number between 0 and 1', { optional: true, min: 0, max: 1 }),
  item_types: z.array(enumFieldSchema(BACKLOG_ITEM_TYPES, 'Invalid backlog item type', 'Invalid backlog item type')).optional(),
  statuses: z.array(enumFieldSchema(BACKLOG_STATUSES, 'Invalid backlog status', 'Invalid backlog status')).optional()
});

const enrichSemanticStatusWithPricing = async (semanticStatus) => {
  if (!semanticStatus?.embedding_model) {
    return semanticStatus;
  }

  try {
    const models = await fetchOpenRouterModels();
    const matchedModel = models.find((model) => model.id === semanticStatus.embedding_model) || null;
    const estimatedFullInputCost = estimateEmbeddingCost(semanticStatus.estimated_input_tokens, matchedModel?.prompt_price);
    const estimatedIncrementalInputCost = estimateEmbeddingCost(semanticStatus.estimated_incremental_input_tokens, matchedModel?.prompt_price);

    return {
      ...semanticStatus,
      pricing: matchedModel
        ? {
          prompt_price: matchedModel.prompt_price,
          completion_price: matchedModel.completion_price,
          context_length: matchedModel.context_length,
          estimated_input_cost: estimatedFullInputCost,
          estimated_full_input_cost: estimatedFullInputCost,
          estimated_incremental_input_cost: estimatedIncrementalInputCost
        }
        : {
          prompt_price: null,
          completion_price: null,
          context_length: null,
          estimated_input_cost: null,
          estimated_full_input_cost: null,
          estimated_incremental_input_cost: null
        }
    };
  } catch (_error) {
    return {
      ...semanticStatus,
      pricing: {
        prompt_price: null,
        completion_price: null,
        context_length: null,
        estimated_input_cost: null,
        estimated_full_input_cost: null,
        estimated_incremental_input_cost: null
      }
    };
  }
};

const resolveTaskBodySchema = z.object({
  instruction: nonEmptyStringSchema('Instruction is required', 'Instruction must be a string')
});

const backlogCreatePayloadSchema = z.object({
  title: nonEmptyStringSchema('Title is required', 'Title must be a string'),
  description: optionalNullableStringSchema('Description must be a string'),
  acceptance_criteria: optionalNullableStringSchema('Acceptance criteria must be a string'),
  item_type: enumFieldSchema(BACKLOG_ITEM_TYPES, 'Invalid backlog item type', 'Invalid backlog item type', { optional: true }),
  status: enumFieldSchema(BACKLOG_STATUSES, 'Invalid backlog status', 'Invalid backlog status', { optional: true }),
  priority: integerFieldSchema('Priority must be an integer', { optional: true }),
  sort_order: integerFieldSchema('Sort order must be an integer', { optional: true }),
  source_kind: optionalNullableStringSchema('Source kind must be a string'),
  source_ref: optionalNullableStringSchema('Source ref must be a string'),
  active_task_id: uuidFieldSchema('Active task id must be a valid UUID', { optional: true, nullable: true })
});

const backlogUpdatePayloadSchema = backlogCreatePayloadSchema.partial();

const normalizeCompactTextPart = (value) => {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim();
};

const buildCompactTextExcerpt = (parts, { limit = COMPACT_TEXT_EXCERPT_LIMIT } = {}) => {
  const mergedText = (Array.isArray(parts) ? parts : [parts])
    .map(normalizeCompactTextPart)
    .filter(Boolean)
    .join(' | ');

  if (!mergedText) return '';
  if (mergedText.length <= limit) return mergedText;
  return `${mergedText.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
};

const mapTaskRecord = (task, { view = DEFAULT_RESPONSE_VIEW } = {}) => {
  if (!task || view !== 'compact') return task;

  const context = normalizeCompactTextPart(task.context);

  return {
    id: task.id,
    project_url: task.project_url,
    title: task.title,
    agent_name: task.agent_name || null,
    status: task.status,
    last_heartbeat: task.last_heartbeat,
    created_at: task.created_at,
    updated_at: task.updated_at,
    context_excerpt: buildCompactTextExcerpt(context),
    has_context: Boolean(context)
  };
};

const mapAgentLogRecord = (log, { view = DEFAULT_RESPONSE_VIEW } = {}) => {
  if (!log || view !== 'compact') return log;

  return {
    id: log.id,
    task_id: log.task_id,
    action_type: log.action_type,
    agent_name: log.agent_name || null,
    branch: log.branch || null,
    created_at: log.created_at,
    updated_at: log.updated_at,
    message_excerpt: buildCompactTextExcerpt(log.message, { limit: 180 }),
    has_technical_details: parseBooleanFlag(log.has_technical_details)
  };
};

const mapBacklogItemRecord = (item, { view = DEFAULT_RESPONSE_VIEW } = {}) => {
  if (!item) return item;

  if (view === 'compact') {
    const description = normalizeCompactTextPart(item.description);
    const acceptanceCriteria = normalizeCompactTextPart(item.acceptance_criteria);
    const analysisSummary = normalizeCompactTextPart(item.llm_analysis_summary);

    return {
      id: item.id,
      project_url: item.project_url,
      title: item.title,
      item_type: item.item_type,
      status: item.status,
      priority: item.priority,
      sort_order: item.sort_order,
      source_kind: item.source_kind || null,
      source_ref: item.source_ref || null,
      active_task_id: item.active_task_id || null,
      created_at: item.created_at,
      updated_at: item.updated_at,
      deleted_at: item.deleted_at ?? null,
      text_excerpt: buildCompactTextExcerpt([description, acceptanceCriteria, analysisSummary]),
      has_description: Boolean(description),
      has_acceptance_criteria: Boolean(acceptanceCriteria),
      has_llm_analysis: Boolean(analysisSummary),
      llm_confidence: toNumberOrNull(item.llm_confidence),
      llm_recommendation_status: item.llm_recommendation_status || null
    };
  }

  const { bug_embedding: _bugEmbedding, ...safeItem } = item;

  return {
    ...safeItem,
    llm_missing_details: parseJsonArray(item.llm_missing_details),
    llm_confidence: toNumberOrNull(item.llm_confidence),
    bug_embedding_norm: toNumberOrNull(item.bug_embedding_norm)
  };
};

const cleanStringList = (values, { limit = 8 } = {}) => {
  if (!Array.isArray(values)) return [];

  return values
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean)
    .slice(0, limit);
};

const getConfigValue = async (key) => {
  const entry = await db('config').where({ key }).first();
  return entry?.value || null;
};

const setConfigValue = async (key, value) => {
  await db('config')
    .insert({
      key,
      value,
      updated_at: db.fn.now()
    })
    .onConflict('key')
    .merge({
      value,
      updated_at: db.fn.now()
    });
};

const getOpenRouterApiKey = () => {
  const apiKey = (process.env.OPENROUTER_API_KEY || '').trim();
  if (!apiKey) {
    const error = new Error('OPENROUTER_API_KEY is not configured in backend environment');
    error.statusCode = 503;
    throw error;
  }
  return apiKey;
};

const getEffectiveOpenRouterModel = async () => {
  const configuredModel = await getConfigValue(CONFIG_KEYS.openrouterModel);
  return configuredModel || DEFAULT_OPENROUTER_MODEL;
};

// La selección del modelo de embedding se fue con la implementación: ahora la
// resuelve `getEffectiveEmbeddingModel` de la librería, que lee la misma clave de
// configuración (`openrouter_embedding_model`) como respaldo de la estrategia.
// `CONFIG_KEYS.openrouterEmbeddingModel` y `DEFAULT_OPENROUTER_EMBEDDING_MODEL`
// siguen aquí porque los usa el panel para mostrar y guardar la configuración.

const getOpenRouterHeaders = () => {
  const headers = {
    Authorization: `Bearer ${getOpenRouterApiKey()}`,
    'Content-Type': 'application/json',
    'X-Title': 'APTS'
  };

  const referer = (process.env.PUBLIC_APP_URL || allowedOrigins[0] || '').trim();
  if (referer) {
    headers['HTTP-Referer'] = referer;
  }

  return headers;
};

const readOpenRouterResponse = async (response) => {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.error?.message || data?.message || `OpenRouter request failed with status ${response.status}`);
    error.statusCode = response.status;
    throw error;
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

const persistOpenRouterUsage = async ({
  usageType,
  model,
  usage,
  projectUrl = null,
  backlogItemId = null
}) => {
  if (!usage || typeof usage !== 'object') {
    return;
  }

  const normalizedUsageType = normalizeTextField(usageType) || 'unknown';
  const normalizedModel = normalizeTextField(model) || 'unknown';

  try {
    await db('openrouter_usage_logs').insert({
      usage_type: normalizedUsageType,
      model: normalizedModel,
      project_url: normalizeTextField(projectUrl) || null,
      backlog_item_id: backlogItemId || null,
      prompt_tokens: toNonNegativeInteger(usage.prompt_tokens),
      completion_tokens: toNonNegativeInteger(usage.completion_tokens),
      total_tokens: toNonNegativeInteger(usage.total_tokens),
      cost: toNonNegativeNumber(usage.cost),
      is_byok: typeof usage.is_byok === 'boolean' ? usage.is_byok : null,
      raw_usage: usage
    });
  } catch (error) {
    logger.warn({ error: error.message, usage_type: normalizedUsageType, model: normalizedModel }, 'Unable to persist OpenRouter usage');
  }
};

const normalizeUsageDate = (value) => {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  if (typeof value === 'string') {
    return value.slice(0, 10);
  }

  return '';
};

const getOpenRouterUsageSummary = async ({ days = 14 } = {}) => {
  const parsedDays = Number.parseInt(days, 10);
  const safeDays = Number.isFinite(parsedDays)
    ? Math.max(1, Math.min(90, parsedDays))
    : 14;

  const startDate = new Date();
  startDate.setUTCHours(0, 0, 0, 0);
  startDate.setUTCDate(startDate.getUTCDate() - (safeDays - 1));

  const rows = await db('openrouter_usage_logs')
    .where('created_at', '>=', startDate)
    .select(db.raw('DATE(created_at) AS usage_date'))
    .sum({ prompt_tokens: 'prompt_tokens' })
    .sum({ completion_tokens: 'completion_tokens' })
    .sum({ total_tokens: 'total_tokens' })
    .sum({ total_cost: 'cost' })
    .groupByRaw('DATE(created_at)')
    .orderBy('usage_date', 'asc');

  const byDate = new Map();
  for (const row of rows) {
    const usageDate = normalizeUsageDate(row.usage_date);
    if (!usageDate) continue;

    byDate.set(usageDate, {
      date: usageDate,
      prompt_tokens: toNonNegativeInteger(row.prompt_tokens),
      completion_tokens: toNonNegativeInteger(row.completion_tokens),
      total_tokens: toNonNegativeInteger(row.total_tokens),
      total_cost: toNonNegativeNumber(row.total_cost)
    });
  }

  const tokensByDay = [];
  for (let offset = safeDays - 1; offset >= 0; offset -= 1) {
    const day = new Date();
    day.setUTCHours(0, 0, 0, 0);
    day.setUTCDate(day.getUTCDate() - offset);
    const dateKey = day.toISOString().slice(0, 10);

    const existing = byDate.get(dateKey);
    tokensByDay.push(existing || {
      date: dateKey,
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      total_cost: 0
    });
  }

  const totals = tokensByDay.reduce((accumulator, row) => ({
    prompt_tokens: accumulator.prompt_tokens + row.prompt_tokens,
    completion_tokens: accumulator.completion_tokens + row.completion_tokens,
    total_tokens: accumulator.total_tokens + row.total_tokens,
    total_cost: accumulator.total_cost + row.total_cost
  }), {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    total_cost: 0
  });

  return {
    days: safeDays,
    tokens_by_day: tokensByDay,
    totals
  };
};

const fetchOpenRouterModels = async () => {
  let response;
  try {
    response = await fetch(OPENROUTER_MODELS_URL, {
      headers: getOpenRouterHeaders(),
      signal: AbortSignal.timeout(OPENROUTER_MODELS_TIMEOUT_MS)
    });
  } catch (error) {
    // Nombrar a OpenRouter no es cosmético: es lo que reconoce
    // isSemanticProviderError() para tratarlo como fallo del proveedor.
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new Error(`OpenRouter models request timed out after ${OPENROUTER_MODELS_TIMEOUT_MS} ms`);
    }
    throw error;
  }
  const data = await readOpenRouterResponse(response);

  return (data.data || [])
    .map((model) => ({
      id: model.id,
      name: model.name || model.id,
      description: model.description || '',
      context_length: model.context_length || null,
      prompt_price: toNumberOrNull(model.pricing?.prompt),
      completion_price: toNumberOrNull(model.pricing?.completion),
      is_free: String(model.id || '').includes(':free')
    }))
    .sort((left, right) => {
      const leftPrompt = left.prompt_price ?? Number.MAX_SAFE_INTEGER;
      const rightPrompt = right.prompt_price ?? Number.MAX_SAFE_INTEGER;
      if (leftPrompt !== rightPrompt) {
        return leftPrompt - rightPrompt;
      }

      const leftCompletion = left.completion_price ?? Number.MAX_SAFE_INTEGER;
      const rightCompletion = right.completion_price ?? Number.MAX_SAFE_INTEGER;
      return leftCompletion - rightCompletion;
    });
};

const parseEmbeddingVector = (value) => {
  const rawArray = parseJsonArray(value);
  if (!Array.isArray(rawArray) || rawArray.length === 0) return [];

  return rawArray
    .map((entry) => Number(entry))
    .filter((entry) => Number.isFinite(entry));
};

const vectorNorm = (vector) => Math.sqrt(vector.reduce((accumulator, value) => accumulator + (value * value), 0));

const cosineSimilarity = (left, right, leftNorm = null, rightNorm = null) => {
  if (!Array.isArray(left) || !Array.isArray(right)) return 0;
  if (left.length === 0 || right.length === 0) return 0;
  if (left.length !== right.length) return 0;

  const numerator = left.reduce((accumulator, leftValue, index) => accumulator + (leftValue * right[index]), 0);
  const denominator = (leftNorm ?? vectorNorm(left)) * (rightNorm ?? vectorNorm(right));

  if (!Number.isFinite(denominator) || denominator <= 0) {
    return 0;
  }

  return numerator / denominator;
};

const normalizeTextField = (value) => (typeof value === 'string' ? value.trim() : '');

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

// Antes esta función era una **segunda implementación** del embedding: su propio
// `fetch`, sus propias cabeceras, su propio plazo de espera y su propia lectura de
// la respuesta, todo copiado de `scripts/lib/semantic_embeddings.js`. Dos copias del
// mismo cálculo divergen en silencio: F6-2-T4 ya tuvo que poner el plazo dos veces,
// una en cada una. Ahora esto es sólo el envoltorio HTTP de la única implementación.
//
// La estrategia es `bug_dedup` —es la que alcanzan `search_similar_bug_reports` y el
// embedding de bug de create/update_backlog_item— y su resolución de modelo cae por
// `LEGACY_STRATEGY_MODEL_CONFIG` en `openrouter_embedding_model`, exactamente la
// clave de configuración que leía esta función. Mismo modelo, salvo que se configure
// a propósito `embedding_strategy:bug_dedup:model`.
//
// Lo que el envoltorio conserva, porque es de esta superficie y no de la librería:
// los códigos HTTP. La librería lanza errores pelados (500); aquí un texto de entrada
// vacío sigue siendo 400 y una respuesta sin vector sigue siendo 502.
const BUG_EMBEDDING_STRATEGY_KEY = 'bug_dedup';

const requestOpenRouterEmbedding = async (inputText, {
  usageType = 'embedding',
  projectUrl = null,
  backlogItemId = null
} = {}) => {
  const normalizedInput = normalizeTextField(inputText);
  if (!normalizedInput) {
    throw createHttpError(400, 'Embedding input text is required');
  }

  try {
    return await requestLibraryEmbedding(db, BUG_EMBEDDING_STRATEGY_KEY, normalizedInput, {
      usageType,
      projectUrl,
      backlogItemId
    });
  } catch (error) {
    // Único caso en que la librería y esta superficie difieren de veredicto: una
    // respuesta sin vector es un fallo del proveedor (502), no un 500. El resto de
    // errores —incluido el vencimiento del plazo, cuyo mensaje nombra a OpenRouter
    // para que isSemanticProviderError() lo reconozca— pasa tal cual.
    if (String(error?.message || '').includes('did not include a valid vector')) {
      throw createHttpError(502, 'OpenRouter embedding response did not include a valid vector', {
        cause: error
      });
    }
    throw error;
  }
};

const persistBugEmbeddingForBacklogItem = async (backlogItemId, { connection = db } = {}) => {
  const backlogItem = await connection('backlog_items')
    .where({ id: backlogItemId })
    .whereNull('deleted_at')
    .first();

  if (!backlogItem) {
    return { status: 'not_found', backlog_item_id: backlogItemId };
  }

  if (backlogItem.item_type !== 'bug') {
    await connection('backlog_items')
      .where({ id: backlogItemId })
      .update({
        bug_embedding: null,
        bug_embedding_model: null,
        bug_embedding_norm: null,
        bug_embedding_updated_at: null,
        updated_at: connection.fn.now()
      });
    return { status: 'cleared', backlog_item_id: backlogItemId };
  }

  const embeddingInput = buildBugEmbeddingText(backlogItem);
  if (!embeddingInput) {
    return { status: 'skipped', backlog_item_id: backlogItemId };
  }

  const embeddingResult = await requestOpenRouterEmbedding(embeddingInput, {
    usageType: 'bug_embedding',
    projectUrl: backlogItem.project_url,
    backlogItemId: backlogItem.id
  });

  await connection('backlog_items')
    .where({ id: backlogItemId })
    .update({
      bug_embedding: JSON.stringify(embeddingResult.embedding),
      bug_embedding_model: embeddingResult.model,
      bug_embedding_norm: embeddingResult.norm,
      bug_embedding_updated_at: connection.fn.now(),
      updated_at: connection.fn.now()
    });

  return {
    status: 'embedded',
    backlog_item_id: backlogItemId,
    model: embeddingResult.model
  };
};

const tryPersistBugEmbeddingForBacklogItem = async (backlogItemId, options = {}) => {
  try {
    return await persistBugEmbeddingForBacklogItem(backlogItemId, options);
  } catch (error) {
    logger.warn({ backlog_item_id: backlogItemId, error: error.message }, 'Unable to persist bug embedding');
    return { status: 'failed', backlog_item_id: backlogItemId, error: error.message };
  }
};

const backfillOpenBugEmbeddingsAtStartup = async () => {
  const [{ count: openBugCountRaw }] = await db('backlog_items')
    .where({ item_type: 'bug' })
    .whereNull('deleted_at')
    .whereIn('status', [...OPEN_BUG_BACKLOG_STATUSES])
    .count({ count: '*' });

  const openBugCount = Number(openBugCountRaw || 0);

  if (openBugCount > MAX_OPEN_BUGS_FOR_STARTUP_EMBEDDING) {
    return {
      skipped: true,
      reason: 'too_many_open_bugs',
      open_bug_count: openBugCount,
      max_open_bugs_for_startup_embedding: MAX_OPEN_BUGS_FOR_STARTUP_EMBEDDING,
      scanned: 0,
      embedded: 0,
      failed: 0
    };
  }

  const openBugsWithoutEmbedding = await db('backlog_items')
    .where({ item_type: 'bug' })
    .whereNull('deleted_at')
    .whereIn('status', [...OPEN_BUG_BACKLOG_STATUSES])
    .where((queryBuilder) => {
      queryBuilder.whereNull('bug_embedding').orWhere('bug_embedding', '');
    })
    .orderBy('updated_at', 'desc')
    .select('id');

  if (!openBugsWithoutEmbedding.length) {
    return {
      skipped: false,
      open_bug_count: openBugCount,
      scanned: 0,
      embedded: 0,
      failed: 0
    };
  }

  let embeddedCount = 0;
  let failedCount = 0;

  for (const backlogItem of openBugsWithoutEmbedding) {
    const result = await tryPersistBugEmbeddingForBacklogItem(backlogItem.id);
    if (result?.status === 'embedded') {
      embeddedCount += 1;
      continue;
    }

    if (result?.status === 'failed') {
      failedCount += 1;
    }
  }

  return {
    skipped: false,
    open_bug_count: openBugCount,
    scanned: openBugsWithoutEmbedding.length,
    embedded: embeddedCount,
    failed: failedCount
  };
};

const copyLegacySQLiteIntoPostgresAtStartup = async () => {
  if (db.client.config.client !== 'pg') {
    return { skipped: true, reason: 'current_client_is_not_postgres' };
  }

  const sqliteLegacyConfig = knexConfig.sqlite_legacy;
  if (!sqliteLegacyConfig || sqliteLegacyConfig.client !== 'better-sqlite3') {
    return { skipped: true, reason: 'sqlite_legacy_config_missing' };
  }

  const sqliteLegacyFilePath = sqliteLegacyConfig.connection?.filename;
  if (!sqliteLegacyFilePath) {
    return { skipped: true, reason: 'sqlite_legacy_file_missing' };
  }

  const sqliteFileExists = await fs.access(sqliteLegacyFilePath)
    .then(() => true)
    .catch(() => false);

  if (!sqliteFileExists) {
    return { skipped: true, reason: 'sqlite_legacy_file_not_found', file_path: sqliteLegacyFilePath };
  }

  const sqliteLegacyDb = createKnex(sqliteLegacyConfig);

  try {
    await sqliteLegacyDb.raw('select 1');

    const sourceCounts = {};
    let totalRows = 0;

    for (const table of SQLITE_LEGACY_TABLES) {
      const [{ count }] = await sqliteLegacyDb(table.name).count({ count: '*' });
      const parsedCount = Number(count || 0);
      sourceCounts[table.name] = parsedCount;
      totalRows += parsedCount;
    }

    if (totalRows === 0) {
      await sqliteLegacyDb.destroy();
      await fs.unlink(sqliteLegacyFilePath).catch(() => { });

      return {
        skipped: true,
        reason: 'sqlite_legacy_empty',
        file_removed: true,
        file_path: sqliteLegacyFilePath,
        source_counts: sourceCounts
      };
    }

    await db.transaction(async (transaction) => {
      for (const table of SQLITE_LEGACY_TABLES) {
        const rows = await sqliteLegacyDb(table.name).select('*');
        if (!rows.length) {
          continue;
        }

        const normalizedRows = rows.map((row) => normalizeSqliteLegacyRow(table.name, row));
        const chunks = chunkArray(normalizedRows, SQLITE_LEGACY_BATCH_SIZE);

        for (const chunk of chunks) {
          await transaction(table.name)
            .insert(chunk)
            .onConflict(table.primaryKey)
            .merge();
        }
      }
    });

    const syncedSequences = await syncPostgresAutoIncrementSequences(db, POSTGRES_AUTOINCREMENT_TABLES);

    await sqliteLegacyDb.destroy();
    const removedLegacyFile = await fs.unlink(sqliteLegacyFilePath)
      .then(() => true)
      .catch((unlinkError) => {
        logger.warn({ file_path: sqliteLegacyFilePath, error: unlinkError.message }, 'Unable to delete sqlite legacy file after successful migration');
        return false;
      });

    return {
      skipped: false,
      migrated: true,
      file_removed: removedLegacyFile,
      file_path: sqliteLegacyFilePath,
      source_counts: sourceCounts,
      synced_sequences: syncedSequences
    };
  } catch (error) {
    await sqliteLegacyDb.destroy();
    throw error;
  }
};

const extractJsonObject = (value) => {
  if (typeof value !== 'string') {
    throw new Error('OpenRouter returned an empty analysis payload');
  }

  const trimmed = value.trim();
  const withoutCodeFence = trimmed.startsWith('```')
    ? trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim()
    : trimmed;
  const firstBrace = withoutCodeFence.indexOf('{');
  const lastBrace = withoutCodeFence.lastIndexOf('}');
  const candidate = firstBrace >= 0 && lastBrace >= 0
    ? withoutCodeFence.slice(firstBrace, lastBrace + 1)
    : withoutCodeFence;

  return JSON.parse(candidate);
};

const normalizeBacklogAnalysis = (analysis) => {
  const recommendedStatus = analysis?.recommended_status === 'needs_details'
    ? 'needs_details'
    : 'ready';
  const confidence = Math.max(0, Math.min(1, toNumberOrNull(analysis?.confidence) ?? 0.5));
  const summary = typeof analysis?.summary === 'string' ? analysis.summary.trim() : '';

  return {
    recommended_status: recommendedStatus,
    confidence,
    summary: summary || (recommendedStatus === 'ready'
      ? 'El item tiene suficiente detalle para entrar al flujo operativo.'
      : 'El item necesita más definición antes de ejecutarse.'),
    missing_details: cleanStringList(analysis?.missing_details)
  };
};

const buildBacklogAnalysisMessages = (backlogItem) => ([
  {
    role: 'system',
    content: [
      'Eres un triager de backlog para APTS.',
      'Clasifica cada item en uno de dos estados: ready o needs_details.',
      'Usa ready solo si hay suficiente detalle para priorizar o implementar sin pedir información esencial adicional.',
      'Usa needs_details si faltan datos funcionales, alcance, restricciones, dependencias, actores o criterios de aceptación.',
      'Responde únicamente JSON válido con estas claves: recommended_status, confidence, summary, missing_details.',
      'confidence debe ser un número entre 0 y 1.',
      'missing_details debe ser un array de strings cortos y accionables.'
    ].join(' ')
  },
  {
    role: 'user',
    content: JSON.stringify({
      title: backlogItem.title,
      description: backlogItem.description || '',
      acceptance_criteria: backlogItem.acceptance_criteria || '',
      item_type: backlogItem.item_type,
      current_status: backlogItem.status,
      source_kind: backlogItem.source_kind || null,
      source_ref: backlogItem.source_ref || null
    })
  }
]);

const requestBacklogAnalysis = async (backlogItem) => {
  const model = await getEffectiveOpenRouterModel();
  let response;
  try {
    response = await fetch(OPENROUTER_CHAT_URL, {
      method: 'POST',
      headers: getOpenRouterHeaders(),
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: buildBacklogAnalysisMessages(backlogItem)
      }),
      // Plazo largo a propósito: esto es una generación de un modelo de lenguaje, no
      // una lectura. Corta lo que se ha colgado, sin cortar lo que sólo va lento.
      signal: AbortSignal.timeout(OPENROUTER_CHAT_TIMEOUT_MS)
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new Error(`OpenRouter chat request timed out after ${OPENROUTER_CHAT_TIMEOUT_MS} ms`);
    }
    throw error;
  }
  const data = await readOpenRouterResponse(response);
  await persistOpenRouterUsage({
    usageType: 'backlog_analysis',
    model,
    usage: data?.usage,
    projectUrl: backlogItem.project_url,
    backlogItemId: backlogItem.id
  });
  const content = data?.choices?.[0]?.message?.content;
  const analysis = normalizeBacklogAnalysis(extractJsonObject(Array.isArray(content)
    ? content.map((chunk) => chunk?.text || '').join('')
    : content));

  return {
    ...analysis,
    model
  };
};

const persistBacklogAnalysis = async (backlogItem) => {
  const analysis = await requestBacklogAnalysis(backlogItem);
  const nextStatus = AUTO_TRIAGE_BACKLOG_STATUSES.has(backlogItem.status)
    ? analysis.recommended_status
    : backlogItem.status;

  const [updatedBacklogItem] = await db('backlog_items')
    .where({ id: backlogItem.id })
    .update({
      status: nextStatus,
      llm_analysis_model: analysis.model,
      llm_analysis_summary: analysis.summary,
      llm_missing_details: JSON.stringify(analysis.missing_details),
      llm_confidence: analysis.confidence,
      llm_recommendation_status: analysis.recommended_status,
      llm_last_analyzed_at: db.fn.now(),
      updated_at: db.fn.now()
    })
    .returning('*');

  return mapBacklogItemRecord(updatedBacklogItem);
};

const normalizeUrl = (url) => {
  if (!url) return '';
  let cleanUrl = url.trim();
  if (cleanUrl.startsWith('git@')) {
    cleanUrl = cleanUrl.replace(':', '/').replace('git@', 'https://');
  }
  if (cleanUrl.endsWith('.git')) {
    cleanUrl = cleanUrl.slice(0, -4);
  }
  return cleanUrl;
};

const ensureProjectExists = async (url, { connection = db } = {}) => {
  await connection('projects').insert({ url, name: url.split('/').pop() })
    .onConflict('url').merge();
};

const parseJsonObjectOrEmpty = (value) => {
  if (typeof value !== 'string') return {};

  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    return parsed;
  } catch (_error) {
    return {};
  }
};

const normalizeProjectConstraints = (input) => {
  const constraints = input && typeof input === 'object' && !Array.isArray(input)
    ? input
    : {};

  return {
    test_command: normalizeInputString(constraints.test_command, { unwrapQuotes: true }) || null,
    lint_command: normalizeInputString(constraints.lint_command, { unwrapQuotes: true }) || null,
    typecheck_command: normalizeInputString(constraints.typecheck_command, { unwrapQuotes: true }) || null,
    framework: normalizeInputString(constraints.framework, { unwrapQuotes: true }) || null,
    language: normalizeInputString(constraints.language, { unwrapQuotes: true }) || null,
    conventions: normalizeInputString(constraints.conventions) || null
  };
};

const getProjectConstraints = async (projectUrl, { connection = db } = {}) => {
  const project = await connection('projects').where({ url: projectUrl }).first();
  if (!project) {
    throw createHttpError(404, 'Project not found');
  }

  const constraintsConfigKey = `${PROJECT_CONSTRAINTS_CONFIG_PREFIX}${projectUrl}`;
  const hasConfigTable = await connection.schema.hasTable('config');
  const constraintsConfig = hasConfigTable
    ? await connection('config')
      .where({ key: constraintsConfigKey })
      .first()
    : null;

  const projectDescriptionConstraints = parseJsonObjectOrEmpty(project.description);
  const configuredConstraints = parseJsonObjectOrEmpty(constraintsConfig?.value);

  return {
    project_url: projectUrl,
    ...normalizeProjectConstraints({
      ...projectDescriptionConstraints,
      ...configuredConstraints
    })
  };
};

const listBacklogItems = async (
  projectUrl,
  status,
  {
    includeDeleted = false,
    view = DEFAULT_RESPONSE_VIEW,
    id = null,
    ids = [],
    limit,
    offset,
    connection = db
  } = {}
) => {
  const query = connection('backlog_items')
    .where({ project_url: projectUrl })
    .orderBy([
      { column: 'priority', order: 'asc' },
      { column: 'sort_order', order: 'asc' },
      { column: 'created_at', order: 'asc' }
    ]);

  if (!includeDeleted) {
    query.whereNull('deleted_at');
  }

  if (status) {
    query.andWhere({ status });
  }

  if (id) {
    query.andWhere({ id });
  }

  if (Array.isArray(ids) && ids.length) {
    query.whereIn('id', ids);
  }

  if (typeof offset === 'number') {
    query.offset(offset);
  }

  if (typeof limit === 'number') {
    query.limit(limit);
  }

  const items = view === 'compact'
    ? await query.select(BACKLOG_COMPACT_SELECT_COLUMNS)
    : await query.select('*');

  return items.map((item) => mapBacklogItemRecord(item, { view }));
};

const listProjectsSummary = async ({ connection = db } = {}) => {
  const [projects, backlogNeedsDetails] = await Promise.all([
    connection('projects').select('*').orderBy('updated_at', 'desc'),
    connection('backlog_items')
      .select('project_url')
      .count({ needs_details_count: '*' })
      .where({ status: 'needs_details' })
      .whereNull('deleted_at')
      .groupBy('project_url')
  ]);

  const needsDetailsByProject = new Map(
    backlogNeedsDetails.map((row) => [row.project_url, Number.parseInt(row.needs_details_count, 10) || 0])
  );

  return projects.map((project) => {
    const needsDetailsCount = needsDetailsByProject.get(project.url) || 0;

    return {
      ...project,
      needs_details_count: needsDetailsCount,
      has_needs_details: needsDetailsCount > 0
    };
  });
};

const searchSimilarBugReports = async ({
  projectUrl,
  queryText,
  topK = DEFAULT_SEMANTIC_SEARCH_TOP_K,
  threshold = DEFAULT_SEMANTIC_SEARCH_THRESHOLD,
  includeClosed = false,
  excludeBacklogItemId = null
}) => {
  const normalizedProjectUrl = normalizeUrl(projectUrl);
  if (!normalizedProjectUrl) {
    throw createHttpError(400, 'Project url is required');
  }

  const embeddingResult = await requestOpenRouterEmbedding(queryText, {
    usageType: 'semantic_search_embedding',
    projectUrl: normalizedProjectUrl
  });

  const candidateQuery = db('backlog_items')
    .where({ project_url: normalizedProjectUrl, item_type: 'bug' })
    .whereNull('deleted_at')
    .whereNotNull('bug_embedding')
    .orderBy('updated_at', 'desc');

  if (!includeClosed) {
    candidateQuery.whereIn('status', [...OPEN_BUG_BACKLOG_STATUSES]);
  }

  if (excludeBacklogItemId) {
    candidateQuery.whereNot({ id: excludeBacklogItemId });
  }

  const candidates = await candidateQuery.select('*');

  const matches = candidates
    .map((candidate) => {
      const candidateEmbedding = parseEmbeddingVector(candidate.bug_embedding);
      const similarityScore = cosineSimilarity(
        embeddingResult.embedding,
        candidateEmbedding,
        embeddingResult.norm,
        toNumberOrNull(candidate.bug_embedding_norm)
      );

      if (!Number.isFinite(similarityScore)) {
        return null;
      }

      return {
        similarity_score: Math.max(0, Math.min(1, similarityScore)),
        backlog_item: mapBacklogItemRecord(candidate)
      };
    })
    .filter(Boolean)
    .filter((match) => match.similarity_score >= threshold)
    .sort((left, right) => right.similarity_score - left.similarity_score)
    .slice(0, topK);

  return {
    model: embeddingResult.model,
    threshold,
    top_k: topK,
    candidates_scanned: candidates.length,
    matches
  };
};

const getBacklogPayload = (body, { partial = false } = {}) => {
  const requestBody = body && typeof body === 'object' ? body : {};
  const schema = partial ? backlogUpdatePayloadSchema : backlogCreatePayloadSchema;
  const parsed = schema.safeParse(requestBody);

  if (!parsed.success) {
    return { error: zodErrorMessage(parsed.error) };
  }

  return { payload: parsed.data };
};

const mapTaskStatusToBacklogStatus = (status) => {
  const mapping = {
    todo: 'ready',
    in_progress: 'in_progress',
    review: 'review',
    done: 'done',
    stalled: 'blocked'
  };

  return mapping[status];
};

const integrationRoot = path.join(__dirname, '..', 'integracion');
// Schema version of the public integration manifest. Append-only history (do not rewrite past notes):
// - 3.0.0: reset baseline (MCP-only surface; no prior release-notes history kept).
// - 3.1.0: additive — publishes the `method_orchestrator_agent` template (BMAD method engine driven
//   from a client spec via create_initiative/set_agent_role + apts_next conduction). No artifact was
//   removed or changed shape; only a new optional agent template was added.
// - 3.2.0: additive — publishes `mcp_endpoint`, the remote MCP surface (Streamable HTTP, stateless),
//   with the per-runtime registration block as data so a client can register the server without
//   downloading any file. The four stdio artifacts (mcp_server, js_client, contract_check,
//   package_manifest) are flagged deprecated but keep being served unchanged, and their
//   `recommended` flags are untouched: a client on 3.1.0 ignores the new fields and still gets a
//   working surface. No artifact was removed or changed shape.
// - 3.3.0: content fix — the `skills_json` contract stated in 16 of its 21 tool descriptions that
//   identity "auto-resolves from env/local managed context/Git when omitted". That is false for the
//   remote surface, where identity comes from the registration headers and task_id/branch travel in
//   the call. Descriptions rewritten in neutral terms ("the integration layer supplies …"); no
//   operation, schema, or verdict changed. `skills_json.artifact_version` goes 3.0.0 -> 3.3.0 so
//   already-integrated clients pick the fix up through the existing sync policy (compare by
//   artifact_version -> overwrite). Manifest shape is unchanged; a client on 3.1.0 or 3.2.0 keeps a
//   working surface.
// - 3.4.0: content fix — the method roster was not discoverable through any of the 21 operations, so
//   the only way to learn the valid `entity_key` values was to call `set_agent_role` with an invented
//   one and read them off the rejection. `create_initiative` now returns `roster.entity_keys` (both on
//   creation and on resume) and `apts_next` attaches the same roster when the caller has no pointer
//   yet — the one blocked state whose exit is registering a role. Two `skills_json` descriptions say
//   so. Nothing else changed: same 21 operations, same parameters, same verdicts, and the rejection
//   still enumerates the keys as a last resort. `skills_json.artifact_version` goes 3.3.0 -> 3.4.0 so
//   already-integrated clients pick it up through the existing sync policy. Response payloads only
//   grew a field, which JSON consumers ignore: a client on 3.1.0, 3.2.0 or 3.3.0 keeps working.
// - 4.0.0: BREAKING, and deliberately so — decided by the operator, who does not want backward
//   compatibility to keep shaping this manifest. Every block that existed to explain how to install
//   and keep in sync the four downloadable executables is gone: `client_download_guidance`,
//   `artifact_sync_policy` (with its `updater_contract` and `legacy_cleanup_targets`),
//   `official_integration_script_policy`, `ai_agent_recommended_usage` and `opencode_ai_guidance`,
//   plus the first steps and instructions that walked through installing them. An updater built
//   against 3.x that reads `bootstrap.artifact_sync_policy` will not find it. **The thirteen
//   artifacts and their download routes are untouched and keep being served**, so the stdio surface
//   still works for anyone who already has it or fetches it by route; what disappeared is the recipe,
//   not the files.
//   Two things were fixed in the same pass, because they were false for the remote surface and no
//   one had corrected them here: three `instructions[]` entries and all of `identity_requirements`
//   still claimed the MCP server auto-fills identity from env vars, `.apts/execution-context.json`
//   or Git. That is the same claim F6-3 removed from the adapters and F6-4 from the contract.
//   Cost: the manifest goes from 11.034 to 8.790 text units per integration.
//   Folded into this same 4.0.0 because it was never deployed (the append-only history below 4.0.0
//   is untouched; no client ever saw a 4.0.0 without these):
//   (a) `method_conduction` is published as a new top-level field, sibling of `mcp_endpoint`. It
//   carries the engine half of the BMAD conduction loop that until now only existed as prose inside
//   the downloadable `method_orchestrator_agent` template: bootstrap + roster, role switching, the
//   drive loop dispatch, the generative step rule, and the dev-story completion rule (dev-story is
//   multi-step and does not auto-release; a story left at `review` is never `done`). The client half
//   —agent wrapper, tool list, worker delegation, resilience log, retry policy, report format— was
//   deliberately left in the template. This does NOT save tokens: it moves ~1.6k units from the
//   download to the manifest. What it buys is closing "zero downloads" and making it impossible for
//   the loop to drift from the engine. `method_orchestrator_agent` is flagged deprecated with
//   `replacedBy: method_conduction` and keeps being served unchanged.
//   (b) the four stdio artifacts (`mcp_server`, `js_client`, `contract_check`, `package_manifest`)
//   leave `artifacts[]`: 1.410 units of metadata describing a path 4.0.0 already broke with. Their
//   four routes keep answering 200 and are published in short form under the new
//   `legacy_download_routes`, so they stay discoverable instead of merely alive. `mcp_server`'s
//   `recommended: true` goes with the entry — it was kept through 3.4.0 so a 3.1.0 client would
//   still find a working surface, and recommending the dead path contradicts this release.
//   `adapter_generator` drops `contract_check` from `depends_on_artifact_ids`: the check runs inside
//   the backend at startup, it was never an input to the generator, and leaving it would point at an
//   id this manifest no longer publishes.
//   Net cost of 4.0.0 as shipped: 11.034 -> ~9.100 text units per integration.
const integrationManifestSchemaVersion = '4.0.0';
const publicIntegrationBasePath = '/api/public/integrar';

const integrationArtifacts = {
  skills_json: {
    route: `${publicIntegrationBasePath}/skills.json`,
    filePath: path.join(integrationRoot, 'paquete-apts', 'apts_skills.json'),
    fileName: 'apts_skills.json',
    contentType: 'application/json; charset=utf-8',
    // 3.3.0: descripciones reescritas en términos neutros (ya no afirman resolución automática de
    // identidad). 3.4.0: `create_initiative` y `set_agent_role` dicen de dónde salen las claves de
    // rol, que antes solo se aprendían leyendo un rechazo. Sube la versión para que la política de
    // sincronización propague la corrección.
    artifactVersion: '3.4.0',
    updatedInSchemaVersion: '3.4.0',
    kind: 'skills_contract',
    recommended: true,
    usagePriority: 'discovery',
    syncAction: 'overwrite',
    deprecatedFilenames: [],
    description: 'Machine-readable tool contract for APTS integration.'
  },
  skill_markdown: {
    route: `${publicIntegrationBasePath}/skill.md`,
    filePath: path.join(integrationRoot, 'paquete-apts', 'SKILL.md'),
    fileName: 'SKILL.md',
    contentType: 'text/markdown; charset=utf-8',
    artifactVersion: '3.0.0',
    updatedInSchemaVersion: '3.0.0',
    kind: 'skill_package',
    recommended: false,
    usagePriority: 'discovery',
    syncAction: 'overwrite',
    deprecatedFilenames: [],
    description: 'Copilot skill packaging guide for APTS integration.'
  },
  agent_guidelines: {
    route: `${publicIntegrationBasePath}/agent-guidelines.md`,
    filePath: path.join(integrationRoot, 'paquete-apts', 'apts-agent-guidelines.md'),
    fileName: 'apts-agent-guidelines.md',
    contentType: 'text/markdown; charset=utf-8',
    artifactVersion: '3.0.0',
    updatedInSchemaVersion: '3.0.0',
    kind: 'agent_guidelines',
    recommended: true,
    usagePriority: 'discovery',
    syncAction: 'overwrite',
    deprecatedFilenames: [],
    description: 'Base operating rules for any agent that reports work to APTS.'
  },
  intake_bugfix_agent: {
    route: `${publicIntegrationBasePath}/agentes/intake-bugfix-apts.agent.md`,
    filePath: path.join(integrationRoot, 'plantillas-agentes', 'intake-bugfix-apts.agent.md'),
    fileName: 'intake-bugfix-apts.agent.md',
    contentType: 'text/markdown; charset=utf-8',
    artifactVersion: '3.0.0',
    updatedInSchemaVersion: '3.0.0',
    kind: 'agent_template',
    recommended: false,
    usagePriority: 'optional_entrypoint',
    syncAction: 'overwrite',
    deprecatedFilenames: [],
    description: 'Bugfix intake agent template for read-only triage and tracked bug registration.'
  },
  executor_agent: {
    route: `${publicIntegrationBasePath}/agentes/ejecutor-item-backlog-dev-test-commit.agent.md`,
    filePath: path.join(integrationRoot, 'plantillas-agentes', 'ejecutor-item-backlog-dev-test-commit.agent.md'),
    fileName: 'ejecutor-item-backlog-dev-test-commit.agent.md',
    contentType: 'text/markdown; charset=utf-8',
    artifactVersion: '3.0.0',
    updatedInSchemaVersion: '3.0.0',
    kind: 'agent_template',
    recommended: false,
    usagePriority: 'worker',
    syncAction: 'overwrite',
    deprecatedFilenames: [
      'ejecutor-dev-test-commit.agent.md'
    ],
    description: 'Worker agent template for one backlog item end-to-end.'
  },
  orchestrator_agent: {
    route: `${publicIntegrationBasePath}/agentes/orquestador-backlog-apts.agent.md`,
    filePath: path.join(integrationRoot, 'plantillas-agentes', 'orquestador-backlog-apts.agent.md'),
    fileName: 'orquestador-backlog-apts.agent.md',
    contentType: 'text/markdown; charset=utf-8',
    artifactVersion: '3.0.0',
    updatedInSchemaVersion: '3.0.0',
    kind: 'agent_template',
    recommended: false,
    usagePriority: 'entrypoint',
    syncAction: 'overwrite',
    deprecatedFilenames: [
      'orquestador.agent.md',
      'orquestador-agent.md'
    ],
    description: 'Orchestrator agent template that pulls ready backlog items from APTS.'
  },
  method_orchestrator_agent: {
    route: `${publicIntegrationBasePath}/agentes/apts-method-orchestrator.agent.md`,
    filePath: path.join(integrationRoot, 'plantillas-agentes', 'apts-method-orchestrator.agent.md'),
    fileName: 'apts-method-orchestrator.agent.md',
    contentType: 'text/markdown; charset=utf-8',
    artifactVersion: '3.1.0',
    updatedInSchemaVersion: '3.1.0',
    kind: 'agent_template',
    recommended: false,
    usagePriority: 'entrypoint',
    syncAction: 'overwrite',
    deprecatedFilenames: [],
    deprecated: true,
    deprecatedInSchemaVersion: '4.0.0',
    replacedBy: 'method_conduction',
    deprecationReason: 'The conduction loop it carried as prose is now published as data in method_conduction, where it cannot drift from the engine that serves it. Still served unchanged for runtimes that want the agent wrapper (frontmatter, tool list, worker delegation, report format), which is the part that was deliberately not moved.',
    description: 'Method orchestrator agent template that bootstraps a BMAD initiative and conducts the analysis→…→done lifecycle from a client spec.'
  },
  mcp_server: {
    route: `${publicIntegrationBasePath}/apts-mcp.js`,
    filePath: path.join(integrationRoot, 'paquete-apts', 'apts-mcp.js'),
    fileName: 'apts-mcp.js',
    contentType: 'application/javascript; charset=utf-8',
    artifactVersion: '3.0.0',
    updatedInSchemaVersion: '3.0.0',
    kind: 'reference_mcp_server',
    // 4.0.0: fuera del listado publicado. La definición se queda porque de aquí
    // sale la ruta que se sigue sirviendo; lo que desaparece es su entrada en
    // `artifacts[]`. Con ella se va su `recommended: true`, que hasta 3.4.0 se
    // dejaba a propósito para que un cliente 3.1.0 conservara superficie:
    // recomendar el camino obsoleto contradice la ruptura de 4.0.0.
    listed: false,
    recommended: true,
    usagePriority: 'primary',
    optional: false,
    syncAction: 'overwrite',
    deprecatedFilenames: ['apts-cli.js', 'apts-cli.mjs'],
    dependsOnArtifactIds: ['js_client', 'contract_check'],
    module_system: 'esm',
    deprecated: true,
    deprecatedInSchemaVersion: '3.2.0',
    replacedBy: 'mcp_endpoint',
    deprecationReason: 'Superseded by the remote MCP endpoint published in mcp_endpoint, which needs no download. Still served unchanged for clients already on it; recommended is deliberately left as it was so 3.1.0 clients keep a working surface.',
    selection_rule: 'Only supported integration surface. Zero-dependency stdio JSON-RPC MCP server that exposes one tool per contract operation. Register it in .mcp.json (Claude Code) or opencode.json (opencode), both pointing at this file run with node. If the runtime cannot register an MCP server, resolve the runtime setup with the operator; there is no alternative script surface.',
    description: 'Official MCP (stdio) server for APTS; the cross-runtime integration surface for Claude Code and opencode.'
  },
  js_client: {
    route: `${publicIntegrationBasePath}/apts-client.js`,
    filePath: path.join(integrationRoot, 'paquete-apts', 'apts-client.js'),
    fileName: 'apts-client.js',
    contentType: 'application/javascript; charset=utf-8',
    artifactVersion: '3.0.0',
    updatedInSchemaVersion: '3.0.0',
    kind: 'reference_client',
    listed: false,
    recommended: false,
    usagePriority: 'internal_dependency',
    optional: true,
    syncAction: 'overwrite',
    deprecatedFilenames: ['apts-client.mjs', 'apts-helper.js', 'apts-helper.mjs'],
    module_system: 'esm',
    deprecated: true,
    deprecatedInSchemaVersion: '3.2.0',
    replacedBy: 'mcp_endpoint',
    deprecationReason: 'Internal dependency of the deprecated stdio server. The remote endpoint executes in the backend process and no longer goes through this client. Still served unchanged.',
    selection_rule: 'Single ESM HTTP client (named exports). It is an internal dependency of the MCP server, executed as a Node subprocess rather than imported by the host project. The former CommonJS/ESM twins and the standalone helper were retired in 2.1.0.',
    description: 'Official ESM-only JavaScript HTTP client for APTS (internal dependency of the MCP server).'
  },
  contract_check: {
    route: `${publicIntegrationBasePath}/contract-check.js`,
    filePath: path.join(integrationRoot, 'paquete-apts', 'contract-check.js'),
    fileName: 'contract-check.js',
    contentType: 'application/javascript; charset=utf-8',
    artifactVersion: '3.0.0',
    updatedInSchemaVersion: '3.0.0',
    kind: 'reference_contract_check',
    listed: false,
    recommended: false,
    usagePriority: 'internal_dependency',
    optional: true,
    syncAction: 'overwrite',
    deprecatedFilenames: [],
    module_system: 'esm',
    deprecated: true,
    deprecatedInSchemaVersion: '3.2.0',
    replacedBy: 'mcp_endpoint',
    deprecationReason: 'The same check now runs inside the backend at startup, so the remote surface cannot drift from the contract. Still served unchanged for clients that keep the downloadable stdio server.',
    selection_rule: 'Startup self-check used by the MCP server to verify that the client and the MCP tool list stay aligned with apts_skills.json (19 operations). Install it beside apts-mcp.js.',
    description: 'Contract self-check that validates client/MCP alignment with apts_skills.json.'
  },
  package_manifest: {
    route: `${publicIntegrationBasePath}/package.json`,
    filePath: path.join(integrationRoot, 'paquete-apts', 'package.json'),
    fileName: 'package.json',
    contentType: 'application/json; charset=utf-8',
    artifactVersion: '3.0.0',
    updatedInSchemaVersion: '3.0.0',
    kind: 'package_manifest',
    listed: false,
    recommended: false,
    usagePriority: 'internal_dependency',
    optional: true,
    syncAction: 'overwrite',
    deprecatedFilenames: [],
    deprecated: true,
    deprecatedInSchemaVersion: '3.2.0',
    replacedBy: 'mcp_endpoint',
    deprecationReason: 'Only needed to make the downloadable scripts run as ES modules. A remote registration downloads no scripts. Still served unchanged.',
    selection_rule: 'Marks the workspace-local APTS folder as ESM ({ "type": "module" }) and declares the apts-mcp bin. Install it alongside the scripts so Node treats them as ES modules.',
    description: 'ESM package manifest ({ type: module }) for the workspace-local APTS scripts.'
  },
  surface_spec: {
    route: `${publicIntegrationBasePath}/runtime-adapters/spec/apts-surface.json`,
    filePath: path.join(integrationRoot, 'paquete-apts', 'runtime-adapters', 'spec', 'apts-surface.json'),
    fileName: 'apts-surface.json',
    contentType: 'application/json; charset=utf-8',
    artifactVersion: '3.0.0',
    updatedInSchemaVersion: '3.0.0',
    kind: 'runtime_surface_spec',
    recommended: true,
    usagePriority: 'discovery',
    optional: false,
    syncAction: 'overwrite',
    deprecatedFilenames: [],
    selection_rule: 'Single source of the agent surface (agents, commands, permissions, unified instructions, hooks). Feed it to generate-adapters.js to materialize the per-runtime adapters locally; never hand-edit the generated adapters.',
    description: 'Single runtime-surface spec; input to the adapter generator.'
  },
  adapter_generator: {
    route: `${publicIntegrationBasePath}/scripts/generate-adapters.js`,
    filePath: path.join(integrationRoot, 'paquete-apts', 'scripts', 'generate-adapters.js'),
    fileName: 'generate-adapters.js',
    contentType: 'application/javascript; charset=utf-8',
    artifactVersion: '3.0.0',
    updatedInSchemaVersion: '3.0.0',
    kind: 'adapter_generator',
    recommended: true,
    usagePriority: 'primary',
    optional: false,
    syncAction: 'overwrite',
    deprecatedFilenames: ['intake-bugfix-apts.agent.md'],
    // 4.0.0: `contract_check` sale de esta dependencia. El generador lee la spec
    // y emite adaptadores; la comprobación de contrato corre ya dentro del
    // backend al arrancar, así que no era una entrada del generador — y dejarla
    // apuntaría a un id que este manifiesto ya no publica.
    dependsOnArtifactIds: ['surface_spec'],
    module_system: 'esm',
    selection_rule: 'Idempotent generator that reads apts-surface.json and emits runtime-adapters/{claude,opencode,vscode}/. Run it locally to (re)generate adapters; the generated files are managed and must not be hand-edited. It renames the former intake adapter intake-bugfix-apts.agent.md to apts-bugfix-intake.agent.md.',
    description: 'Idempotent generator that emits the per-runtime adapters from the surface spec.'
  }
};

const buildAbsoluteUrl = (req, route) => `${req.protocol}://${req.get('host')}${route}`;

// --- Registro del MCP remoto (F6-3-T1) -------------------------------------
//
// Se publica como DATO, por programa cliente: un cliente puede registrar el
// servidor copiando `config` en `config_file`, sin descargar ningún archivo.
// Las tres cabeceras de identidad son parte del registro, no un extra: sustituyen
// a la resolución automática que hacía el script local (decisión #1). Sin ellas el
// cliente remoto se queda sin identidad y la superficie queda peor que la actual.
//
// La URL se deriva del host de la petición, igual que `api_base_url`, porque `/mcp`
// vive fuera del árbol `/api` y no puede componerse a partir de él (decisión A1 de F6-3).
const MCP_IDENTITY_HEADER_SPEC = [
  { header: 'Authorization', purpose: 'access_key', env: 'APTS_API_KEY', scheme: 'Bearer' },
  { header: 'X-APTS-Project-Url', purpose: 'identity', field: 'project_url', env: 'APTS_PROJECT_URL' },
  { header: 'X-APTS-Agent-Name', purpose: 'identity', field: 'agent_name', env: 'APTS_AGENT_NAME' },
  { header: 'X-APTS-Agent-Email', purpose: 'identity', field: 'agent_email', env: 'APTS_AGENT_EMAIL' }
];

// Cada programa cliente tiene su propio archivo, su propia clave de servidor y su
// propia forma de sustituir valores; por eso el bloque se publica por runtime y no
// como un ejemplo único.
const buildMcpRuntimeRegistrations = (url) => ({
  claudecode: {
    config_file: '.mcp.json',
    value_substitution: 'Environment variables expand as ${VAR} inside the config file.',
    config: {
      mcpServers: {
        apts: {
          type: 'http',
          url,
          headers: {
            Authorization: 'Bearer ${APTS_API_KEY}',
            'X-APTS-Project-Url': '${APTS_PROJECT_URL}',
            'X-APTS-Agent-Name': '${APTS_AGENT_NAME}',
            'X-APTS-Agent-Email': '${APTS_AGENT_EMAIL}'
          }
        }
      }
    }
  },
  opencode: {
    config_file: 'opencode.json',
    value_substitution: 'Environment variables expand as {env:VAR} inside the config file.',
    config: {
      $schema: 'https://opencode.ai/config.json',
      mcp: {
        apts: {
          type: 'remote',
          url,
          enabled: true,
          headers: {
            Authorization: 'Bearer {env:APTS_API_KEY}',
            'X-APTS-Project-Url': '{env:APTS_PROJECT_URL}',
            'X-APTS-Agent-Name': '{env:APTS_AGENT_NAME}',
            'X-APTS-Agent-Email': '{env:APTS_AGENT_EMAIL}'
          }
        }
      }
    }
  },
  vscode: {
    config_file: '.vscode/mcp.json',
    value_substitution: 'The access key is prompted once via inputs[] and stored by the editor. The three identity values are project-stable and non-secret: replace the placeholders with real values.',
    config: {
      inputs: [
        { id: 'apts-api-key', type: 'promptString', description: 'APTS_API_KEY', password: true }
      ],
      servers: {
        apts: {
          type: 'http',
          url,
          headers: {
            Authorization: 'Bearer ${input:apts-api-key}',
            'X-APTS-Project-Url': '<APTS_PROJECT_URL>',
            'X-APTS-Agent-Name': '<APTS_AGENT_NAME>',
            'X-APTS-Agent-Email': '<APTS_AGENT_EMAIL>'
          }
        }
      }
    }
  }
});

const buildMcpEndpoint = (req) => {
  const url = buildAbsoluteUrl(req, MCP_ROUTE_PATH);

  return {
    url,
    transport: 'streamable_http',
    protocol_version: '2025-06-18',
    session: 'stateless',
    requires_download: false,
    post: 'One JSON-RPC message per request (initialize, tools/list, tools/call, ping). Notifications answer 202 with an empty body.',
    get: 'Answers 405: this endpoint is stateless and has no server-to-client stream. Clients that probe it may ignore the 405 and continue over POST.',
    max_message_size: MCP_MAX_MESSAGE_SIZE,
    headers: MCP_IDENTITY_HEADER_SPEC,
    identity_rule: 'The three identity headers are part of the registration, not an option: they are how the server knows who is calling and about which project. A value sent in the call arguments wins over the header, which is how an agent switches role; a project_url that contradicts the header is rejected. When both are missing the call is rejected naming the field.',
    call_supplied_fields: [
      { field: 'task_id', note: 'Returned by register_task; send it in the execution calls that need it.' },
      { field: 'branch', note: 'Optional. It cannot travel in a header because it changes during the session, and the server never sees the client repository.' }
    ],
    registration_by_runtime: buildMcpRuntimeRegistrations(url),
    surface_note: 'This endpoint exposes the same contract operations as the downloadable stdio server, which stays available. Registering it needs a URL and headers only: no file download, no local Node process, no artifact version to keep in sync.'
  };
};

// --- El bucle de conducción del método, como dato ---------------------------
//
// Hasta 4.0.0 esto sólo existía como prosa descargable
// (`method_orchestrator_agent`, 2.813 unidades). Un cliente sin descargas tenía
// el transporte y las 21 operaciones, pero no sabía conducir el método.
//
// Se publica SÓLO lo que es del motor —lo que el cliente no puede deducir de
// `tools/list` ni inventar sin equivocarse— y se deja fuera lo que es del
// programa cliente: el envoltorio de agente, la lista de herramientas
// (redundante con `tools/list`), el subagente al que se delega, el registro de
// resiliencia, la política de reintentos y el formato de informe. 1.562
// unidades de las 2.813.
//
// No ahorra tokens: los mueve de la descarga al manifiesto. Lo que compra es
// cerrar "cero descargas" y que el bucle no pueda desincronizarse del motor.
const METHOD_CONDUCTION = {
  summary: 'How to conduct a server-authoritative BMAD initiative end-to-end through the contract operations. The method engine lives on the server: do not invent phases, steps, roles or artifacts — ask apts_next / apts_workflow_step what is required and satisfy exactly that.',
  bootstrap_rule: [
    'Before conducting, ensure the initiative and roster exist. Both operations are idempotent.',
    '1. Call create_initiative with the initiative title and, when the client repo has a spec, pass it as spec_artifact: { title, content } so the server stores it as a typed semantic_documents artifact linked to the initiative (the server has no access to the client filesystem). It returns { initiative_id, epic_id, phase, created|resumed } and folds in one empty epic. Calling it again resumes the existing active initiative instead of duplicating, so it is also the recovery path for an agent that lost its context.',
    '2. Register the role roster with one set_agent_role call per BMAD role: one distinct agent_name per role, each bound to its method entity via entity_key. The valid entity_key values come in create_initiative\'s roster.entity_keys (and in apts_next while the caller still has no pointer). The server resolves entity_key to entity_id against the initiative\'s library, scoped by source_ref, and persists it non-null. An unset entity_id makes apts_next wait forever: do not skip the roster. set_agent_role rejects an entity_key that is not in the initiative\'s library.',
    '3. Pick a stable, deterministic agent_name per role and reuse the same name whenever acting as that role, so re-runs upsert the same pointer instead of duplicating.'
  ].join('\n'),
  identity_switching_rule: [
    'The conducting client is several roles at once. The server names the role a step requires in the role field:',
    '- apts_next returns the entity REQUIRED by the current step in role, not the caller\'s role.',
    '- When next is wait and role differs from the identity that called, the step needs another role: switch the acting agent_name to the roster pointer registered for that role and call again. The required role then receives run_step for the same step. Do not poll all roles blindly — the wait response already names the role to switch to.',
    '- Keep a stable mapping from role to agent_name out of the registered roster and switch deterministically. The agent_name sent in the call wins over the registration header, which is the mechanism the switch rides on.'
  ].join('\n'),
  drive_loop: [
    'Conduct one step at a time until done or blocked:',
    '1. Call apts_next acting as a plausible role. apts_status gives the same recommendation without mutating anything.',
    '2. Dispatch on next:',
    '- wait: two cases, told apart by the returned role. If role differs from the calling identity, the step needs a different role — switch identity (identity_switching_rule) and continue. If role is the SAME identity already acting, there is no free work unit for that role right now (for example an iterable dev-story whose stories are all claimed or terminal): do not re-call as the same identity in a loop. Re-check with apts_status and, if the lifecycle holds no pending work for it, treat it as nothing-to-do, not as a role switch.',
    '- run_step with a generative target (target_id equals initiative_id; non-iterable step): drive it with generative_step_rule.',
    '- run_step with an iterable target (target_id is a story id; the dev-story step): implement the story, then close it with dev_story_completion_rule.',
    '- done: the lifecycle is complete. Stop and report success.',
    '- blocked: stop and report the blocker (why, and role when present). Do not improvise around a blocker; surface it.'
  ].join('\n'),
  generative_step_rule: [
    'For a generative (non-iterable) step, acting as the required role:',
    '1. Call apts_workflow_step to fetch the served step payload. It returns mode plus instruction_chunk, template_slice, needs[] (bounded upstream-artifact slices) and outputs[] (what the step must produce).',
    '- If mode is await_input, the payload carries questions. Present them to the operator, collect answers, and resume by calling apts_workflow_step again with answers for that step. Elicitation is a pause, not a blocker.',
    '- If mode is wait, blocked or done, handle it as in drive_loop.',
    '2. Produce the artifact the step declares in outputs[], grounded in instruction_chunk, template_slice and the needs[] slices. Do not fabricate content the step does not ask for.',
    '3. Submit with apts_submit_step, passing the produced content or reference in output (for example { title, content } for a doc artifact, { stories: [...] } for backlog items). It returns { ok, captured[], advanced_to, workflow_complete }. If ok is false, read why and correct the call instead of retrying it unchanged: in particular, a step paused in await_input must be resumed via apts_workflow_step with answers before it can be submitted.',
    '4. If workflow_complete is false, keep serving and submitting the next step of the same workflow. When it is true, go back to drive_loop for the next workflow or phase.'
  ].join('\n'),
  dev_story_completion_rule: [
    'The iterable dev-story step does not auto-release: whoever holds the claim must drive the engine\'s dev-story workflow to completion.',
    'It is multi-step (the BMAD dev procedure; in the seeded library it is 10 iterable steps, and only the terminal step declares a status output). Acting as the SAME dev agent_name that holds the claim, walk it like a generative workflow (generative_step_rule): apts_workflow_step then apts_submit_step per step, answering any await_input, submitting empty output for the procedure steps and output: { status: "done", code_ref: "<commit hash>" } on the step that declares the status output.',
    'Each submit advances one step. The claimed story is marked done and the cursor released only when that terminal status output is captured (workflow_complete / iterable_unit_done). Do not re-resolve via apts_next per step, and do not expect a single submit to close the story.',
    'A backlog status update made outside this workflow is not enough: a story left at review is non-terminal, so without the terminal apts_submit_step it is never done.',
    'Once it is closed, re-enter drive_loop: apts_next hands out the next free unit, or advances the phase once every story is done.',
    'If the implementation is blocked, make sure the blocker is reflected in APTS and stop the cycle with a blocker report. Do not submit the story as done.'
  ].join('\n')
};

// `buildLegacyCleanupTargets` vivía aquí y alimentaba `artifact_sync_policy`, que se
// retiró en 4.0.0 junto con el resto de la política de instalación local. Los
// `deprecated_filenames` de cada artefacto se siguen publicando en `artifacts[]`, así
// que quien todavía haga limpieza local tiene el dato; lo que ya no se publica es la
// receta para hacerla.

// Los cuatro artefactos del camino por entrada/salida estándar salen de
// `artifacts[]` en 4.0.0: eran 1.410 unidades de metadatos describiendo con
// detalle un camino obsoleto. Sus rutas se siguen sirviendo sin cambios, así que
// aquí quedan publicadas en corto (~150 unidades): sin ellas seguirían vivas
// pero no serían descubribles, y "siguen sirviéndose" pasaría a ser cierto pero
// no comprobable desde el manifiesto. Se derivan de las mismas entradas de
// `integrationArtifacts`, para que no puedan quedar desalineadas.
const buildLegacyDownloadRoutes = (req) => ({
  status: 'unsupported; served unchanged',
  replaced_by: 'mcp_endpoint',
  note: 'The stdio download path. Delisted from artifacts[] in 4.0.0 and no longer described there; these routes keep answering 200 for clients that already run it.',
  routes: Object.entries(integrationArtifacts)
    .filter(([, artifact]) => artifact.listed === false)
    .map(([id, artifact]) => ({ id, url: buildAbsoluteUrl(req, artifact.route) }))
});

const normalizeManifestRuntime = (runtime) => {
  if (typeof runtime !== 'string') return null;

  const normalized = runtime.trim().toLowerCase();
  if (!normalized) return null;

  const aliases = {
    'vs-code': 'vscode',
    'vs code': 'vscode',
    copilot: 'vscode',
    'github-copilot': 'vscode',
    'open-code': 'opencode',
    'open code': 'opencode',
    claude: 'claudecode',
    'claude-code': 'claudecode',
    'claude code': 'claudecode'
  };

  return aliases[normalized] || normalized;
};

const isArtifactRuntimeCompatible = (artifact, activeRuntime) => {
  if (!activeRuntime) return true;
  if (!artifact?.runtime) return true;
  return String(artifact.runtime).toLowerCase() === activeRuntime;
};

const buildIntegrationManifest = (req) => {
  const activeRuntime = normalizeManifestRuntime(req.query.runtime);

  return {
    service: 'APTS',
    version: rootPackage.version,
    schema_version: integrationManifestSchemaVersion,
    integration_mode: 'agent',
    runtime_filter: {
      query_param: 'runtime',
      active_runtime: activeRuntime,
      supported_runtime_values: ['vscode', 'opencode', 'claudecode'],
      recommendation_behavior: 'When runtime is provided, recommended artifacts are filtered to runtime-compatible entries first.'
    },
    bootstrap: {
      manifest_updates: {
        current_version: integrationManifestSchemaVersion
      },
      summary: 'APTS centralizes operational tracking for agent-executed projects and should become the source of truth for backlog and execution state.',
      service_purpose: 'Use APTS to register backlog, active tasks, blockers, heartbeats, and technical logs through an automation-oriented REST API.',
      source_of_truth: 'Once integration starts, backlog_items and tasks in APTS should replace local mirrors or checklists as the primary operational tracker.',
      migration_goal: 'If the project still manages backlog or tracking in local files, read them first and migrate or sync those items into APTS before normal execution continues.',
      local_tracking_inputs: [
        'backlog markdown files',
        'local project plans or roadmaps',
        'todo lists or historical tracking mirrors',
        'existing scope documents or acceptance criteria'
      ],
      chat_request_triage: {
        detect_as_bugfix_when_request_mentions: [
          'bug fixes',
          'errors or exceptions',
          'failing behavior caused by an existing defect',
          'regressions',
          'incidents where existing functionality is broken'
        ],
        required_backlog_item_type: 'bug',
        existing_item_policy: 'Before creating a new defect entry, inspect APTS backlog and reuse an existing non-deleted bug item when it already tracks the same symptom, scope, or failure. Prefer search_similar_bug_reports for semantic duplicate detection.',
        ambiguous_question_policy: 'If the chat may be a question, clarification request, or exploratory debugging prompt rather than a confirmed bug report, keep intake read-only and ask the user whether they want to register it as a bug in APTS.',
        recommended_entrypoint_agent: 'APTS Bugfix Intake',
        recommended_entrypoint_policy: 'When the runtime supports custom agents, use the APTS Bugfix Intake agent as the preferred entrypoint for chat-triggered bug intake before any execution task is registered.',
        explicit_confirmation_rule: 'Do not create or update a tracked bug item from chat until the user explicitly confirms that the issue should be registered or treated as a bug in APTS.',
        new_item_policy: 'If no matching bug item exists and the user explicitly confirms the issue should be tracked as a bug, create it in APTS before implementation starts and capture the symptom, expected behavior, observed behavior, and any reproduction evidence available from the chat.',
        resolved_item_policy: 'When a defect has already been solved, report it by updating the tracked bug backlog item to review or done and include the fix summary, validation evidence, and changed scope in acceptance_criteria or implementation_notes.',
        task_link_policy: 'Only register or continue execution work after the task can reference that backlog_item_id.',
        source_tracking: {
          source_kind: 'chat_request',
          source_ref_rule: 'Persist a stable conversation or thread identifier in source_ref when the runtime exposes one; otherwise omit source_ref.'
        },
        bypass_rule: 'Do not jump directly into code changes for a new untracked bug report, error-fix request, or regression repair.'
      },
      access_model: {
        bootstrap: 'public',
        agent_api: 'bearer_token_required'
      },
      credential_bootstrap: {
        required_secret: 'APTS_API_KEY',
        how_to_obtain: 'If APTS_API_KEY is not available in the project environment, explicitly request it from the human operator or integration owner before attempting protected calls.',
        missing_secret_behavior: 'Do not attempt register_task, read_project_context, or any other protected call until APTS_API_KEY is provided.',
        storage_recommendation: 'Define APTS_BASE_URL and APTS_API_KEY in a .env file at the client project root, or in an equivalent secret system that exposes them as runtime environment variables. Never hardcode them in source code, versioned prompts, JSON files, or backlog documents.',
        preferred_env_file: '.env (client project root)',
        env_example: [
          'APTS_BASE_URL=https://apts.informaticos.ar/api',
          'APTS_API_KEY=place-your-api-key-here'
        ],
        companion_env: 'APTS_BASE_URL must point to the /api base URL published by this manifest.'
      },
      mutation_safety: {
        mandatory_field_reminders: {
          update_backlog_item: 'Use backlog_item_id in payloads. Do not send id for update_backlog_item or delete_backlog_item operations.',
          update_payload_shape: 'Use one JSON object for single update calls, or a non-empty JSON array for batch calls.'
        },
        recommended_execution_pattern: [
          'Validate operation semantics first with a minimal payload (for example status-only update) before sending long acceptance_criteria text.',
          'Apply multi-step updates for high-risk text: first a minimal field update, then the full content update after the first call succeeds.'
        ],
        post_write_verification: 'After mutating calls, read backlog/task state and confirm persisted fields match expected values instead of relying only on the call returning success.'
      },
      skill_installation_paths: {
        preferred_scope: 'workspace_local',
        canonical_base_path: '.ia/apts',
        runtime_adapter_paths: ['.github/skills/apts', '.agents/skills/apts', '.claude/skills/apts'],
        policy: 'Keep APTS integration artifacts local to each repository and avoid user-global skill installation for project integrations.'
      },
      runtime_agent_discovery: {
        runtime: 'vscode',
        discovery_path: '.github/agents',
        required_glob: '*.agent.md',
        reload_required_after_sync: true,
        generation_note: 'Per-runtime adapters are no longer downloaded individually. Generate them locally with the adapter_generator (scripts/generate-adapters.js) from the surface_spec, then copy runtime-adapters/vscode/agents/*.agent.md into .github/agents.',
        validation_checklist: [
          'Confirm orchestrator and executor adapters exist in .github/agents, plus the intake adapter (apts-bugfix-intake.agent.md) when bug-intake custom flows are desired.',
          'Validate YAML frontmatter for each adapter and ensure name is present and unique.',
          'Reload VS Code window so the runtime reindexes custom agents.'
        ]
      },
      agent_runtime_adapters: {
        required_for_custom_agents: true,
        installation_state_policy: 'If the runtime is VS Code and required adapters are missing in .github/agents, custom-agent installation is incomplete.',
        generation: {
          spec_artifact_id: 'surface_spec',
          generator_artifact_id: 'adapter_generator',
          output_dir: 'runtime-adapters/vscode/agents',
          policy: 'Generated adapters are managed: run the generator to (re)materialize them; never hand-edit them. They are not published as individual downloadable artifacts.'
        },
        mappings: [
          {
            runtime: 'vscode',
            canonical_artifact_id: 'intake_bugfix_agent',
            generated_by_artifact_id: 'adapter_generator',
            target_relative_path: '.github/agents/apts-bugfix-intake.agent.md',
            invocation_name: 'APTS Bugfix Intake',
            invocation_aliases: ['Intake Bugfix APTS']
          },
          {
            runtime: 'vscode',
            canonical_artifact_id: 'orchestrator_agent',
            generated_by_artifact_id: 'adapter_generator',
            target_relative_path: '.github/agents/apts-backlog-orchestrator.agent.md',
            invocation_name: 'APTS Backlog Orchestrator',
            invocation_aliases: ['Orquestador Backlog APTS']
          },
          {
            runtime: 'vscode',
            canonical_artifact_id: 'executor_agent',
            generated_by_artifact_id: 'adapter_generator',
            target_relative_path: '.github/agents/backlog-item-executor-dev-test-commit.agent.md',
            invocation_name: 'Backlog Item Executor Dev Test Commit',
            invocation_aliases: ['Ejecutor Item Backlog Dev Test Commit']
          }
        ]
      },
      agent_instruction_policy: {
        preferred_instruction_files: ['AGENTS.md', '.github/copilot-instructions.md'],
        missing_file_behavior: 'If neither AGENTS.md nor .github/copilot-instructions.md exists, create AGENTS.md from the downloaded apts-agent-guidelines.md before protected APTS calls.',
        existing_file_behavior: 'If an instruction file already exists, preserve project-specific rules and merge or refresh only one APTS-managed section instead of replacing the whole file.',
        managed_section_markers: ['<!-- APTS:START -->', '<!-- APTS:END -->'],
        update_strategy: [
          'If an instruction file has no APTS managed section, append one managed section once.',
          'If managed markers already exist, replace only the content between markers.',
          'Do not duplicate multiple APTS managed sections in the same file.'
        ]
      },
      task_recovery_policy: {
        register_task_resume_rule: 'When register_task includes backlog_item_id and the linked backlog item already has an active task in todo, in_progress, or stalled, APTS resumes that task instead of creating a duplicate.',
        done_transition_rule: 'Task status done is accepted only from review and only when recent execution activity exists (heartbeat or progress log within the freshness window).',
        blocker_transition_rule: 'report_blocker sets task status to stalled and marks the linked backlog item as blocked.',
        stale_heartbeat_rule: 'When heartbeat is stale, background monitoring marks in_progress tasks as stalled and marks linked backlog items as blocked.'
      },
      local_resilience_log: {
        required: true,
        source_of_truth: false,
        purpose: 'Maintain a local append-only resilience journal in case APTS becomes temporarily unavailable or loses history, without replacing APTS as the primary operational tracker.',
        recommended_path: '.apts/agent-resilience-log.jsonl',
        format: 'jsonl',
        write_on: [
          'execution start',
          'important milestones',
          'blockers',
          'APTS synchronization failures',
          'task completion'
        ],
        recommended_fields: [
          'timestamp',
          'agent_role',
          'project_url',
          'backlog_item_id',
          'task_id',
          'branch',
          'event',
          'summary',
          'files_modified',
          'commands_run',
          'apts_sync_status'
        ],
        replay_policy: 'If APTS is unavailable, keep the local journal and synchronize relevant milestones when service is restored. Do not use this journal for reprioritization or as official operational state.',
        forbidden_content: ['APTS_API_KEY', 'other secrets', 'tokens', 'credentials']
      },
      recommended_first_steps: [
        'Register the remote MCP server: copy the block for your runtime from mcp_endpoint.registration_by_runtime as-is. No file has to be downloaded to use the 21 operations.',
        'If APTS_API_KEY is not yet present in the environment, request it from the operator, together with the project identity values the registration block references.',
        'Call the tools with minimal payloads: the integration layer supplies project_url and agent identity through the registration headers.',
        'Ensure the project has AGENTS.md or .github/copilot-instructions.md. Create AGENTS.md from apts-agent-guidelines.md if neither file exists, or merge/update one APTS-managed section if an instruction file already exists.',
        'If the runtime is VS Code and custom agents are required, generate the adapters locally with scripts/generate-adapters.js, copy runtime-adapters/vscode/agents/*.agent.md into .github/agents, and reload the editor window after sync.',
        'Treat interrupted execution as resumable work: call register_task with backlog_item_id so APTS can resume existing stalled/todo/in_progress tasks for that backlog item instead of creating duplicates.',
        'Prepare a local append-only resilience journal, for example at .apts/agent-resilience-log.jsonl, without treating it as a source of truth.',
        'Inspect local files that currently contain backlog, planning, or operational tracking.',
        'If the runtime supports custom agents and the current chat may be a new defect report, install or invoke the APTS Bugfix Intake agent before direct execution.',
        'If the current chat request is a new bugfix, error investigation, or regression report, first confirm with the user that they want it tracked as a bug when the intent is ambiguous; only then run search_similar_bug_reports and inspect APTS backlog for a matching bug item before creating a new item_type=bug.',
        'If the current chat request asks to report a solved defect, update the tracked bug item status to review or done and include resolution evidence.',
        'Create or update backlog_items in APTS to reflect that initial state.',
        'From that point onward, use APTS as the primary tracking system and do not invent work outside APTS.'
      ],
      operator_prompt_template: 'Read this public manifest, understand that APTS is the tracking source of truth, register the remote MCP server by copying the block for this runtime from mcp_endpoint.registration_by_runtime, request APTS_API_KEY and the project identity values from the operator if missing, store them in a .env file at the client project root (or equivalent secret store), prepare a local append-only resilience journal, and if the current user request may describe a new bug, error, or regression from chat, first confirm whether the user wants it registered as a bug in APTS before creating or updating any tracked bug item.'
    },
    entrypoint: buildAbsoluteUrl(req, publicIntegrationBasePath),
    api_base_url: buildAbsoluteUrl(req, '/api'),
    mcp_endpoint: buildMcpEndpoint(req),
    method_conduction: METHOD_CONDUCTION,
    auth: {
      type: 'bearer',
      header: 'Authorization',
      scheme: 'Bearer',
      env: ['APTS_API_KEY', 'APTS_BASE_URL'],
      required_secret: 'APTS_API_KEY',
      request_secret_from_operator_when_missing: true,
      secret_storage: {
        recommended_locations: ['root_dotenv_file', 'environment_variables', 'project_secret_store'],
        avoid: ['hardcoded_source_files', 'tracked_prompt_files', 'versioned_json_contracts', 'backlog_documents']
      }
    },
    instructions: [
      'Read the bootstrap section first to understand the service purpose and the migration goal from local tracking to APTS.',
      'If APTS_API_KEY is missing, request it from the operator before any protected API call.',
      'Store APTS_API_KEY in a .env file at the root of the client project, or in an equivalent project secret store, together with the project identity values the registration block references.',
      'Register the remote MCP server from mcp_endpoint.registration_by_runtime; the 21 contract operations arrive through tools/list, with no file to download or keep in sync.',
      'When consuming manifest artifacts, filter by runtime first (runtime query param or client-side equivalent), then apply recommended entries from that compatible subset.',
      'Use runtime-specific adapter paths only when needed for discovery (.github/skills/apts, .agents/skills/apts, or .claude/skills/apts), and avoid user-global skill installation.',
      'If using VS Code custom agents, generate the runtime adapters locally with scripts/generate-adapters.js, copy runtime-adapters/vscode/agents/*.agent.md into .github/agents, and reload the window so those agents become discoverable.',
      'Maintain the local resilience log described in the bootstrap section; it is append-only and must not replace APTS as the source of truth.',
      'Read the base agent guidelines before the first APTS API call.',
      'Ensure AGENTS.md or .github/copilot-instructions.md exists before protected calls: create AGENTS.md if neither exists, or merge/update one APTS-managed section if an instruction file already exists.',
      'If the runtime supports custom agents and the current chat is a bugfix/reporting request or might be one, install or invoke the APTS Bugfix Intake agent before direct execution.',
      'If the current chat introduces a possible bug, error, or regression request, confirm with the user that it should be tracked as a bug in APTS before creating or updating a bug item.',
      'Only after that explicit confirmation should the issue be represented in APTS backlog as a bug item before registering execution work or starting implementation.',
      'If the current chat asks to report a solved bug, update the tracked bug backlog item and add resolution details with verification evidence.',
      'If the runtime is VS Code on Windows, route tests through WSL terminals/tasks and route non-test operations through PowerShell terminals/tasks.',
      'Do not run manual identity pre-flight commands: the integration layer supplies project_url and agent identity, and a call that is missing something is rejected naming the field.',
      'Use register_task with backlog_item_id to resume interrupted work for that backlog item before creating additional execution tasks.',
      'Do not force task status done for interrupted executions: pass through review first and ensure recent heartbeat or progress logs exist before closing as done.',
      'Download the optional agent templates only if your runtime supports custom agents.'
    ],
    identity_requirements: [
      { field: 'project_url', resolve_with: 'the integration layer (registration header); a value in the call that contradicts it is rejected' },
      { field: 'agent_name', resolve_with: 'the integration layer (registration header); a value in the call wins, which is how role switching works' },
      { field: 'agent_email', resolve_with: 'the integration layer (registration header)' },
      { field: 'branch', resolve_with: 'the call, when the operation accepts it; optional' },
      { field: 'task_id', resolve_with: 'the call; register_task returns it, and calling register_task again with the same backlog_item_id returns it back' }
    ],
    legacy_download_routes: buildLegacyDownloadRoutes(req),
    artifacts: Object.entries(integrationArtifacts).filter(([, artifact]) => artifact.listed !== false).map(([id, artifact]) => ({
      runtime_compatible: isArtifactRuntimeCompatible(artifact, activeRuntime),
      id,
      kind: artifact.kind,
      artifact_version: artifact.artifactVersion,
      updated_in_schema_version: artifact.updatedInSchemaVersion,
      sync_action: artifact.syncAction,
      deprecated_filenames: artifact.deprecatedFilenames || [],
      // Obsoleto no significa retirado: los 4 artefactos del camino por entrada/salida
      // estándar se siguen sirviendo sin cambios, y su `recommended` se deja como estaba
      // para que un cliente en 3.1.0 —que no conoce `mcp_endpoint`— conserve una
      // superficie que funciona (decisión #7, convivencia).
      deprecated: artifact.deprecated || false,
      deprecated_in_schema_version: artifact.deprecatedInSchemaVersion || null,
      deprecation_reason: artifact.deprecationReason || null,
      replaced_by: artifact.replacedBy || null,
      still_served: true,
      description: artifact.description,
      recommended: artifact.recommended && isArtifactRuntimeCompatible(artifact, activeRuntime),
      recommended_unfiltered: artifact.recommended,
      optional: artifact.optional || false,
      usage_priority: artifact.usagePriority || null,
      module_system: artifact.module_system || null,
      selection_rule: artifact.selection_rule || null,
      depends_on_artifact_ids: artifact.dependsOnArtifactIds || [],
      runtime: artifact.runtime || null,
      discovery_path: artifact.discoveryPath || null,
      required_glob: artifact.requiredGlob || null,
      target_relative_path: artifact.targetRelativePath || null,
      canonical_source_artifact_id: artifact.canonicalSourceArtifactId || null,
      invocation_name: artifact.invocationName || null,
      invocation_aliases: artifact.invocationAliases || [],
      media_type: artifact.contentType,
      url: buildAbsoluteUrl(req, artifact.route),
      download_url: `${buildAbsoluteUrl(req, artifact.route)}?download=1`
    }))
  };
};

const sendIntegrationArtifact = async (req, res, artifactKey) => {
  const artifact = integrationArtifacts[artifactKey];

  if (!artifact) {
    return res.status(404).json({ error: 'Integration artifact not found' });
  }

  try {
    const content = await fs.readFile(artifact.filePath, 'utf8');

    if (req.query.download === '1') {
      res.setHeader('Content-Disposition', `attachment; filename="${artifact.fileName}"`);
    }

    res.setHeader('Content-Type', artifact.contentType);
    return res.send(content);
  } catch (error) {
    return sendApiError(res, createHttpError(500, 'Unable to read integration artifact', {
      code: 'INTEGRATION_ARTIFACT_READ_FAILED',
      expose: true,
      cause: error
    }), {
      fallbackMessage: 'Unable to read integration artifact',
      logMessage: 'Integration artifact read failed',
      logContext: { artifact_key: artifactKey }
    });
  }
};

app.get(publicIntegrationBasePath, (req, res) => {
  res.json(buildIntegrationManifest(req));
});

app.get(`${publicIntegrationBasePath}/skills.json`, async (req, res) => sendIntegrationArtifact(req, res, 'skills_json'));
app.get(`${publicIntegrationBasePath}/skill.md`, async (req, res) => sendIntegrationArtifact(req, res, 'skill_markdown'));
app.get(`${publicIntegrationBasePath}/agent-guidelines.md`, async (req, res) => sendIntegrationArtifact(req, res, 'agent_guidelines'));
app.get(`${publicIntegrationBasePath}/agentes/intake-bugfix-apts.agent.md`, async (req, res) => sendIntegrationArtifact(req, res, 'intake_bugfix_agent'));
app.get(`${publicIntegrationBasePath}/agentes/ejecutor-item-backlog-dev-test-commit.agent.md`, async (req, res) => sendIntegrationArtifact(req, res, 'executor_agent'));
app.get(`${publicIntegrationBasePath}/agentes/orquestador-backlog-apts.agent.md`, async (req, res) => sendIntegrationArtifact(req, res, 'orchestrator_agent'));
app.get(`${publicIntegrationBasePath}/agentes/apts-method-orchestrator.agent.md`, async (req, res) => sendIntegrationArtifact(req, res, 'method_orchestrator_agent'));
app.get(`${publicIntegrationBasePath}/apts-mcp.js`, async (req, res) => sendIntegrationArtifact(req, res, 'mcp_server'));
app.get(`${publicIntegrationBasePath}/apts-client.js`, async (req, res) => sendIntegrationArtifact(req, res, 'js_client'));
app.get(`${publicIntegrationBasePath}/contract-check.js`, async (req, res) => sendIntegrationArtifact(req, res, 'contract_check'));
app.get(`${publicIntegrationBasePath}/package.json`, async (req, res) => sendIntegrationArtifact(req, res, 'package_manifest'));
app.get(`${publicIntegrationBasePath}/runtime-adapters/spec/apts-surface.json`, async (req, res) => sendIntegrationArtifact(req, res, 'surface_spec'));
app.get(`${publicIntegrationBasePath}/scripts/generate-adapters.js`, async (req, res) => sendIntegrationArtifact(req, res, 'adapter_generator'));

// --- AGENT API (SKILLS) ---

const notifyWebhook = async (project_url, payload) => {
  try {
    const project = await db('projects').where({ url: project_url }).first();
    if (project && project.webhook_url) {
      await fetch(project.webhook_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        // F6-2-T4: sin plazo, un webhook del cliente que no responde colgaba la
        // escritura que lo dispara (update_task_status y compañía).
        signal: AbortSignal.timeout(WEBHOOK_DELIVERY_TIMEOUT_MS)
      }).catch((err) => {
        logger.warn({
          project_url,
          webhook_url: project.webhook_url,
          error: serializeErrorForLog(err)
        }, 'Webhook delivery failed');
      });
    }
  } catch (error) {
    logger.warn({
      project_url,
      error: serializeErrorForLog(error)
    }, 'Webhook lookup failed');
  }
};

const queueWebhookNotification = async (projectUrl, payload, { deferredWebhooks } = {}) => {
  const normalizedProjectUrl = normalizeUrl(projectUrl || '');
  if (!normalizedProjectUrl) return;

  if (Array.isArray(deferredWebhooks)) {
    deferredWebhooks.push({ project_url: normalizedProjectUrl, payload });
    return;
  }

  await notifyWebhook(normalizedProjectUrl, payload);
};

const parseDateOrNull = (value) => {
  if (!value) return null;

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const hasRecentTaskActivity = ({ lastHeartbeat, lastLogAt }, now = Date.now()) => {
  const heartbeatDate = parseDateOrNull(lastHeartbeat);
  const logDate = parseDateOrNull(lastLogAt);

  const latest = [heartbeatDate, logDate]
    .filter(Boolean)
    .reduce((maxDate, candidate) => {
      if (!maxDate) return candidate;
      return candidate.getTime() > maxDate.getTime() ? candidate : maxDate;
    }, null);

  if (!latest) return false;
  return (now - latest.getTime()) <= TASK_ACTIVITY_FRESHNESS_MS;
};

const ensureTaskStatusTransition = (currentStatus, nextStatus) => {
  if (currentStatus === nextStatus) {
    return;
  }

  const allowedTransitions = TASK_STATUS_TRANSITIONS[currentStatus];
  if (!allowedTransitions || !allowedTransitions.has(nextStatus)) {
    throw createHttpError(409, `Invalid task status transition from ${currentStatus} to ${nextStatus}`);
  }
};

const registerTaskInternal = async (payload, { connection = db } = {}) => {
  const {
    project_url: projectUrl,
    title,
    agent_name: agentName,
    agent_email: agentEmail,
    context,
    backlog_item_id: backlogItemId
  } = payload;
  const url = normalizeUrl(projectUrl || '');

  if (!url) {
    throw createHttpError(400, 'Project url is required');
  }

  if (backlogItemId) {
    const linkedBacklogItem = await connection('backlog_items')
      .where({ id: backlogItemId, project_url: url })
      .whereNull('deleted_at')
      .first();

    if (!linkedBacklogItem) {
      throw createHttpError(400, 'Backlog item id is not valid for project url');
    }

    if (linkedBacklogItem.active_task_id) {
      const activeTask = await connection('tasks')
        .where({ id: linkedBacklogItem.active_task_id, project_url: url })
        .first();

      if (activeTask && TASK_RESUMABLE_STATUSES.has(activeTask.status)) {
        const previousStatus = activeTask.status;

        await connection('tasks')
          .where({ id: activeTask.id })
          .update({
            status: 'in_progress',
            last_heartbeat: connection.fn.now(),
            updated_at: connection.fn.now()
          });

        await connection('backlog_items')
          .where({ id: backlogItemId, project_url: url })
          .update({
            status: 'in_progress',
            active_task_id: activeTask.id,
            updated_at: connection.fn.now()
          });

        await runNonBlockingSemanticOperation(
          () => syncBacklogCoverageDocument(connection, backlogItemId),
          { action: 'register_task.resume_backlog_sync', backlog_item_id: backlogItemId, project_url: url }
        );

        return {
          task_id: activeTask.id,
          status: 'in_progress',
          backlog_item_id: backlogItemId,
          resumed: true,
          previous_task_id: activeTask.id,
          previous_status: previousStatus
        };
      }
    }
  }

  await ensureProjectExists(url, { connection });

  const [task] = await connection('tasks').insert({
    project_url: url,
    title,
    agent_name: agentName || null,
    agent_email: agentEmail || null,
    context: context ?? null,
    status: 'in_progress',
    last_heartbeat: connection.fn.now()
  }).returning('*');

  if (backlogItemId) {
    await connection('backlog_items')
      .where({ id: backlogItemId, project_url: url })
      .update({
        status: 'in_progress',
        active_task_id: task.id,
        updated_at: connection.fn.now()
      });

    await runNonBlockingSemanticOperation(
      () => syncBacklogCoverageDocument(connection, backlogItemId),
      { action: 'register_task.create_backlog_sync', backlog_item_id: backlogItemId, project_url: url }
    );
  }

  return {
    task_id: task.id,
    status: task.status,
    backlog_item_id: backlogItemId || null,
    resumed: false,
    previous_task_id: null,
    previous_status: null
  };
};

const createBacklogItemInternal = async (body, { connection = db } = {}) => {
  const project_url = normalizeInputString(body?.project_url, { unwrapQuotes: true });
  const url = normalizeUrl(project_url);
  const { payload, error } = getBacklogPayload(body);

  if (!url) {
    throw createHttpError(400, 'Project url is required');
  }

  if (error) {
    throw createHttpError(400, error);
  }

  await ensureProjectExists(url, { connection });

  const [backlogItem] = await connection('backlog_items').insert({
    project_url: url,
    priority: 100,
    sort_order: 0,
    ...payload
  }).returning('*');

  await tryPersistBugEmbeddingForBacklogItem(backlogItem.id, { connection });
  await runNonBlockingSemanticOperation(
    () => syncBacklogCoverageDocument(connection, backlogItem.id),
    { action: 'create_backlog_item.semantic_sync', backlog_item_id: backlogItem.id, project_url: url }
  );

  const refreshedBacklogItem = await connection('backlog_items')
    .where({ id: backlogItem.id })
    .first();

  return { backlog_item: mapBacklogItemRecord(refreshedBacklogItem || backlogItem) };
};

const updateBacklogItemInternal = async (backlogItemId, body, { connection = db } = {}) => {
  if (!isUuid(backlogItemId)) {
    throw createHttpError(400, 'Backlog item id must be a valid UUID');
  }

  const { payload, error } = getBacklogPayload(body, { partial: true });
  if (error) {
    throw createHttpError(400, error);
  }

  if (!Object.keys(payload).length) {
    throw createHttpError(400, 'No backlog fields to update');
  }

  const [backlogItem] = await connection('backlog_items')
    .where({ id: backlogItemId })
    .whereNull('deleted_at')
    .update({
      ...payload,
      updated_at: connection.fn.now()
    })
    .returning('*');

  if (!backlogItem) {
    throw createHttpError(404, 'Backlog item not found');
  }

  await tryPersistBugEmbeddingForBacklogItem(backlogItem.id, { connection });
  await runNonBlockingSemanticOperation(
    () => syncBacklogCoverageDocument(connection, backlogItem.id),
    { action: 'update_backlog_item.semantic_sync', backlog_item_id: backlogItem.id, project_url: backlogItem.project_url }
  );

  const refreshedBacklogItem = await connection('backlog_items')
    .where({ id: backlogItem.id })
    .first();

  return { backlog_item: mapBacklogItemRecord(refreshedBacklogItem || backlogItem) };
};

const deleteBacklogItemInternal = async (backlogItemId, { connection = db } = {}) => {
  if (!isUuid(backlogItemId)) {
    throw createHttpError(400, 'Backlog item id must be a valid UUID');
  }

  const [backlogItem] = await connection('backlog_items')
    .where({ id: backlogItemId })
    .whereNull('deleted_at')
    .update({
      status: 'archived',
      active_task_id: null,
      deleted_at: connection.fn.now(),
      updated_at: connection.fn.now()
    })
    .returning('*');

  if (!backlogItem) {
    throw createHttpError(404, 'Backlog item not found');
  }

  await deleteSemanticDocumentsForBacklogItem(connection, backlogItem.id);

  return { success: true, backlog_item: mapBacklogItemRecord(backlogItem) };
};

const updateTaskStatusInternal = async (taskId, payload, { connection = db, deferredWebhooks } = {}) => {
  const { status, project_url: projectUrl, agent_name: agentName } = payload;
  const task = await connection('tasks').where({ id: taskId }).first();

  if (!task) {
    throw createHttpError(404, 'Task not found');
  }

  if (task.status !== status) {
    ensureTaskStatusTransition(task.status, status);

    if (status === 'done') {
      const latestLog = await connection('agent_logs')
        .where({ task_id: taskId })
        .orderBy('created_at', 'desc')
        .first('created_at');

      const hasRecentActivity = hasRecentTaskActivity({
        lastHeartbeat: task.last_heartbeat,
        lastLogAt: latestLog?.created_at
      });

      if (!hasRecentActivity) {
        throw createHttpError(409, 'Cannot mark task as done without recent execution activity. Resume task and send heartbeat or log_agent_progress first.');
      }
    }

    const taskUpdate = {
      status,
      updated_at: connection.fn.now()
    };

    if (status === 'in_progress') {
      taskUpdate.last_heartbeat = connection.fn.now();
    }

    await connection('tasks').where({ id: taskId }).update(taskUpdate);
  }

  const linkedBacklogStatus = mapTaskStatusToBacklogStatus(status);
  if (linkedBacklogStatus) {
    const backlogUpdate = {
      status: linkedBacklogStatus,
      updated_at: connection.fn.now()
    };

    if (status === 'done') {
      backlogUpdate.active_task_id = null;
    }

    const affectedBacklogItems = await connection('backlog_items')
      .where({ active_task_id: taskId })
      .update(backlogUpdate)
      .returning(['id']);

    await runNonBlockingSemanticOperation(
      () => syncBacklogCoverageDocuments(connection, affectedBacklogItems.map((item) => item.id)),
      { action: 'update_task_status.semantic_sync', task_id: taskId, project_url: projectUrl || task.project_url || null }
    );
  }

  await queueWebhookNotification(projectUrl || task.project_url || '', {
    event: 'task_status_updated',
    task_id: taskId,
    status,
    agent_name: agentName
  }, {
    deferredWebhooks
  });

  return { success: true, task_id: taskId, status };
};

const logAgentProgressInternal = async (taskId, payload, { connection = db } = {}) => {
  const {
    agent_name: agentName,
    branch,
    message,
    technical_details: technicalDetails
  } = payload;
  const hasTechnicalDetails = Object.prototype.hasOwnProperty.call(payload, 'technical_details');

  let serializedTechnicalDetails = null;
  if (hasTechnicalDetails && technicalDetails != null) {
    try {
      serializedTechnicalDetails = JSON.stringify(technicalDetails);
    } catch (_error) {
      throw createHttpError(400, 'Technical details must be valid JSON data');
    }
  }

  const task = await connection('tasks').where({ id: taskId }).first();
  if (!task) {
    throw createHttpError(404, 'Task not found');
  }

  const [log] = await connection('agent_logs').insert({
    task_id: taskId,
    agent_name: agentName || null,
    branch,
    message,
    technical_details: serializedTechnicalDetails
  }).returning('*');

  return { success: true, log };
};

const reportBlockerInternal = async (payload, { connection = db, deferredWebhooks } = {}) => {
  const {
    project_url: projectUrl,
    task_id: taskId,
    error_message: errorMessage,
    agent_name: agentName
  } = payload;
  const url = normalizeUrl(projectUrl || '');

  if (!url) {
    throw createHttpError(400, 'Project url is required');
  }

  const task = await connection('tasks').where({ id: taskId }).first();
  if (!task) {
    throw createHttpError(404, 'Task not found');
  }

  await connection('tasks')
    .where({ id: taskId })
    .update({ status: 'stalled', updated_at: connection.fn.now() });

  await connection('projects').where({ url }).update({ status: 'blocked' });
  const blockedBacklogItems = await connection('backlog_items')
    .where({ active_task_id: taskId })
    .update({ status: 'blocked', updated_at: connection.fn.now() })
    .returning(['id']);
  await runNonBlockingSemanticOperation(
    () => syncBacklogCoverageDocuments(connection, blockedBacklogItems.map((item) => item.id)),
    { action: 'report_blocker.semantic_sync', task_id: taskId, project_url: url }
  );
  await connection('agent_logs').insert({
    task_id: taskId,
    agent_name: agentName || null,
    message: 'BLOCKER REPORTED: ' + errorMessage,
    action_type: 'error'
  });
  await queueWebhookNotification(url, {
    event: 'project_blocked',
    task_id: taskId,
    error_message: errorMessage,
    agent_name: agentName
  }, {
    deferredWebhooks
  });

  return { success: true, task_id: taskId };
};

const heartbeatInternal = async (taskId, { connection = db } = {}) => {
  const updated = await connection('tasks').where({ id: taskId }).update({ last_heartbeat: connection.fn.now() });
  if (!updated) {
    throw createHttpError(404, 'Task not found');
  }

  return { success: true, task_id: taskId };
};

app.get('/api/health', async (_req, res) => {
  try {
    await db.raw('select 1');
    res.json({
      status: 'ok',
      database: 'ok',
      environment: process.env.NODE_ENV || 'development'
    });
  } catch (_error) {
    res.status(503).json({
      status: 'error',
      database: 'unavailable'
    });
  }
});

// ---------------------------------------------------------------------------
// F6-2-T1: piezas que hasta ahora vivían dentro de la ruta express.
//
// La superficie MCP remota ejecuta en proceso: no tiene `req.query` ni
// `req.params`, así que el parseo de parámetros y las tres lecturas que llevaban
// la consulta incrustada en la ruta se extraen aquí. Las rutas y la superficie
// remota llaman a las mismas funciones, que es lo que hace que la igualdad de
// F6-2-T5 sea por construcción y no por casualidad.
// ---------------------------------------------------------------------------

const parseReadProjectContextOptions = (raw = {}) => {
  const url = normalizeUrl(raw.url);
  const view = validateResponseView(raw.view);
  const includeSections = parseProjectContextInclude(raw.include);
  const limit = parseOptionalNonNegativeInteger(raw.limit, 'limit', { max: MAX_TASK_DETAIL_LOG_LIMIT }) ?? 5;
  const tasksLimit = parseOptionalNonNegativeInteger(raw.tasks_limit, 'tasks_limit', { max: MAX_PROJECT_CONTEXT_SECTION_LIMIT })
    ?? DEFAULT_PROJECT_CONTEXT_SECTION_LIMIT;
  const tasksOffset = parseOptionalNonNegativeInteger(raw.tasks_offset, 'tasks_offset') ?? 0;
  const backlogLimit = parseOptionalNonNegativeInteger(raw.backlog_limit, 'backlog_limit', { max: MAX_PROJECT_CONTEXT_SECTION_LIMIT })
    ?? DEFAULT_PROJECT_CONTEXT_SECTION_LIMIT;
  const backlogOffset = parseOptionalNonNegativeInteger(raw.backlog_offset, 'backlog_offset') ?? 0;
  const backlogStatus = normalizeInputString(raw.backlog_status, { unwrapQuotes: true, lowercase: true }) || null;

  if (!url) {
    throw createHttpError(400, 'Project url is required');
  }

  if (backlogStatus && !BACKLOG_STATUSES.includes(backlogStatus)) {
    throw createHttpError(400, 'Invalid backlog status');
  }

  return {
    url,
    view,
    includeSections,
    limit,
    tasksLimit,
    tasksOffset,
    backlogLimit,
    backlogOffset,
    backlogStatus
  };
};

const readProjectContextInternal = async ({
  url,
  view,
  includeSections,
  limit,
  tasksLimit,
  tasksOffset,
  backlogLimit,
  backlogOffset,
  backlogStatus
}) => {
  const responsePayload = {};

  if (includeSections.has('tasks')) {
    const tasksQuery = db('tasks')
      .where({ project_url: url })
      .orderBy('updated_at', 'desc')
      .offset(tasksOffset)
      .limit(tasksLimit);
    const tasks = (view === 'compact'
      ? await tasksQuery.select(TASK_COMPACT_SELECT_COLUMNS)
      : await tasksQuery.select('*'))
      .map((task) => mapTaskRecord(task, { view }));
    responsePayload.tasks = tasks;
  }

  if (includeSections.has('backlog')) {
    const backlog = await listBacklogItems(url, backlogStatus, {
      view,
      limit: backlogLimit,
      offset: backlogOffset
    });
    responsePayload.backlog = backlog;
  }

  if (includeSections.has('logs')) {
    const logsQuery = db('agent_logs')
      .join('tasks', 'agent_logs.task_id', 'tasks.id')
      .where('tasks.project_url', url)
      .orderBy('agent_logs.created_at', 'desc')
      .limit(limit);

    const logs = (view === 'compact'
      ? await logsQuery.select(
        'agent_logs.id',
        'agent_logs.task_id',
        'agent_logs.action_type',
        'agent_logs.agent_name',
        'agent_logs.branch',
        'agent_logs.message',
        'agent_logs.created_at',
        'agent_logs.updated_at',
        db.raw("CASE WHEN agent_logs.technical_details IS NULL THEN 'false' ELSE 'true' END AS has_technical_details")
      )
      : await logsQuery.select('agent_logs.*'))
      .map((log) => mapAgentLogRecord(log, { view }));

    responsePayload.logs = logs;
  }

  return responsePayload;
};

const parseListBacklogItemsOptions = (raw = {}) => {
  const url = normalizeUrl(raw.url);
  const status = normalizeInputString(raw.status, { unwrapQuotes: true, lowercase: true }) || null;
  const includeDeleted = parseBooleanFlag(raw.include_deleted);
  const view = validateResponseView(raw.view);
  const id = normalizeInputString(raw.id, { unwrapQuotes: true }) || null;
  const ids = parseCommaSeparatedUuidList(raw.ids, 'ids');
  const limit = parseOptionalNonNegativeInteger(raw.limit, 'limit', { max: MAX_BACKLOG_LIST_LIMIT })
    ?? DEFAULT_BACKLOG_LIST_LIMIT;
  const offset = parseOptionalNonNegativeInteger(raw.offset, 'offset') ?? 0;

  if (!url) {
    throw createHttpError(400, 'Project url is required');
  }

  if (status && !BACKLOG_STATUSES.includes(status)) {
    throw createHttpError(400, 'Invalid backlog status');
  }

  if (id && !isUuid(id)) {
    throw createHttpError(400, 'id must be a valid UUID');
  }

  if (id && ids.length > 0) {
    throw createHttpError(400, 'Use either id or ids, not both');
  }

  return { url, status, includeDeleted, view, id, ids, limit, offset };
};

const parseGetBacklogItemOptions = (raw = {}) => ({
  view: validateResponseView(raw.view || 'full'),
  includeDeleted: parseBooleanFlag(raw.include_deleted)
});

const getBacklogItemInternal = async (backlogItemId, { view, includeDeleted }) => {
  const backlogItemQuery = db('backlog_items').where({ id: backlogItemId });
  if (!includeDeleted) {
    backlogItemQuery.whereNull('deleted_at');
  }

  const backlogItem = view === 'compact'
    ? await backlogItemQuery.select(BACKLOG_COMPACT_SELECT_COLUMNS).first()
    : await backlogItemQuery.select('*').first();

  if (!backlogItem) {
    throw createHttpError(404, 'Backlog item not found');
  }

  return { backlog_item: mapBacklogItemRecord(backlogItem, { view }) };
};

const parseGetTaskOptions = (raw = {}) => ({
  view: validateResponseView(raw.view || 'full'),
  logsLimit: parseOptionalNonNegativeInteger(raw.limit, 'limit', { max: MAX_TASK_DETAIL_LOG_LIMIT })
    ?? DEFAULT_TASK_DETAIL_LOG_LIMIT
});

const getTaskInternal = async (taskId, { view, logsLimit }) => {
  const taskQuery = db('tasks').where({ id: taskId });
  const task = view === 'compact'
    ? await taskQuery.select(TASK_COMPACT_SELECT_COLUMNS).first()
    : await taskQuery.select('*').first();

  if (!task) {
    throw createHttpError(404, 'Task not found');
  }

  const logsQuery = db('agent_logs')
    .where({ task_id: taskId })
    .orderBy('created_at', 'desc')
    .limit(logsLimit);

  const logs = (view === 'compact'
    ? await logsQuery.select(
      'id',
      'task_id',
      'action_type',
      'agent_name',
      'branch',
      'message',
      'created_at',
      'updated_at',
      db.raw("CASE WHEN technical_details IS NULL THEN 'false' ELSE 'true' END AS has_technical_details")
    )
    : await logsQuery.select('*'))
    .map((log) => mapAgentLogRecord(log, { view }));

  const heartbeatLogs = await db('agent_logs')
    .where({ task_id: taskId, action_type: 'heartbeat' })
    .orderBy('created_at', 'desc')
    .limit(5)
    .select('id', 'created_at', 'agent_name', 'branch', 'message');

  const recentHeartbeats = heartbeatLogs.length > 0
    ? heartbeatLogs.map((heartbeat) => ({
      id: heartbeat.id,
      timestamp: heartbeat.created_at,
      agent_name: heartbeat.agent_name || null,
      branch: heartbeat.branch || null,
      message: heartbeat.message || null
    }))
    : (task.last_heartbeat
      ? [{
        id: null,
        timestamp: task.last_heartbeat,
        agent_name: task.agent_name || null,
        branch: null,
        message: null
      }]
      : []);

  return {
    task: mapTaskRecord(task, { view }),
    recent_heartbeats: recentHeartbeats,
    logs
  };
};

// F6-2-T5: `create_backlog_item` era la única de las siete operaciones de lote que
// validaba *dentro* del bucle, o sea después de haber escrito los elementos
// anteriores: un lote con un elemento malo dejaba escritos los buenos y devolvía un
// resultado parcial. Se valida por adelantado, como ya hacían las otras seis. Solo
// aplica al modo lote; el elemento suelto sigue validándose donde siempre, para no
// cambiar su mensaje de error.
const assertBacklogCreateBatchItems = (items) => {
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index] || {};
    const url = normalizeUrl(normalizeInputString(item?.project_url, { unwrapQuotes: true }));
    if (!url) {
      throw createHttpError(400, `Invalid payload at index ${index}: Project url is required`);
    }
    const { error } = getBacklogPayload(item);
    if (error) {
      throw createHttpError(400, `Invalid payload at index ${index}: ${error}`);
    }
  }
};

// F6-2-T2: la validación de create_initiative vive aquí para que la hereden las dos
// superficies. Además de lo que ya comprobaba la ruta (project_url, title y que
// spec_artifact sea un objeto), ahora se comprueban `track`, `phase` y
// `spec_artifact.content`, que iban directos al insert o a createHash().
const parseCreateInitiativeInput = (body = {}) => {
  const projectUrl = typeof body?.project_url === 'string' ? body.project_url.trim() : '';
  const title = typeof body?.title === 'string' ? body.title.trim() : '';
  if (!projectUrl) {
    throw createHttpError(400, 'project_url is required');
  }
  if (!title) {
    throw createHttpError(400, 'title is required');
  }

  const track = body?.track;
  if (track !== undefined && track !== null && !INITIATIVE_TRACKS.includes(track)) {
    throw createHttpError(400, `track must be one of: ${INITIATIVE_TRACKS.join(', ')}`);
  }

  const phase = body?.phase;
  if (phase !== undefined && phase !== null && !INITIATIVE_PHASES.includes(phase)) {
    throw createHttpError(400, `phase must be one of: ${INITIATIVE_PHASES.join(', ')}`);
  }

  const specArtifact = body?.spec_artifact;
  if (specArtifact !== undefined && specArtifact !== null) {
    if (typeof specArtifact !== 'object' || Array.isArray(specArtifact)) {
      throw createHttpError(400, 'spec_artifact must be an object');
    }
    // Sin esto revienta en crypto.createHash().update() (method_bootstrap.js:50).
    if (typeof specArtifact.content !== 'string' || !specArtifact.content.trim()) {
      throw createHttpError(400, 'spec_artifact.content is required and must be a non-empty string');
    }
    if (specArtifact.title !== undefined && specArtifact.title !== null && typeof specArtifact.title !== 'string') {
      throw createHttpError(400, 'spec_artifact.title must be a string');
    }
  }

  return {
    project_url: projectUrl,
    title,
    track: track ?? undefined,
    source_ref: body?.source_ref,
    phase: phase ?? undefined,
    description: body?.description,
    spec_artifact: specArtifact
  };
};

// El envoltorio `query:{…}` y el recorte de top_k vivían en la ruta; sin ellos la
// respuesta remota no sería la misma.
const searchSimilarBugReportsOperation = async (parsedBody) => {
  const {
    url,
    query_text: queryText,
    top_k: requestedTopK,
    threshold: requestedThreshold,
    include_closed: includeClosed,
    exclude_backlog_item_id: excludeBacklogItemId
  } = parsedBody;

  // Sin recorte: el esquema ya acota top_k a 1..MAX_SEMANTIC_SEARCH_TOP_K (F6-2-T2).
  const topK = requestedTopK ?? DEFAULT_SEMANTIC_SEARCH_TOP_K;
  const threshold = requestedThreshold ?? DEFAULT_SEMANTIC_SEARCH_THRESHOLD;

  try {
    const result = await searchSimilarBugReports({
      projectUrl: url,
      queryText,
      topK,
      threshold,
      includeClosed: includeClosed === true,
      excludeBacklogItemId: excludeBacklogItemId || null
    });

    return {
      query: {
        url: normalizeUrl(url),
        query_text: queryText,
        top_k: topK,
        threshold,
        include_closed: includeClosed === true,
        exclude_backlog_item_id: excludeBacklogItemId || null
      },
      ...result
    };
  } catch (operationError) {
    throw normalizeSemanticError(operationError, {
      unavailableMessage: 'Semantic bug search is temporarily unavailable',
      internalMessage: 'Semantic bug search failed',
      unavailableCode: 'SEMANTIC_BUG_SEARCH_UNAVAILABLE',
      internalCode: 'SEMANTIC_BUG_SEARCH_FAILED'
    });
  }
};

// ---------------------------------------------------------------------------
// Remote MCP surface: POST /mcp (Streamable HTTP, stateless). F6-1 + F6-2.
//
// F6-2: la ejecución ya no pasa por apts-client.js ni por el salto HTTP interno.
// dispatch() recibe un ejecutor en proceso con las mismas 21 funciones que
// exportaba el cliente, y cada una llama directamente a la función de negocio.
// ---------------------------------------------------------------------------

// Identity headers set once in the client's MCP registration block (decision #1).
// The call always wins over the header; when neither has a field we reject.
const MCP_IDENTITY_HEADERS = {
  project_url: 'x-apts-project-url',
  agent_name: 'x-apts-agent-name',
  agent_email: 'x-apts-agent-email'
};
const MCP_IDENTITY_HEADER_LABELS = {
  project_url: 'X-APTS-Project-Url',
  agent_name: 'X-APTS-Agent-Name',
  agent_email: 'X-APTS-Agent-Email'
};

// Campos de identidad que el cliente autorellenaba por operación. Con la ejecución
// en proceso el cliente ya no está en el camino, así que la tabla vive aquí y es la
// que decide qué se exige antes de ejecutar (decisión #1). Mientras el archivo
// descargable siga publicándose, la prueba interna de contrato (F6-2-T3) comprueba
// que esta tabla y la del cliente no se separen.
const MCP_IDENTITY_FIELDS_BY_OPERATION = {
  register_task: ['project_url', 'agent_name', 'agent_email'],
  read_project_context: ['url'],
  list_backlog_items: ['url'],
  get_project_constraints: ['url'],
  search_similar_bug_reports: ['url'],
  create_backlog_item: ['project_url'],
  update_task_status: ['task_id', 'project_url', 'agent_name', 'agent_email'],
  // `branch` sale de la lista en F6-2: sin cliente por medio no hay resolución
  // automática que cortar, y la decisión #1 la daba por opcional de verdad.
  log_agent_progress: ['task_id', 'project_url', 'agent_name'],
  report_blocker: ['task_id', 'project_url', 'agent_name'],
  heartbeat: ['task_id', 'project_url', 'agent_name'],
  apts_next: ['project_url', 'agent_name'],
  apts_status: ['project_url'],
  apts_workflow_step: ['project_url', 'agent_name'],
  apts_submit_step: ['project_url', 'agent_name'],
  create_initiative: ['project_url'],
  set_agent_role: ['project_url']
};

let mcpRuntimePromise = null;

// Solo el despachador: la ejecución la resuelve mcpLocalExecutor, en este proceso.
const loadMcpRuntime = () => {
  if (mcpRuntimePromise) return mcpRuntimePromise;

  mcpRuntimePromise = import(pathToFileURL(path.join(integrationRoot, 'paquete-apts', 'apts-mcp.js')).href)
    .then((server) => ({ server }))
    .catch((error) => {
      mcpRuntimePromise = null;
      throw error;
    });

  return mcpRuntimePromise;
};

// --- Ejecutor en proceso (F6-2-T1) ----------------------------------------
//
// dispatch() llama a `client[clientExport](payload)`. Antes ese objeto era el
// módulo apts-client.js, que hablaba HTTP contra este mismo servidor. Ahora es el
// objeto de abajo, con las mismas 21 funciones llamando directamente a la función
// de negocio que llamaría la ruta express. apts-mcp.js no se toca.
//
// Cada función reproduce **la ruta concreta que el cliente habría llamado** con
// ese mismo payload: mismo esquema de validación, mismo cuerpo de respuesta y,
// cuando falla, el mismo error que el cliente habría construido a partir de la
// respuesta HTTP. Es lo que hace comparable el resultado en F6-2-T5.

const mcpStatusToErrorCode = (statusCode) => {
  if (statusCode === 400) return 'BAD_REQUEST';
  if (statusCode === 401) return 'UNAUTHORIZED';
  if (statusCode === 403) return 'FORBIDDEN';
  if (statusCode === 404) return 'NOT_FOUND';
  if (statusCode === 408) return 'TIMEOUT';
  if (statusCode === 409) return 'CONFLICT';
  if (statusCode === 422) return 'UNPROCESSABLE_ENTITY';
  if (statusCode === 429) return 'RATE_LIMITED';
  if (statusCode >= 500) return 'SERVER_ERROR';
  return 'APTS_HTTP_ERROR';
};

const isMcpRetriableStatus = (statusCode) => statusCode === 408
  || statusCode === 425
  || statusCode === 429
  || statusCode >= 500;

// Traduce un error del servidor al mismo objeto que apts-client.js habría creado
// leyendo la respuesta HTTP (apts-client.js:631). Sin esto, un mismo rechazo se
// vería distinto por cada camino aunque la causa fuera la misma.
const buildMcpExecutionError = (statusCode, payload) => {
  const executionError = new Error(payload.error || `APTS request failed with status ${statusCode}`);
  executionError.name = 'AptsClientError';
  executionError.statusCode = statusCode;
  executionError.errorCode = typeof payload.error_code === 'string'
    ? payload.error_code
    : mcpStatusToErrorCode(statusCode);
  executionError.retriable = typeof payload.retriable === 'boolean'
    ? payload.retriable
    : isMcpRetriableStatus(statusCode);
  executionError.details = payload;
  return executionError;
};

// Envuelve una operación con el mismo registro y la misma traducción de error que
// haría la ruta express al responder.
const runMcpOperation = async (operation, {
  fallbackMessage,
  logMessage,
  logContext = {},
  mapError
}) => {
  try {
    return await operation();
  } catch (operationError) {
    // `mapError` existe porque no todas las rutas responden igual: `apts_set_status`
    // tiene un atajo propio para los errores con statusCode numérico y devuelve
    // `error_code` en vez de `code`. Sin reproducirlo, el envoltorio no coincide.
    const mapped = mapError ? mapError(operationError) : null;
    const { statusCode, payload } = mapped || buildApiErrorPayload(operationError, { fallbackMessage });

    const logPayload = { ...logContext, error: serializeErrorForLog(operationError) };
    if (statusCode >= 500) {
      logger.error(logPayload, logMessage);
    } else {
      logger.warn(logPayload, logMessage);
    }

    throw buildMcpExecutionError(statusCode, payload);
  }
};

// Reproduce la orquestación de lotes de las rutas: array = lote (nunca estricto,
// porque la superficie MCP no tiene forma de pedir `strict`), objeto = elemento
// suelto por la ruta de un solo elemento.
const runMcpBatch = async (payload, { schema, handler, assertBatchItems }) => {
  const { isBatch, items, error } = normalizeBatchRequestBody(payload);
  if (error) {
    throw createHttpError(400, error);
  }

  const parsedItems = schema ? parseBatchItems(items, schema) : items.map((item) => item || {});

  if (!isBatch) {
    return handler(parsedItems[0], 0);
  }

  if (assertBatchItems) assertBatchItems(parsedItems);

  const results = await executeBatchOperation(parsedItems, handler);
  return buildBatchOperationResponse(results).payload;
};

// Valida el identificador con el mismo esquema que usa la ruta al leerlo de la URL.
const parseMcpPathUuid = (value, schema) => {
  const parsed = schema.safeParse({ id: value });
  if (!parsed.success) {
    throw createHttpError(400, zodErrorMessage(parsed.error));
  }
  return parsed.data.id;
};

const parseMcpBody = (payload, schema) => {
  const parsed = schema.safeParse(payload || {});
  if (!parsed.success) {
    throw createHttpError(400, zodErrorMessage(parsed.error));
  }
  return parsed.data;
};

const requireMcpTrimmedString = (value, message) => {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    throw createHttpError(400, message);
  }
  return normalized;
};

const mcpLocalExecutor = {
  registerTask: (payload) => runMcpOperation(
    () => runMcpBatch(payload, {
      schema: registerTaskBodySchema,
      handler: (item) => registerTaskInternal(item)
    }),
    { fallbackMessage: 'Failed to register task', logMessage: 'register_task failed' }
  ),

  readProjectContext: (payload) => runMcpOperation(
    () => readProjectContextInternal(parseReadProjectContextOptions(payload)),
    { fallbackMessage: 'Failed to read project context', logMessage: 'read_project_context failed' }
  ),

  listBacklogItems: (payload) => runMcpOperation(
    async () => {
      const { url, status, ...listOptions } = parseListBacklogItemsOptions(payload);
      return { backlog: await listBacklogItems(url, status, listOptions) };
    },
    { fallbackMessage: 'Failed to list backlog items', logMessage: 'list_backlog_items failed' }
  ),

  getBacklogItem: (payload) => runMcpOperation(
    () => getBacklogItemInternal(
      parseMcpPathUuid(payload?.backlog_item_id, backlogIdParamSchema),
      parseGetBacklogItemOptions(payload)
    ),
    { fallbackMessage: 'Failed to read backlog item', logMessage: 'read_backlog_item failed' }
  ),

  getTask: (payload) => runMcpOperation(
    () => getTaskInternal(
      parseMcpPathUuid(payload?.task_id, taskIdParamSchema),
      parseGetTaskOptions(payload)
    ),
    { fallbackMessage: 'Failed to read task details', logMessage: 'read_task_details failed' }
  ),

  getProjectConstraints: (payload) => runMcpOperation(
    () => {
      const url = normalizeUrl(payload?.url);
      if (!url) {
        throw createHttpError(400, 'Project url is required');
      }
      return getProjectConstraints(url);
    },
    { fallbackMessage: 'Failed to read project constraints', logMessage: 'read_project_constraints failed' }
  ),

  searchSimilarBugReports: (payload) => runMcpOperation(
    () => searchSimilarBugReportsOperation(parseMcpBody(payload, semanticBugSearchBodySchema)),
    { fallbackMessage: 'Failed to execute semantic bug search', logMessage: 'semantic_bug_search failed' }
  ),

  createBacklogItem: (payload) => runMcpOperation(
    () => runMcpBatch(payload, {
      schema: null,
      assertBatchItems: assertBacklogCreateBatchItems,
      handler: (item) => createBacklogItemInternal(item)
    }),
    { fallbackMessage: 'Failed to create backlog item', logMessage: 'create_backlog_item failed' }
  ),

  updateBacklogItem: (payload) => runMcpOperation(
    () => {
      if (Array.isArray(payload)) {
        return runMcpBatch(payload, {
          schema: backlogIdBodySchema,
          handler: (parsed, index) => updateBacklogItemInternal(parsed.backlog_item_id, payload[index] || {})
        });
      }

      const { backlog_item_id: backlogItemId, ...body } = payload || {};
      return updateBacklogItemInternal(backlogItemId, body);
    },
    { fallbackMessage: 'Failed to update backlog item', logMessage: 'update_backlog_item failed' }
  ),

  deleteBacklogItem: (payload) => runMcpOperation(
    () => {
      if (Array.isArray(payload)) {
        return runMcpBatch(payload, {
          schema: backlogIdBodySchema,
          handler: (parsed) => deleteBacklogItemInternal(parsed.backlog_item_id)
        });
      }

      return deleteBacklogItemInternal(payload?.backlog_item_id);
    },
    { fallbackMessage: 'Failed to delete backlog item', logMessage: 'delete_backlog_item failed' }
  ),

  updateTaskStatus: (payload) => runMcpOperation(
    () => {
      if (Array.isArray(payload)) {
        return runMcpBatch(payload, {
          schema: taskStatusUpdateBatchBodySchema,
          handler: ({ task_id: taskId, ...body }) => updateTaskStatusInternal(taskId, body)
        });
      }

      const { task_id: rawTaskId, ...rawBody } = payload || {};
      const taskId = parseMcpPathUuid(rawTaskId, taskIdParamSchema);
      return updateTaskStatusInternal(taskId, parseMcpBody(rawBody, taskStatusUpdateBodySchema));
    },
    { fallbackMessage: 'Failed to update task status', logMessage: 'update_task_status failed' }
  ),

  logAgentProgress: (payload) => runMcpOperation(
    () => {
      if (Array.isArray(payload)) {
        return runMcpBatch(payload, {
          schema: logAgentProgressBatchBodySchema,
          handler: ({ task_id: taskId, ...body }) => logAgentProgressInternal(taskId, body)
        });
      }

      // El cliente quitaba project_url del cuerpo antes de mandarlo: la ruta de un
      // solo elemento no lo acepta y el identificador viaja en la URL.
      const { task_id: rawTaskId, project_url: _projectUrl, ...rawBody } = payload || {};
      const taskId = parseMcpPathUuid(rawTaskId, taskIdParamSchema);
      return logAgentProgressInternal(taskId, parseMcpBody(rawBody, logAgentProgressBodySchema));
    },
    { fallbackMessage: 'Failed to log agent progress', logMessage: 'log_agent_progress failed' }
  ),

  reportBlocker: (payload) => runMcpOperation(
    () => runMcpBatch(payload, {
      schema: reportBlockerBodySchema,
      handler: (item) => reportBlockerInternal(item)
    }),
    { fallbackMessage: 'Failed to report blocker', logMessage: 'report_blocker failed' }
  ),

  heartbeat: (payload) => runMcpOperation(
    () => {
      if (Array.isArray(payload)) {
        return runMcpBatch(payload, {
          schema: heartbeatBatchBodySchema,
          handler: (parsed) => heartbeatInternal(parsed.task_id)
        });
      }

      const { task_id: rawTaskId, ...rawBody } = payload || {};
      const taskId = parseMcpPathUuid(rawTaskId, taskIdParamSchema);
      // Diferencia declarada (decisión #4): el servidor valida el resto del cuerpo
      // y luego lo descarta; heartbeatInternal solo usa el identificador.
      parseMcpBody(rawBody, heartbeatBodySchema);
      return heartbeatInternal(taskId);
    },
    { fallbackMessage: 'Failed to register heartbeat', logMessage: 'heartbeat failed' }
  ),

  aptsNext: (payload) => runMcpOperation(
    () => aptsNext(db, {
      project_url: requireMcpTrimmedString(payload?.project_url, 'project_url is required'),
      agent_name: requireMcpTrimmedString(payload?.agent_name, 'agent_name is required')
    }),
    { fallbackMessage: 'Failed to resolve next method step', logMessage: 'apts_next failed' }
  ),

  aptsStatus: (payload) => runMcpOperation(
    () => {
      // La ruta lee `url` de la cadena de consulta; el contrato lo llama project_url.
      const projectUrl = requireMcpTrimmedString(payload?.project_url, 'url is required');
      const agentName = typeof payload?.agent_name === 'string' ? payload.agent_name.trim() : '';
      return methodStatus(db, { project_url: projectUrl, agent_name: agentName || null });
    },
    { fallbackMessage: 'Failed to read method status', logMessage: 'apts_status failed' }
  ),

  aptsSetStatus: (payload) => runMcpOperation(
    () => {
      const backlogItemId = payload?.backlog_item_id;
      if (!UUID_REGEX.test(backlogItemId || '')) {
        throw createHttpError(400, 'Invalid backlog item id');
      }
      if (!STORY_METHOD_STATUSES.includes(payload?.status)) {
        throw createHttpError(400, `status must be one of: ${STORY_METHOD_STATUSES.join(', ')}`);
      }
      return setMethodStatus(db, { backlog_item_id: backlogItemId, status: payload.status });
    },
    {
      fallbackMessage: 'Failed to set method status',
      logMessage: 'apts_set_status failed',
      // Atajo propio de la ruta: cuando el error trae statusCode numérico responde
      // `{ error, error_code }` tal cual, sin pasar por sendApiError —o sea sin
      // `code` y sin recorte del mensaje—. `error_code: undefined` desaparece al
      // serializar a JSON, igual que en la ruta.
      mapError: (operationError) => (typeof operationError?.statusCode === 'number'
        ? {
          statusCode: operationError.statusCode,
          payload: JSON.parse(JSON.stringify({ error: operationError.message, error_code: operationError.code }))
        }
        : null)
    }
  ),

  aptsWorkflowStep: (payload) => runMcpOperation(
    () => {
      const projectUrl = requireMcpTrimmedString(payload?.project_url, 'project_url is required');
      const agentName = requireMcpTrimmedString(payload?.agent_name, 'agent_name is required');
      const answers = payload?.answers;
      if (answers !== undefined && answers !== null && (typeof answers !== 'object' || Array.isArray(answers))) {
        throw createHttpError(400, 'answers must be an object');
      }
      return aptsWorkflowStep(db, { project_url: projectUrl, agent_name: agentName, answers });
    },
    { fallbackMessage: 'Failed to serve workflow step', logMessage: 'apts_workflow_step failed' }
  ),

  aptsSubmitStep: (payload) => runMcpOperation(
    () => {
      const projectUrl = requireMcpTrimmedString(payload?.project_url, 'project_url is required');
      const agentName = requireMcpTrimmedString(payload?.agent_name, 'agent_name is required');
      const output = payload?.output;
      if (output !== undefined && output !== null && (typeof output !== 'object' || Array.isArray(output))) {
        throw createHttpError(400, 'output must be an object');
      }
      return aptsSubmitStep(db, { project_url: projectUrl, agent_name: agentName, output });
    },
    { fallbackMessage: 'Failed to submit workflow step', logMessage: 'apts_submit_step failed' }
  ),

  createInitiative: (payload) => runMcpOperation(
    () => createInitiative(db, parseCreateInitiativeInput(payload)),
    { fallbackMessage: 'Failed to create initiative', logMessage: 'create_initiative failed' }
  ),

  setAgentRole: (payload) => runMcpOperation(
    () => setAgentRole(db, {
      project_url: requireMcpTrimmedString(payload?.project_url, 'project_url is required'),
      agent_name: requireMcpTrimmedString(payload?.agent_name, 'agent_name is required'),
      entity_key: requireMcpTrimmedString(payload?.entity_key, 'entity_key is required')
    }),
    { fallbackMessage: 'Failed to set agent role', logMessage: 'set_agent_role failed' }
  )
};

const hasMcpIdentityValue = (value) => typeof value === 'string' && value.trim().length > 0;

const readMcpHeaderIdentity = (req) => {
  const identity = {};

  for (const [field, header] of Object.entries(MCP_IDENTITY_HEADERS)) {
    const raw = req.headers[header];
    if (hasMcpIdentityValue(raw)) {
      identity[field] = raw.trim();
    }
  }

  return identity;
};

// Rellena la identidad desde la llamada primero y la cabecera después. Lo que
// siga faltando se informa para que la ruta rechace: sin project_url una llamada
// escribiría contra el proyecto equivocado (decisión #1).
const injectMcpIdentity = (payload, autoFillFields, headerIdentity) => {
  const fields = autoFillFields || [];
  if (!fields.length) return { payload, missing: [], sources: {} };

  if (Array.isArray(payload)) {
    const missing = new Set();
    const sources = {};
    const conflicts = [];
    const items = payload.map((item) => {
      const result = injectMcpIdentity(item, fields, headerIdentity);
      result.missing.forEach((field) => missing.add(field));
      Object.assign(sources, result.sources);
      conflicts.push(...(result.conflicts || []));
      return result.payload;
    });

    return { payload: items, missing: [...missing], sources, conflicts };
  }

  if (!payload || typeof payload !== 'object') {
    return { payload, missing: [...fields], sources: {}, conflicts: [] };
  }

  const enriched = { ...payload };
  const missing = [];
  const sources = {};
  const conflicts = [];

  for (const field of fields) {
    if (hasMcpIdentityValue(enriched[field])) {
      sources[field] = 'call';
      // F6-4 — "la llamada gana a la cabecera" (decisión #1) existe para el cambio de rol,
      // que va por `agent_name`. Aplicado a la identidad de PROYECTO abre otra puerta: un
      // cliente real (opencode 1.18.10) mandó `project_url` con la ruta del sistema de
      // archivos del cliente y pisó la cabecera correcta. Ahí no se pisa en silencio ni se
      // ignora en silencio: se rechaza nombrando los dos valores.
      const identityFieldName = field === 'url' ? 'project_url' : field;
      if (identityFieldName === 'project_url'
        && hasMcpIdentityValue(headerIdentity[identityFieldName])
        && String(enriched[field]).trim() !== String(headerIdentity[identityFieldName]).trim()) {
        conflicts.push({
          field,
          header_value: headerIdentity[identityFieldName],
          call_value: enriched[field]
        });
      }
      continue;
    }

    const identityField = field === 'url' ? 'project_url' : field;
    if (hasMcpIdentityValue(headerIdentity[identityField])) {
      enriched[field] = headerIdentity[identityField];
      sources[field] = 'header';
      continue;
    }

    missing.push(field);
  }

  return { payload: enriched, missing, sources, conflicts };
};

const buildMcpIdentityConflictPayload = (operationName, conflicts) => ({
  ok: false,
  error: {
    name: 'AptsIdentityError',
    message: `${operationName} sent a ${conflicts.map((c) => c.field).join(', ')} that contradicts the MCP registration header. `
      + `Omit it: the integration layer supplies the project identity.`,
    code: 'IDENTITY_CONFLICT',
    statusCode: 400,
    retriable: false,
    details: {
      operation: operationName,
      conflicts: conflicts.map((c) => ({
        field: c.field,
        header: MCP_IDENTITY_HEADER_LABELS[c.field === 'url' ? 'project_url' : c.field] || null,
        header_value: c.header_value,
        call_value: c.call_value
      }))
    }
  }
});

const buildMcpIdentityErrorPayload = (operationName, missingFields) => ({
  ok: false,
  error: {
    name: 'AptsIdentityError',
    message: `${operationName} is missing required identity fields: ${missingFields.join(', ')}. The remote surface never resolves them from the server.`,
    code: 'MISSING_IDENTITY',
    statusCode: 400,
    retriable: false,
    details: {
      operation: operationName,
      missing_fields: missingFields,
      resolution: missingFields.map((field) => {
        const identityField = field === 'url' ? 'project_url' : field;
        return {
          field,
          header: MCP_IDENTITY_HEADER_LABELS[identityField] || null,
          source: MCP_IDENTITY_HEADER_LABELS[identityField]
            ? 'MCP registration header, or this call'
            : 'this call only'
        };
      })
    }
  }
});

const isValidMcpMessage = (message) => Boolean(message)
  && typeof message === 'object'
  && !Array.isArray(message)
  && message.jsonrpc === '2.0'
  && typeof message.method === 'string';

// MCP clients are local processes and normally send no Origin; only reject when
// one is present and unknown (DNS-rebinding defense without false positives).
const isMcpOriginAllowed = (req) => {
  const origin = req.headers.origin;
  if (!hasMcpIdentityValue(origin)) return true;
  return allowedOrigins.includes(origin.trim());
};

// We never emit SSE on this route, so we only require that the client accepts JSON.
const isMcpAcceptAllowed = (req) => {
  const accept = req.headers.accept;
  if (!hasMcpIdentityValue(accept)) return true;
  return /application\/json|\*\/\*/i.test(accept);
};

app.get('/mcp', apiLimiter, (_req, res) => res
  .status(405)
  .set('Allow', 'POST')
  .json({
    jsonrpc: '2.0',
    id: null,
    error: {
      code: -32000,
      message: 'Method Not Allowed: this MCP endpoint is stateless and has no server-to-client stream. Use POST /mcp.'
    }
  }));

app.post('/mcp', apiLimiter, authenticateAgent, mcpJsonParser, async (req, res) => {
  if (!isMcpOriginAllowed(req)) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }

  if (!isMcpAcceptAllowed(req)) {
    return res.status(406).json({ error: 'Accept header must allow application/json' });
  }

  let runtime;
  try {
    runtime = await loadMcpRuntime();
  } catch (error) {
    logger.error({ err: error }, 'MCP runtime failed to load');
    return res.status(500).json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32603, message: 'MCP runtime unavailable' }
    });
  }

  const { buildError, buildResult, dispatch } = runtime.server;
  const message = req.body;

  if (!isValidMcpMessage(message)) {
    return res.status(400).json(buildError(message?.id ?? null, -32600, 'Invalid Request'));
  }

  const isNotification = message.id === undefined || message.id === null;
  const headerIdentity = readMcpHeaderIdentity(req);

  // Logged for every message, not just tool calls, so `initialize` shows whether
  // the client program actually sends the registration headers (F6-1-T4).
  logger.info({
    mcp_request: {
      method: message.method,
      client: message.params?.clientInfo?.name || null,
      identity_headers: Object.keys(headerIdentity)
    }
  }, 'MCP request');

  if (message.method === 'tools/call') {
    const operationName = message.params?.name;
    const rawArguments = message.params?.arguments;
    const payload = rawArguments === undefined || rawArguments === null ? {} : rawArguments;
    const autoFillFields = MCP_IDENTITY_FIELDS_BY_OPERATION[operationName];
    const resolved = injectMcpIdentity(payload, autoFillFields, headerIdentity);

    logger.info({
      mcp_identity: {
        operation: operationName,
        header_fields: Object.keys(headerIdentity),
        sources: resolved.sources,
        missing: resolved.missing,
        conflicts: (resolved.conflicts || []).map((c) => c.field)
      }
    }, 'MCP identity resolved');

    if ((resolved.conflicts || []).length) {
      if (isNotification) return res.status(202).end();

      const conflictPayload = buildMcpIdentityConflictPayload(operationName, resolved.conflicts);
      return res.json(buildResult(message.id, {
        content: [{ type: 'text', text: JSON.stringify(conflictPayload) }],
        structuredContent: conflictPayload,
        isError: true
      }));
    }

    if (resolved.missing.length) {
      if (isNotification) return res.status(202).end();

      const errorPayload = buildMcpIdentityErrorPayload(operationName, resolved.missing);
      return res.json(buildResult(message.id, {
        content: [{ type: 'text', text: JSON.stringify(errorPayload) }],
        structuredContent: errorPayload,
        isError: true
      }));
    }

    message.params = { ...message.params, arguments: resolved.payload };
  }

  try {
    const response = await dispatch(message, mcpLocalExecutor);
    if (!response) return res.status(202).end();
    return res.json(response);
  } catch (error) {
    logger.error({ err: error, method: message.method }, 'MCP dispatch failed');
    if (isNotification) return res.status(202).end();
    return res.status(500).json(buildError(message.id, -32603, 'Internal error', {
      message: error?.message || String(error)
    }));
  }
});

// Skill 0: register_task
app.post('/api/projects/tasks', apiLimiter, authenticateAgent, async (req, res) => {
  const { isBatch, items, error } = normalizeBatchRequestBody(req.body);
  if (error) {
    return res.status(400).json({ error });
  }
  const useStrictBatchMode = shouldUseStrictBatchMode(req, isBatch);

  let parsedItems;
  try {
    parsedItems = parseBatchItems(items, registerTaskBodySchema);
  } catch (parseError) {
    return res.status(400).json({ error: parseError.message });
  }

  try {
    if (!isBatch) {
      const createdTask = await registerTaskInternal(parsedItems[0]);
      return res.json(createdTask);
    }

    if (useStrictBatchMode) {
      const results = await executeStrictBatchOperation(parsedItems, async (payload, _index, options) => registerTaskInternal(payload, options));
      return sendBatchOperationResponse(res, results);
    }

    const results = await executeBatchOperation(parsedItems, async (payload) => registerTaskInternal(payload));
    return sendBatchOperationResponse(res, results);
  } catch (routeError) {
    return sendBatchRouteError(res, routeError, {
      strict: useStrictBatchMode,
      fallbackMessage: 'Failed to register task',
      logMessage: 'register_task failed'
    });
  }
});

// Skill 1: read_project_context
app.get('/api/projects/context', apiLimiter, authenticateAgent, async (req, res) => {
  try {
    const options = parseReadProjectContextOptions(req.query);
    return res.json(await readProjectContextInternal(options));
  } catch (routeError) {
    return sendApiError(res, routeError, {
      fallbackMessage: 'Failed to read project context',
      logMessage: 'read_project_context failed'
    });
  }
});

app.get('/api/projects', apiLimiter, authenticateAgent, async (_req, res) => {
  try {
    const projects = await listProjectsSummary();
    return res.json({ projects });
  } catch (routeError) {
    return sendApiError(res, routeError, {
      fallbackMessage: 'Failed to list projects',
      logMessage: 'list_projects failed'
    });
  }
});

app.get('/api/projects/:url/constraints', apiLimiter, authenticateAgent, async (req, res) => {
  try {
    const url = normalizeUrl(decodeURIComponent(req.params.url));

    if (!url) {
      return res.status(400).json({ error: 'Project url is required' });
    }

    const constraints = await getProjectConstraints(url);
    return res.json(constraints);
  } catch (routeError) {
    return sendApiError(res, routeError, {
      fallbackMessage: 'Failed to read project constraints',
      logMessage: 'read_project_constraints failed',
      logContext: { project_url: req.params.url }
    });
  }
});

// Skill 1b: list_backlog_items
app.get('/api/projects/backlog', apiLimiter, authenticateAgent, async (req, res) => {
  try {
    const { url, status, ...listOptions } = parseListBacklogItemsOptions(req.query);
    const backlog = await listBacklogItems(url, status, listOptions);
    return res.json({ backlog });
  } catch (routeError) {
    return sendApiError(res, routeError, {
      fallbackMessage: 'Failed to list backlog items',
      logMessage: 'list_backlog_items failed'
    });
  }
});

// Skill 1e: search_similar_bug_reports
app.post('/api/projects/backlog/semantic-search', apiLimiter, authenticateAgent, async (req, res) => {
  const parsedBody = semanticBugSearchBodySchema.safeParse(req.body || {});
  if (!parsedBody.success) {
    return res.status(400).json({ error: zodErrorMessage(parsedBody.error) });
  }

  try {
    return res.json(await searchSimilarBugReportsOperation(parsedBody.data));
  } catch (routeError) {
    return sendApiError(res, routeError, {
      fallbackMessage: 'Failed to execute semantic bug search',
      logMessage: 'semantic_bug_search failed'
    });
  }
});

// Skill 1c: create_backlog_item
app.post('/api/projects/backlog', apiLimiter, authenticateAgent, async (req, res) => {
  const { isBatch, items, error } = normalizeBatchRequestBody(req.body);
  if (error) {
    return res.status(400).json({ error });
  }
  const useStrictBatchMode = shouldUseStrictBatchMode(req, isBatch);

  if (isBatch) {
    try {
      assertBacklogCreateBatchItems(items);
    } catch (parseError) {
      return res.status(400).json({ error: parseError.message });
    }
  }

  try {
    if (!isBatch) {
      const created = await createBacklogItemInternal(items[0]);
      return res.status(201).json(created);
    }

    if (useStrictBatchMode) {
      const results = await executeStrictBatchOperation(items, async (payload, _index, options) => createBacklogItemInternal(payload, options));
      return sendBatchOperationResponse(res, results, { successStatus: 201 });
    }

    const results = await executeBatchOperation(items, async (payload) => createBacklogItemInternal(payload));
    return sendBatchOperationResponse(res, results, { successStatus: 201 });
  } catch (routeError) {
    return sendBatchRouteError(res, routeError, {
      strict: useStrictBatchMode,
      fallbackMessage: 'Failed to create backlog item',
      logMessage: 'create_backlog_item failed'
    });
  }
});

app.get('/api/backlog/:id', apiLimiter, authenticateAgent, async (req, res) => {
  const parsedParams = backlogIdParamSchema.safeParse(req.params || {});
  if (!parsedParams.success) {
    return res.status(400).json({ error: zodErrorMessage(parsedParams.error) });
  }

  try {
    const options = parseGetBacklogItemOptions(req.query);
    return res.json(await getBacklogItemInternal(parsedParams.data.id, options));
  } catch (routeError) {
    return sendApiError(res, routeError, {
      fallbackMessage: 'Failed to read backlog item',
      logMessage: 'read_backlog_item failed',
      logContext: { backlog_item_id: req.params.id }
    });
  }
});

// Skill 1d: update_backlog_item
app.patch('/api/backlog/:id', apiLimiter, authenticateAgent, async (req, res) => {
  try {
    const updated = await updateBacklogItemInternal(req.params.id, req.body);
    return res.json(updated);
  } catch (routeError) {
    return sendApiError(res, routeError, {
      fallbackMessage: 'Failed to update backlog item',
      logMessage: 'update_backlog_item failed',
      logContext: { backlog_item_id: req.params.id }
    });
  }
});

app.delete('/api/backlog/:id', apiLimiter, authenticateAgent, async (req, res) => {
  try {
    const deleted = await deleteBacklogItemInternal(req.params.id);
    return res.json(deleted);
  } catch (routeError) {
    return sendApiError(res, routeError, {
      fallbackMessage: 'Failed to delete backlog item',
      logMessage: 'delete_backlog_item failed',
      logContext: { backlog_item_id: req.params.id }
    });
  }
});

app.patch('/api/backlog', apiLimiter, authenticateAgent, async (req, res) => {
  const { isBatch, items, error } = normalizeBatchRequestBody(req.body);
  if (error) {
    return res.status(400).json({ error });
  }
  const useStrictBatchMode = shouldUseStrictBatchMode(req, isBatch);

  let normalizedItems;
  try {
    normalizedItems = parseBatchItems(items, backlogIdBodySchema).map((parsed, index) => ({
      backlog_item_id: parsed.backlog_item_id,
      body: items[index] || {}
    }));
  } catch (parseError) {
    return res.status(400).json({ error: parseError.message });
  }

  try {
    if (!isBatch) {
      const updated = await updateBacklogItemInternal(normalizedItems[0].backlog_item_id, normalizedItems[0].body);
      return res.json(updated);
    }

    if (useStrictBatchMode) {
      const results = await executeStrictBatchOperation(normalizedItems, async (item, _index, options) => updateBacklogItemInternal(item.backlog_item_id, item.body, options));
      return sendBatchOperationResponse(res, results);
    }

    const results = await executeBatchOperation(normalizedItems, async (item) => updateBacklogItemInternal(item.backlog_item_id, item.body));
    return sendBatchOperationResponse(res, results);
  } catch (routeError) {
    return sendBatchRouteError(res, routeError, {
      strict: useStrictBatchMode,
      fallbackMessage: 'Failed to update backlog items',
      logMessage: 'batch_update_backlog failed'
    });
  }
});

app.delete('/api/backlog', apiLimiter, authenticateAgent, async (req, res) => {
  const { isBatch, items, error } = normalizeBatchRequestBody(req.body);
  if (error) {
    return res.status(400).json({ error });
  }
  const useStrictBatchMode = shouldUseStrictBatchMode(req, isBatch);

  let normalizedItems;
  try {
    normalizedItems = parseBatchItems(items, backlogIdBodySchema).map((parsed) => parsed.backlog_item_id);
  } catch (parseError) {
    return res.status(400).json({ error: parseError.message });
  }

  try {
    if (!isBatch) {
      const deleted = await deleteBacklogItemInternal(normalizedItems[0]);
      return res.json(deleted);
    }

    if (useStrictBatchMode) {
      const results = await executeStrictBatchOperation(normalizedItems, async (backlogItemId, _index, options) => deleteBacklogItemInternal(backlogItemId, options));
      return sendBatchOperationResponse(res, results);
    }

    const results = await executeBatchOperation(normalizedItems, async (backlogItemId) => deleteBacklogItemInternal(backlogItemId));
    return sendBatchOperationResponse(res, results);
  } catch (routeError) {
    return sendBatchRouteError(res, routeError, {
      strict: useStrictBatchMode,
      fallbackMessage: 'Failed to delete backlog items',
      logMessage: 'batch_delete_backlog failed'
    });
  }
});

// F5-1 — create_initiative: operación de bootstrap del método conducible desde el
// cliente. Forward fino hacia scripts/lib/method_bootstrap.js. Crea —idempotente
// por (project_url, status='active')— la iniciativa en 'analysis' + 1 epic vacío
// plegado + (opcional) la spec del cliente como semantic_documents tipado. Tras el
// bootstrap, apts_next deja de devolver 'blocked' y entrega el primer step real.
app.post('/api/projects/initiatives', apiLimiter, authenticateAgent, async (req, res) => {
  try {
    const input = parseCreateInitiativeInput(req.body);
    const payload = await createInitiative(db, input);
    return res.status(payload.created ? 201 : 200).json(payload);
  } catch (routeError) {
    return sendApiError(res, routeError, {
      fallbackMessage: 'Failed to create initiative',
      logMessage: 'create_initiative failed',
      logContext: { project_url: req.body?.project_url }
    });
  }
});

// F5-1-T2 — set_agent_role: registra/actualiza el puntero de un rol del roster en
// project_state para la iniciativa activa. Forward fino hacia method_bootstrap.js.
// Upsert idempotente sobre unique(initiative_id, agent_name); resuelve
// entity_key→entity_id contra la librería de la iniciativa y lo persiste no-null
// (entity_id=null = wait eterno en el resolver). Tras asignar el roster, apts_next
// entrega run_step al rol requerido en vez de wait.
app.post('/api/projects/agent-roles', apiLimiter, authenticateAgent, async (req, res) => {
  const projectUrl = typeof req.body?.project_url === 'string' ? req.body.project_url.trim() : '';
  const agentName = typeof req.body?.agent_name === 'string' ? req.body.agent_name.trim() : '';
  const entityKey = typeof req.body?.entity_key === 'string' ? req.body.entity_key.trim() : '';
  if (!projectUrl) {
    return res.status(400).json({ error: 'project_url is required' });
  }
  if (!agentName) {
    return res.status(400).json({ error: 'agent_name is required' });
  }
  if (!entityKey) {
    return res.status(400).json({ error: 'entity_key is required' });
  }

  try {
    const payload = await setAgentRole(db, {
      project_url: projectUrl,
      agent_name: agentName,
      entity_key: entityKey,
    });
    return res.status(payload.created ? 201 : 200).json(payload);
  } catch (routeError) {
    return sendApiError(res, routeError, {
      fallbackMessage: 'Failed to set agent role',
      logMessage: 'set_agent_role failed',
      logContext: { project_url: projectUrl, agent_name: agentName }
    });
  }
});

// F1-T4: motor de método (servidor-autoritativo). Forwards finos hacia el
// resolver/máquina de estados en scripts/lib/method_resolver.js.
// apts_next: resuelve la próxima directiva determinista para el agente.
app.post('/api/projects/next', apiLimiter, authenticateAgent, async (req, res) => {
  const projectUrl = typeof req.body?.project_url === 'string' ? req.body.project_url.trim() : '';
  const agentName = typeof req.body?.agent_name === 'string' ? req.body.agent_name.trim() : '';
  if (!projectUrl) {
    return res.status(400).json({ error: 'project_url is required' });
  }
  if (!agentName) {
    return res.status(400).json({ error: 'agent_name is required' });
  }

  try {
    const payload = await aptsNext(db, { project_url: projectUrl, agent_name: agentName });
    return res.json(payload);
  } catch (routeError) {
    return sendApiError(res, routeError, {
      fallbackMessage: 'Failed to resolve next method step',
      logMessage: 'apts_next failed',
      logContext: { project_url: projectUrl, agent_name: agentName }
    });
  }
});

// apts_status (data-mode): conteos + recomendación read-only. Solo lectura.
app.get('/api/projects/method-status', apiLimiter, authenticateAgent, async (req, res) => {
  const projectUrl = typeof req.query.url === 'string' ? req.query.url.trim() : '';
  const agentName = typeof req.query.agent_name === 'string' ? req.query.agent_name.trim() : '';
  if (!projectUrl) {
    return res.status(400).json({ error: 'url is required' });
  }

  try {
    const payload = await methodStatus(db, { project_url: projectUrl, agent_name: agentName || null });
    return res.json(payload);
  } catch (routeError) {
    return sendApiError(res, routeError, {
      fallbackMessage: 'Failed to read method status',
      logMessage: 'apts_status failed',
      logContext: { project_url: projectUrl }
    });
  }
});

// apts_set_status: transición de método validada para una story (máquina de
// estados, distinta de PATCH /backlog/:id que es edición libre).
app.patch('/api/backlog/:id/method-status', apiLimiter, authenticateAgent, async (req, res) => {
  const id = req.params.id;
  if (!UUID_REGEX.test(id || '')) {
    return res.status(400).json({ error: 'Invalid backlog item id' });
  }
  const status = req.body?.status;
  if (!STORY_METHOD_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${STORY_METHOD_STATUSES.join(', ')}` });
  }

  try {
    const result = await setMethodStatus(db, { backlog_item_id: id, status });
    return res.json(result);
  } catch (routeError) {
    if (routeError && typeof routeError.statusCode === 'number') {
      return res.status(routeError.statusCode).json({ error: routeError.message, error_code: routeError.code });
    }
    return sendApiError(res, routeError, {
      fallbackMessage: 'Failed to set method status',
      logMessage: 'apts_set_status failed',
      logContext: { backlog_item_id: id }
    });
  }
});

// F3-T2/T3 — apts_workflow_step: goteo modelo B. Sirve el paso actual reconstruido
// desde el estado (rewire en serve-time + needs acotados); `answers` reanuda una
// elicitación pausada (await_input). Server-autoritativo (lee/inicializa el cursor).
app.post('/api/projects/workflow-step', apiLimiter, authenticateAgent, async (req, res) => {
  const projectUrl = typeof req.body?.project_url === 'string' ? req.body.project_url.trim() : '';
  const agentName = typeof req.body?.agent_name === 'string' ? req.body.agent_name.trim() : '';
  if (!projectUrl) {
    return res.status(400).json({ error: 'project_url is required' });
  }
  if (!agentName) {
    return res.status(400).json({ error: 'agent_name is required' });
  }
  const answers = req.body?.answers;
  if (answers !== undefined && answers !== null && (typeof answers !== 'object' || Array.isArray(answers))) {
    return res.status(400).json({ error: 'answers must be an object' });
  }

  try {
    const payload = await aptsWorkflowStep(db, { project_url: projectUrl, agent_name: agentName, answers });
    return res.json(payload);
  } catch (routeError) {
    return sendApiError(res, routeError, {
      fallbackMessage: 'Failed to serve workflow step',
      logMessage: 'apts_workflow_step failed',
      logContext: { project_url: projectUrl, agent_name: agentName }
    });
  }
});

// F3-T4 — apts_submit_step: captura el output del paso (doc→semantic_documents
// tipados / código→referencia / iterable→status de story) y avanza el cursor.
app.post('/api/projects/submit-step', apiLimiter, authenticateAgent, async (req, res) => {
  const projectUrl = typeof req.body?.project_url === 'string' ? req.body.project_url.trim() : '';
  const agentName = typeof req.body?.agent_name === 'string' ? req.body.agent_name.trim() : '';
  if (!projectUrl) {
    return res.status(400).json({ error: 'project_url is required' });
  }
  if (!agentName) {
    return res.status(400).json({ error: 'agent_name is required' });
  }
  const output = req.body?.output;
  if (output !== undefined && output !== null && (typeof output !== 'object' || Array.isArray(output))) {
    return res.status(400).json({ error: 'output must be an object' });
  }

  try {
    const payload = await aptsSubmitStep(db, { project_url: projectUrl, agent_name: agentName, output });
    return res.json(payload);
  } catch (routeError) {
    return sendApiError(res, routeError, {
      fallbackMessage: 'Failed to submit workflow step',
      logMessage: 'apts_submit_step failed',
      logContext: { project_url: projectUrl, agent_name: agentName }
    });
  }
});

app.get('/api/tasks/:id', apiLimiter, authenticateAgent, async (req, res) => {
  const parsedParams = taskIdParamSchema.safeParse(req.params || {});
  if (!parsedParams.success) {
    return res.status(400).json({ error: zodErrorMessage(parsedParams.error) });
  }

  try {
    const options = parseGetTaskOptions(req.query);
    return res.json(await getTaskInternal(parsedParams.data.id, options));
  } catch (routeError) {
    return sendApiError(res, routeError, {
      fallbackMessage: 'Failed to read task details',
      logMessage: 'read_task_details failed',
      logContext: { task_id: req.params.id }
    });
  }
});

// Skill 2: update_task_status
app.patch('/api/tasks/:id/status', apiLimiter, authenticateAgent, async (req, res) => {
  const parsedParams = taskIdParamSchema.safeParse(req.params || {});
  if (!parsedParams.success) {
    return res.status(400).json({ error: zodErrorMessage(parsedParams.error) });
  }

  const parsedBody = taskStatusUpdateBodySchema.safeParse(req.body || {});
  if (!parsedBody.success) {
    return res.status(400).json({ error: zodErrorMessage(parsedBody.error) });
  }

  try {
    const updated = await updateTaskStatusInternal(parsedParams.data.id, parsedBody.data);
    return res.json(updated);
  } catch (routeError) {
    return sendApiError(res, routeError, {
      fallbackMessage: 'Failed to update task status',
      logMessage: 'update_task_status failed',
      logContext: { task_id: parsedParams.data.id }
    });
  }
});

app.patch('/api/tasks/status', apiLimiter, authenticateAgent, async (req, res) => {
  const { isBatch, items, error } = normalizeBatchRequestBody(req.body);
  if (error) {
    return res.status(400).json({ error });
  }
  const useStrictBatchMode = shouldUseStrictBatchMode(req, isBatch);

  let parsedItems;
  try {
    parsedItems = parseBatchItems(items, taskStatusUpdateBatchBodySchema);
  } catch (parseError) {
    return res.status(400).json({ error: parseError.message });
  }

  try {
    if (!isBatch) {
      const { task_id: taskId, ...body } = parsedItems[0];
      const updated = await updateTaskStatusInternal(taskId, body);
      return res.json(updated);
    }

    if (useStrictBatchMode) {
      const results = await executeStrictBatchOperation(parsedItems, async (payload, _index, options) => {
        const { task_id: taskId, ...body } = payload;
        return updateTaskStatusInternal(taskId, body, options);
      });
      return sendBatchOperationResponse(res, results);
    }

    const results = await executeBatchOperation(parsedItems, async (payload) => {
      const { task_id: taskId, ...body } = payload;
      return updateTaskStatusInternal(taskId, body);
    });

    return sendBatchOperationResponse(res, results);
  } catch (routeError) {
    return sendBatchRouteError(res, routeError, {
      strict: useStrictBatchMode,
      fallbackMessage: 'Failed to update task statuses',
      logMessage: 'batch_update_task_status failed'
    });
  }
});

// Skill 3: log_agent_progress
app.post('/api/tasks/:id/logs', apiLimiter, authenticateAgent, async (req, res) => {
  const parsedParams = taskIdParamSchema.safeParse(req.params || {});
  if (!parsedParams.success) {
    return res.status(400).json({ error: zodErrorMessage(parsedParams.error) });
  }

  const parsedBody = logAgentProgressBodySchema.safeParse(req.body || {});
  if (!parsedBody.success) {
    return res.status(400).json({ error: zodErrorMessage(parsedBody.error) });
  }

  try {
    const logged = await logAgentProgressInternal(parsedParams.data.id, parsedBody.data);
    return res.json(logged);
  } catch (routeError) {
    return sendApiError(res, routeError, {
      fallbackMessage: 'Failed to log agent progress',
      logMessage: 'log_agent_progress failed',
      logContext: { task_id: parsedParams.data.id }
    });
  }
});

app.post('/api/tasks/logs', apiLimiter, authenticateAgent, async (req, res) => {
  const { isBatch, items, error } = normalizeBatchRequestBody(req.body);
  if (error) {
    return res.status(400).json({ error });
  }
  const useStrictBatchMode = shouldUseStrictBatchMode(req, isBatch);

  let parsedItems;
  try {
    parsedItems = parseBatchItems(items, logAgentProgressBatchBodySchema);
  } catch (parseError) {
    return res.status(400).json({ error: parseError.message });
  }

  try {
    if (!isBatch) {
      const { task_id: taskId, ...body } = parsedItems[0];
      const logged = await logAgentProgressInternal(taskId, body);
      return res.json(logged);
    }

    if (useStrictBatchMode) {
      const results = await executeStrictBatchOperation(parsedItems, async (payload, _index, options) => {
        const { task_id: taskId, ...body } = payload;
        return logAgentProgressInternal(taskId, body, options);
      });
      return sendBatchOperationResponse(res, results);
    }

    const results = await executeBatchOperation(parsedItems, async (payload) => {
      const { task_id: taskId, ...body } = payload;
      return logAgentProgressInternal(taskId, body);
    });

    return sendBatchOperationResponse(res, results);
  } catch (routeError) {
    return sendBatchRouteError(res, routeError, {
      strict: useStrictBatchMode,
      fallbackMessage: 'Failed to log agent progress',
      logMessage: 'batch_log_agent_progress failed'
    });
  }
});

// Skill 4: report_blocker
app.post('/api/projects/blockers', apiLimiter, authenticateAgent, async (req, res) => {
  const { isBatch, items, error } = normalizeBatchRequestBody(req.body);
  if (error) {
    return res.status(400).json({ error });
  }
  const useStrictBatchMode = shouldUseStrictBatchMode(req, isBatch);

  let parsedItems;
  try {
    parsedItems = parseBatchItems(items, reportBlockerBodySchema);
  } catch (parseError) {
    return res.status(400).json({ error: parseError.message });
  }

  try {
    if (!isBatch) {
      const reported = await reportBlockerInternal(parsedItems[0]);
      return res.json(reported);
    }

    if (useStrictBatchMode) {
      const results = await executeStrictBatchOperation(parsedItems, async (payload, _index, options) => reportBlockerInternal(payload, options));
      return sendBatchOperationResponse(res, results);
    }

    const results = await executeBatchOperation(parsedItems, async (payload) => reportBlockerInternal(payload));
    return sendBatchOperationResponse(res, results);
  } catch (routeError) {
    return sendBatchRouteError(res, routeError, {
      strict: useStrictBatchMode,
      fallbackMessage: 'Failed to report blocker',
      logMessage: 'report_blocker failed'
    });
  }
});

// Skill 5: heartbeat
app.post('/api/tasks/:id/heartbeat', apiLimiter, authenticateAgent, async (req, res) => {
  const parsedParams = taskIdParamSchema.safeParse(req.params || {});
  if (!parsedParams.success) {
    return res.status(400).json({ error: zodErrorMessage(parsedParams.error) });
  }

  const parsedBody = heartbeatBodySchema.safeParse(req.body || {});
  if (!parsedBody.success) {
    return res.status(400).json({ error: zodErrorMessage(parsedBody.error) });
  }

  try {
    const updated = await heartbeatInternal(parsedParams.data.id);
    return res.json(updated);
  } catch (routeError) {
    return sendApiError(res, routeError, {
      fallbackMessage: 'Failed to register heartbeat',
      logMessage: 'heartbeat failed',
      logContext: { task_id: parsedParams.data.id }
    });
  }
});

app.post('/api/tasks/heartbeat', apiLimiter, authenticateAgent, async (req, res) => {
  const { isBatch, items, error } = normalizeBatchRequestBody(req.body);
  if (error) {
    return res.status(400).json({ error });
  }
  const useStrictBatchMode = shouldUseStrictBatchMode(req, isBatch);

  let parsedItems;
  try {
    parsedItems = parseBatchItems(items, heartbeatBatchBodySchema);
  } catch (parseError) {
    return res.status(400).json({ error: parseError.message });
  }

  try {
    if (!isBatch) {
      const heartbeatResult = await heartbeatInternal(parsedItems[0].task_id);
      return res.json(heartbeatResult);
    }

    if (useStrictBatchMode) {
      const results = await executeStrictBatchOperation(parsedItems, async (payload, _index, options) => heartbeatInternal(payload.task_id, options));
      return sendBatchOperationResponse(res, results);
    }

    const results = await executeBatchOperation(parsedItems, async (payload) => heartbeatInternal(payload.task_id));
    return sendBatchOperationResponse(res, results);
  } catch (routeError) {
    return sendBatchRouteError(res, routeError, {
      strict: useStrictBatchMode,
      fallbackMessage: 'Failed to register heartbeat',
      logMessage: 'batch_heartbeat failed'
    });
  }
});

// --- DASHBOARD API ---
app.post('/api/login', loginLimiter, (req, res) => {
  const { password } = req.body;
  if (password === (process.env.DASHBOARD_PASSWORD || 'admin')) {
    req.session.authenticated = true;
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

app.post('/api/logout', (req, res) => {
  if (!req.session) {
    res.clearCookie('connect.sid', { path: '/' });
    return res.json({ success: true });
  }

  req.session.destroy((destroyError) => {
    if (destroyError) {
      logger.error({ err: destroyError }, 'Logout failed');
      return res.status(500).json({ error: 'Failed to close session' });
    }

    res.clearCookie('connect.sid', { path: '/' });
    res.json({ success: true });
  });
});

const requireAuth = (req, res, next) => {
  if (req.session.authenticated) next();
  else res.status(401).json({ error: 'Unauthorized' });
};

app.get('/api/dashboard/overview', requireAuth, async (req, res) => {
  try {
    const usageDays = req.query.usage_days;
    const [projects, tasks, feed, openRouterUsage] = await Promise.all([
      db('projects').select('*'),
      db('tasks').select('*'),
      db('agent_logs')
        .join('tasks', 'agent_logs.task_id', 'tasks.id')
        .orderBy('agent_logs.created_at', 'desc')
        .limit(20)
        .select('agent_logs.*', 'tasks.title as task_title', 'tasks.project_url'),
      getOpenRouterUsageSummary({ days: usageDays })
    ]);

    res.json({
      projects,
      tasks,
      feed,
      openrouter_usage: openRouterUsage
    });
  } catch (error) {
    return sendApiError(res, error, {
      fallbackMessage: 'Failed to load dashboard overview',
      logMessage: 'Dashboard overview failed'
    });
  }
});

app.get('/api/dashboard/projects', requireAuth, async (req, res) => {
  try {
    const projects = await listProjectsSummary();
    res.json({ projects });
  } catch (error) {
    return sendApiError(res, error, {
      fallbackMessage: 'Failed to load projects',
      logMessage: 'Dashboard projects failed'
    });
  }
});

app.get('/api/dashboard/projects/:url', requireAuth, async (req, res) => {
  try {
    const url = normalizeUrl(decodeURIComponent(req.params.url));
    const project = await db('projects').where({ url }).first();
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const tasks = await db('tasks').where({ project_url: url }).orderBy('updated_at', 'desc');
    const includeDeleted = parseBooleanFlag(req.query.include_deleted);
    const backlog = await listBacklogItems(url, null, { includeDeleted });
    const logs = await db('agent_logs')
      .join('tasks', 'agent_logs.task_id', 'tasks.id')
      .where('tasks.project_url', url)
      .orderBy('agent_logs.created_at', 'desc')
      .select('agent_logs.*', 'tasks.title as task_title');

    res.json({ project, tasks, backlog, logs });
  } catch (error) {
    return sendApiError(res, error, {
      fallbackMessage: 'Failed to load project details',
      logMessage: 'Dashboard project details failed',
      logContext: { project_url: req.params.url }
    });
  }
});

app.get('/api/dashboard/projects/:url/backlog', requireAuth, async (req, res) => {
  try {
    const url = normalizeUrl(decodeURIComponent(req.params.url));
    const includeDeleted = parseBooleanFlag(req.query.include_deleted);
    const backlog = await listBacklogItems(url, req.query.status, { includeDeleted });
    res.json({ backlog });
  } catch (error) {
    return sendApiError(res, error, {
      fallbackMessage: 'Failed to load backlog',
      logMessage: 'Dashboard backlog list failed',
      logContext: { project_url: req.params.url }
    });
  }
});

app.get('/api/dashboard/projects/:url/semantic/backlog/status', requireAuth, async (req, res) => {
  try {
    const url = normalizeUrl(decodeURIComponent(req.params.url));
    const project = await db('projects').where({ url }).first('url');
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const semantic = await enrichSemanticStatusWithPricing(await getProjectBacklogCoverageStatus(db, url));
    return res.json({ semantic });
  } catch (error) {
    return sendApiError(res, normalizeSemanticError(error, {
      unavailableMessage: 'Semantic status is temporarily unavailable',
      internalMessage: 'Failed to calculate semantic status',
      unavailableCode: 'SEMANTIC_STATUS_UNAVAILABLE',
      internalCode: 'SEMANTIC_STATUS_FAILED'
    }), {
      fallbackMessage: 'Failed to calculate semantic status',
      logMessage: 'Semantic status failed',
      logContext: { project_url: req.params.url }
    });
  }
});

app.post('/api/dashboard/projects/:url/semantic/backlog/index', requireAuth, async (req, res) => {
  try {
    const url = normalizeUrl(decodeURIComponent(req.params.url));
    const project = await db('projects').where({ url }).first('url');
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const before = await enrichSemanticStatusWithPricing(await getProjectBacklogCoverageStatus(db, url));
    const results = await syncProjectBacklogCoverageDocuments(db, url).catch((error) => {
      throw normalizeSemanticError(error, {
        unavailableMessage: 'Semantic indexing is temporarily unavailable',
        internalMessage: 'Semantic indexing failed',
        unavailableCode: 'SEMANTIC_INDEX_UNAVAILABLE',
        internalCode: 'SEMANTIC_INDEX_FAILED'
      });
    });
    const semantic = await enrichSemanticStatusWithPricing(await getProjectBacklogCoverageStatus(db, url));

    return res.json({
      semantic,
      sync: {
        processed_documents: results.length,
        embedded_documents: results.filter((result) => result.status === 'embedded').length,
        unchanged_documents: results.filter((result) => result.status === 'unchanged').length,
        deleted_documents: results.filter((result) => result.status === 'deleted').length,
        skipped_documents: results.filter((result) => result.status === 'skipped').length,
        previous_estimated_input_tokens: before.estimated_input_tokens
      }
    });
  } catch (error) {
    return sendApiError(res, error, {
      fallbackMessage: 'Failed to index semantic backlog',
      logMessage: 'Semantic index failed',
      logContext: { project_url: req.params.url }
    });
  }
});

app.post('/api/dashboard/projects/:url/semantic/backlog/search', requireAuth, async (req, res) => {
  const parsedBody = dashboardSemanticSearchBodySchema.safeParse(req.body || {});
  if (!parsedBody.success) {
    return res.status(400).json({ error: zodErrorMessage(parsedBody.error) });
  }

  try {
    const url = normalizeUrl(decodeURIComponent(req.params.url));
    const project = await db('projects').where({ url }).first('url');
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const semantic = await enrichSemanticStatusWithPricing(await getProjectBacklogCoverageStatus(db, url));
    if (semantic.indexed_documents === 0) {
      return res.status(409).json({
        error: 'Project backlog has not been semantically indexed yet',
        semantic
      });
    }

    const topK = Math.max(1, Math.min(MAX_SEMANTIC_SEARCH_TOP_K, parsedBody.data.top_k ?? DEFAULT_SEMANTIC_SEARCH_TOP_K));
    const threshold = parsedBody.data.threshold ?? DEFAULT_BACKLOG_COVERAGE_SEARCH_THRESHOLD;
    const result = await searchProjectBacklogCoverage(db, {
      projectUrl: url,
      queryText: parsedBody.data.query_text,
      itemTypes: parsedBody.data.item_types || [],
      statuses: parsedBody.data.statuses || [],
      topK,
      threshold
    }).catch((error) => {
      throw normalizeSemanticError(error, {
        unavailableMessage: 'Semantic search is temporarily unavailable',
        internalMessage: 'Semantic search failed',
        unavailableCode: 'SEMANTIC_SEARCH_UNAVAILABLE',
        internalCode: 'SEMANTIC_SEARCH_FAILED'
      });
    });

    return res.json({
      semantic,
      search: result
    });
  } catch (error) {
    return sendApiError(res, error, {
      fallbackMessage: 'Failed to execute semantic search',
      logMessage: 'Semantic search failed',
      logContext: { project_url: req.params.url }
    });
  }
});

app.post('/api/dashboard/projects/:url/backlog', requireAuth, async (req, res) => {
  try {
    const url = normalizeUrl(decodeURIComponent(req.params.url));
    const result = await createBacklogItemInternal({
      ...req.body,
      project_url: url
    }, { connection: db });
    return res.status(201).json(result);
  } catch (error) {
    return sendApiError(res, error, {
      fallbackMessage: 'Failed to create backlog item',
      logMessage: 'Dashboard backlog creation failed',
      logContext: { project_url: req.params.url }
    });
  }
});

app.patch('/api/dashboard/backlog/:id', requireAuth, async (req, res) => {
  try {
    const result = await updateBacklogItemInternal(req.params.id, req.body, { connection: db });
    return res.json(result);
  } catch (error) {
    return sendApiError(res, error, {
      fallbackMessage: 'Failed to update backlog item',
      logMessage: 'Dashboard backlog update failed',
      logContext: { backlog_item_id: req.params.id }
    });
  }
});

app.delete('/api/dashboard/backlog/:id', requireAuth, async (req, res) => {
  try {
    const result = await deleteBacklogItemInternal(req.params.id, { connection: db });
    return res.json(result);
  } catch (error) {
    return sendApiError(res, error, {
      fallbackMessage: 'Failed to delete backlog item',
      logMessage: 'Dashboard backlog delete failed',
      logContext: { backlog_item_id: req.params.id }
    });
  }
});

app.post('/api/dashboard/backlog/:id/analyze', requireAuth, async (req, res) => {
  try {
    const backlogItem = mapBacklogItemRecord(
      await db('backlog_items')
        .where({ id: req.params.id })
        .whereNull('deleted_at')
        .first()
    );

    if (!backlogItem) {
      return res.status(404).json({ error: 'Backlog item not found' });
    }

    const analyzedItem = await persistBacklogAnalysis(backlogItem);
    res.json({ backlog_item: analyzedItem });
  } catch (error) {
    return sendApiError(res, error, {
      fallbackMessage: 'Failed to analyze backlog item',
      logMessage: 'Backlog analysis failed',
      logContext: { backlog_item_id: req.params.id }
    });
  }
});

app.post('/api/dashboard/projects/:url/backlog/analyze', requireAuth, async (req, res) => {
  try {
    const url = normalizeUrl(decodeURIComponent(req.params.url));
    const requestedStatuses = Array.isArray(req.body?.statuses)
      ? req.body.statuses.filter((status) => AUTO_TRIAGE_BACKLOG_STATUSES.has(status))
      : [];
    const statuses = requestedStatuses.length
      ? requestedStatuses
      : [...AUTO_TRIAGE_BACKLOG_STATUSES];
    const backlogItems = await db('backlog_items')
      .where({ project_url: url })
      .whereNull('deleted_at')
      .whereIn('status', statuses)
      .orderBy([
        { column: 'priority', order: 'asc' },
        { column: 'sort_order', order: 'asc' },
        { column: 'created_at', order: 'asc' }
      ])
      .select('*');

    const analyzed = [];
    for (const backlogItem of backlogItems.map(mapBacklogItemRecord)) {
      analyzed.push(await persistBacklogAnalysis(backlogItem));
    }

    res.json({
      backlog: analyzed,
      analyzed_count: analyzed.length
    });
  } catch (error) {
    return sendApiError(res, error, {
      fallbackMessage: 'Failed to analyze project backlog',
      logMessage: 'Project backlog analysis failed',
      logContext: { project_url: req.params.url }
    });
  }
});

app.get('/api/dashboard/config/openrouter', requireAuth, async (_req, res) => {
  try {
    const selectedModel = await getConfigValue(CONFIG_KEYS.openrouterModel);
    const selectedEmbeddingModel = await getConfigValue(CONFIG_KEYS.openrouterEmbeddingModel);

    res.json({
      openrouter: {
        api_key_configured: Boolean((process.env.OPENROUTER_API_KEY || '').trim()),
        selected_model: selectedModel,
        effective_model: selectedModel || DEFAULT_OPENROUTER_MODEL,
        default_model: DEFAULT_OPENROUTER_MODEL,
        selected_embedding_model: selectedEmbeddingModel,
        effective_embedding_model: selectedEmbeddingModel || DEFAULT_OPENROUTER_EMBEDDING_MODEL,
        default_embedding_model: DEFAULT_OPENROUTER_EMBEDDING_MODEL
      }
    });
  } catch (error) {
    return sendApiError(res, error, {
      fallbackMessage: 'Failed to load OpenRouter config',
      logMessage: 'OpenRouter config read failed'
    });
  }
});

app.get('/api/dashboard/config/openrouter/models', requireAuth, async (_req, res) => {
  try {
    const models = await fetchOpenRouterModels();
    res.json({ models });
  } catch (error) {
    return sendApiError(res, normalizeSemanticError(error, {
      unavailableMessage: 'OpenRouter models are temporarily unavailable',
      internalMessage: 'Failed to fetch OpenRouter models',
      unavailableCode: 'OPENROUTER_MODELS_UNAVAILABLE',
      internalCode: 'OPENROUTER_MODELS_FAILED'
    }), {
      fallbackMessage: 'Failed to fetch OpenRouter models',
      logMessage: 'OpenRouter models read failed'
    });
  }
});

app.patch('/api/dashboard/config/openrouter', requireAuth, async (req, res) => {
  const model = typeof req.body?.model === 'string' ? req.body.model.trim() : '';
  const embeddingModel = typeof req.body?.embedding_model === 'string' ? req.body.embedding_model.trim() : '';

  if (!model && !embeddingModel) {
    return res.status(400).json({ error: 'model or embedding_model is required' });
  }

  try {
    if (model) {
      await setConfigValue(CONFIG_KEYS.openrouterModel, model);
    }

    if (embeddingModel) {
      await setConfigValue(CONFIG_KEYS.openrouterEmbeddingModel, embeddingModel);
    }

    const selectedModel = await getConfigValue(CONFIG_KEYS.openrouterModel);
    const selectedEmbeddingModel = await getConfigValue(CONFIG_KEYS.openrouterEmbeddingModel);

    res.json({
      openrouter: {
        selected_model: selectedModel,
        effective_model: selectedModel || DEFAULT_OPENROUTER_MODEL,
        default_model: DEFAULT_OPENROUTER_MODEL,
        selected_embedding_model: selectedEmbeddingModel,
        effective_embedding_model: selectedEmbeddingModel || DEFAULT_OPENROUTER_EMBEDDING_MODEL,
        default_embedding_model: DEFAULT_OPENROUTER_EMBEDDING_MODEL
      }
    });
  } catch (error) {
    return sendApiError(res, error, {
      fallbackMessage: 'Failed to update OpenRouter config',
      logMessage: 'OpenRouter config update failed'
    });
  }
});

app.post('/api/tasks/:id/resolve', requireAuth, async (req, res) => {
  const parsedParams = taskIdParamSchema.safeParse(req.params || {});
  if (!parsedParams.success) {
    return res.status(400).json({ error: zodErrorMessage(parsedParams.error) });
  }

  const parsedBody = resolveTaskBodySchema.safeParse(req.body || {});
  if (!parsedBody.success) {
    return res.status(400).json({ error: zodErrorMessage(parsedBody.error) });
  }

  const taskId = parsedParams.data.id;
  const { instruction } = parsedBody.data;

  try {
    const task = await db('tasks').where({ id: taskId }).first();
    if (!task) return res.status(404).json({ error: 'Task not found' });

    // Append the instruction to the context
    const newContext = task.context ? `${task.context}\n\n[Human Unblock]: ${instruction}` : `[Human Unblock]: ${instruction}`;

    await db('tasks').where({ id: taskId }).update({
      status: 'todo',
      context: newContext
    });

    await db('backlog_items')
      .where({ active_task_id: taskId })
      .update({ status: 'ready', updated_at: db.fn.now() });

    await db('projects').where({ url: task.project_url }).update({ status: 'active' });

    await db('agent_logs').insert({
      task_id: task.id,
      agent_name: 'Human Supervisor',
      action_type: 'update',
      message: 'Blocker resolved: ' + instruction
    });

    res.json({ success: true });
  } catch (error) {
    return sendApiError(res, error, {
      fallbackMessage: 'Failed to resolve task blocker',
      logMessage: 'Task resolve failed',
      logContext: { task_id: taskId }
    });
  }
});

const PORT = process.env.PORT || 47301;

const startBackgroundJobs = () => {
  setInterval(async () => {
    try {
      const fifteenMinsAgo = new Date(Date.now() - 15 * 60 * 1000);
      const staleTaskIds = await db('tasks')
        .where('status', 'in_progress')
        .andWhere('last_heartbeat', '<', fifteenMinsAgo)
        .pluck('id');

      if (staleTaskIds.length === 0) {
        return;
      }

      const updated = await db('tasks')
        .whereIn('id', staleTaskIds)
        .update({ status: 'stalled', updated_at: db.fn.now() });

      await db('backlog_items')
        .whereIn('active_task_id', staleTaskIds)
        .update({ status: 'blocked', updated_at: db.fn.now() });

      if (updated > 0) {
        logger.warn({ updated }, 'Job marked tasks as stalled');
      }
    } catch (error) {
      logger.error({ err: error }, 'Job Error');
    }
  }, 60 * 1000);
};

// F6-2-T3: `contract-check` pasa a prueba interna del backend. Se ejecuta en el
// arranque, antes de escuchar, y aborta si la superficie remota se ha separado del
// contrato — el mismo criterio estricto que ya aplica `apts-mcp.js` al arrancar
// (`checkMcpContract`, código de salida 3). El archivo descargable se sigue
// publicando mientras dure la convivencia (decisión #7).
//
// Comprueba tres cosas que ningún otro sitio comprueba:
//   1. el ejecutor en proceso expone exactamente una función por operación;
//   2. la tabla de identidad no nombra operaciones que no existen;
//   3. esa tabla no se ha separado de la del cliente descargable, salvo en la
//      diferencia declarada (`branch` fuera de `log_agent_progress`, decisión #1).
const DECLARED_IDENTITY_DIFFERENCES = {
  log_agent_progress: ['branch']
};

const checkRemoteMcpContract = async () => {
  const packageDir = path.join(integrationRoot, 'paquete-apts');
  const { contractOperations } = await import(pathToFileURL(path.join(packageDir, 'contract-check.js')).href);
  const operations = contractOperations();
  const operationNames = new Set(operations.map((operation) => operation.name));
  const problems = [];

  const expectedExports = operations.map((operation) => operation.clientExport).sort();
  const actualExports = Object.keys(mcpLocalExecutor)
    .filter((key) => typeof mcpLocalExecutor[key] === 'function')
    .sort();
  const missingExports = expectedExports.filter((name) => !actualExports.includes(name));
  const extraExports = actualExports.filter((name) => !expectedExports.includes(name));
  if (missingExports.length || extraExports.length) {
    problems.push({
      surface: 'mcp_local_executor',
      missing: missingExports,
      unexpected: extraExports
    });
  }

  const unknownIdentityOperations = Object.keys(MCP_IDENTITY_FIELDS_BY_OPERATION)
    .filter((name) => !operationNames.has(name));
  if (unknownIdentityOperations.length) {
    problems.push({
      surface: 'mcp_identity_table',
      unexpected: unknownIdentityOperations
    });
  }

  // La comparación con el cliente es tolerante a que el archivo desaparezca: está
  // marcado para retirarse, y su ausencia no debe tumbar el backend.
  try {
    const clientModule = await import(pathToFileURL(path.join(packageDir, 'apts-client.js')).href);
    const clientTable = clientModule.AUTO_FILL_FIELDS_BY_OPERATION || {};
    const drifted = [];

    for (const name of new Set([...Object.keys(clientTable), ...Object.keys(MCP_IDENTITY_FIELDS_BY_OPERATION)])) {
      const declared = DECLARED_IDENTITY_DIFFERENCES[name] || [];
      const fromClient = (clientTable[name] || []).filter((field) => !declared.includes(field)).sort();
      const fromServer = (MCP_IDENTITY_FIELDS_BY_OPERATION[name] || []).sort();
      if (JSON.stringify(fromClient) !== JSON.stringify(fromServer)) {
        drifted.push({ operation: name, client: fromClient, server: fromServer });
      }
    }

    if (drifted.length) {
      problems.push({ surface: 'mcp_identity_table_vs_client', drifted });
    }
  } catch (error) {
    logger.warn({ err: error }, 'Contract self-check skipped the downloadable client comparison');
  }

  if (problems.length) {
    const contractError = new Error('Remote MCP surface is out of sync with apts_skills.json');
    contractError.code = 'CONTRACT_MISMATCH';
    contractError.details = problems;
    throw contractError;
  }

  return { operations: operations.length };
};

const startServer = async () => {
  try {
    const contractCheckResult = await checkRemoteMcpContract().catch((error) => {
      logger.fatal({ err: error, details: error?.details || null }, 'Contract self-check failed');
      process.exit(3);
    });
    logger.info(contractCheckResult, 'Remote MCP contract self-check passed');

    const [batchNo, migrationNames] = await db.migrate.latest();

    logger.info({
      batch: batchNo,
      migrations_applied: migrationNames.length,
      migrations: migrationNames
    }, 'Database migrations checked');

    const legacyMigrationResult = await copyLegacySQLiteIntoPostgresAtStartup();
    logger.info({ legacy_migration: legacyMigrationResult }, 'Legacy SQLite bootstrap checked');

    const startupSyncedSequences = await syncPostgresAutoIncrementSequences(db, POSTGRES_AUTOINCREMENT_TABLES);
    logger.info({ synced_sequences: startupSyncedSequences }, 'PostgreSQL autoincrement sequences checked');

    app.listen(PORT, () => {
      logger.info({ port: PORT }, 'Backend running');
    });

    startBackgroundJobs();

    // Keep startup responsive for integrators: run non-critical embedding backfill after listen.
    void (async () => {
      try {
        const embeddingBackfillResult = await backfillOpenBugEmbeddingsAtStartup();
        logger.info({ embedding_backfill: embeddingBackfillResult }, 'Open bug embedding backfill checked');
      } catch (error) {
        logger.warn({ err: error }, 'Open bug embedding backfill failed after startup');
      }
    })();
  } catch (error) {
    logger.fatal({ err: error }, 'Backend startup failed while applying migrations');
    process.exit(1);
  }
};

startServer();

