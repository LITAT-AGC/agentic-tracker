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
  stageBacklogCoverageDocument,
  stageBacklogCoverageDocuments,
  syncProjectBacklogCoverageDocuments
} = require('./scripts/lib/semantic_documents');
const {
  aptsNext,
  aptsWorkflowStep,
  aptsSubmitStep,
  methodStatus,
  setMethodStatus,
  STORY_METHOD_STATUSES,
  resolveEntityProfile,
  ENTITY_PROFILE_FIELDS
} = require('./scripts/lib/method_resolver');
const { createInitiative, setAgentRole } = require('./scripts/lib/method_bootstrap');
// Deuda de que esto cierra: la llamada de embedding estaba implementada dos
// veces —aquí y en la librería—, con el mismo `fetch`, las mismas cabeceras y el
// mismo plazo copiados. Se conserva una sola: la de la librería.
//
// Lo mismo valía para el álgebra del vector: `cosineSimilarity` y
// `parseEmbeddingVector` estaban escritas aquí otra vez, y habían divergido —con
// vectores de distinta longitud una daba `0` y la otra `NaN`—. El sitio de llamada
// filtra por `Number.isFinite` y por el umbral, así que las dos se descartaban
// igual; era una diferencia sin efecto esperando a tenerlo. Ahora hay una sola.
//
// Y `buildBugEmbeddingText`, que estaba tres veces. Ésta era la peor de las tres:
// arma el texto que se manda a embeber, así que si dos copias se separan, un lado
// embebe un documento y el otro embebe otro, y luego los vectores se comparan
// entre sí como si vinieran del mismo texto. No hay filtro que lo tape —la
// búsqueda seguiría respondiendo 200, sólo que peor—.
const {
  requestEmbedding: requestLibraryEmbedding,
  buildBugEmbeddingText,
  cosineSimilarity,
  createContentHash,
  getEffectiveEmbeddingModel,
  parseEmbeddingVector,
  resolveEmbeddingProvider,
  DEFAULT_EMBEDDING_MODEL
} = require('./scripts/lib/semantic_embeddings');
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

// Remote MCP surface. Kept out of the /api tree on purpose: it is agent
// surface, not dashboard API. Its own body parser runs inside the route with a
// 4 MB cap; every other route keeps the express default (100 kb).
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
// Single global counter shared by agent surface and dashboard:
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
// `ready_for_dev` incluido: lo declara `20260620000010_bmad_hierarchy.js` en su propia
// lista (`BACKLOG_STATUSES_NEW`) y es el estado que el motor escribe en CADA story que
// crea, pero esta constante se quedo con la lista de antes de esa migracion. El resultado
// era que la base aceptaba el valor, el motor lo escribia, y la API ni lo leia ni lo
// escribia: `list_backlog_items` con ese filtro daba 400 —le rebotó a un agente en
// produccion el 2026-08-08— y `update_backlog_item` no podia reponer una story que la
// vigilancia hubiera dejado en `blocked`, que es el unico camino de vuelta que el propio
// motor recomienda. Ampliar la lista no rompe ninguna llamada existente: el valor ya era
// legal en la columna.
const BACKLOG_STATUSES = ['draft', 'needs_details', 'ready', 'ready_for_dev', 'in_progress', 'review', 'blocked', 'done', 'archived'];
const TASK_STATUSES = ['todo', 'in_progress', 'review', 'done', 'stalled'];
// mismos valores que declara la migración `20260620000010_bmad_hierarchy.js`
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
// El del embedding vive en `scripts/lib/semantic_embeddings.js`, que es desde la
// única implementación de esa llamada; la variable de entorno sigue siendo
// `OPENROUTER_EMBEDDING_TIMEOUT_MS`.
//
// El webhook es un servicio de terceros y su entrega ya tolera fallos, así que el
// plazo es más corto: nadie debería esperar por él.
const WEBHOOK_DELIVERY_TIMEOUT_MS = (() => {
  const configured = Number.parseInt(process.env.WEBHOOK_DELIVERY_TIMEOUT_MS || '', 10);
  return Number.isInteger(configured) && configured > 0 ? configured : 5000;
})();
// Las dos llamadas del panel. Estuvieron sin plazo a propósito
// porque no se alcanzan desde las operaciones del contrato, y quedaron anotadas como deuda.
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
// El modelo de embedding por defecto lo resuelve la librería, que es quien lo usa.
// Repetir aquí la lectura de la variable de entorno hacía que el panel pudiera
// anunciar un modelo por defecto distinto del que se pide de verdad —y desde que hay
// dos proveedores, la variable vieja ya no es la única—.
const DEFAULT_OPENROUTER_EMBEDDING_MODEL = DEFAULT_EMBEDDING_MODEL;
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
  'backlog_item_id',
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

// la construcción del cuerpo de error se separa del envío por la respuesta
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
    || message.includes('cloudflare')
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

// valida los elementos de un lote con el mismo mensaje indexado que usaban
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

// igual que arriba, el cuerpo de la respuesta de lote se construye aparte
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

// zod 4 ignora `invalid_type_error` —la clave es `error`—, así que hasta
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
  // obligatorios en el servidor. El cliente ya los exigía; sin él en el
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
  backlog_item_id: uuidFieldSchema('Backlog item id must be a valid UUID', { optional: true }),
  // Asociacion y propiedad eran la misma cosa: pasar `backlog_item_id` escribia
  // `active_task_id`, y ese puntero es lo que dispara la propagacion de estado. Este
  // campo las separa. Por defecto `true` porque es lo que hacia hasta ahora, y cambiar
  // el defecto romperia a todo agente ya escrito —incluida la via de recuperacion, que
  // resucita una tarea `stalled` volviendo a llamar con `backlog_item_id`—.
  //
  // No se acepta cualquier cadena por buena: `parseBooleanFlag` convierte lo que no
  // entiende en `false`, y aqui eso seria quitarle la propiedad en silencio a quien
  // quiso pedirla. Solo 'true'/'false' textuales; el resto se rechaza.
  owns_backlog_item: z.preprocess(
    (value) => {
      if (value === undefined) return undefined;
      if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (normalized === 'true') return true;
        if (normalized === 'false') return false;
      }
      return value;
    },
    z.boolean({ error: 'owns_backlog_item must be a boolean' }).optional()
  )
});

const taskStatusUpdateBodySchema = z.object({
  status: enumFieldSchema(TASK_STATUSES, 'Invalid task status', 'Invalid task status'),
  // los tres pasan a obligatorios; `agent_email` ni siquiera existía en el
  // esquema, así que el servidor lo descartaba en silencio.
  project_url: nonEmptyStringSchema('Project url is required', 'Project url must be a string', { unwrapQuotes: true }),
  agent_name: nonEmptyStringSchema('Agent name is required', 'Agent name must be a string'),
  agent_email: nonEmptyStringSchema('Agent email is required', 'Agent email must be a string')
});

const taskStatusUpdateBatchBodySchema = taskStatusUpdateBodySchema.extend({
  task_id: uuidFieldSchema('Task id must be a valid UUID')
});

const logAgentProgressBodySchema = z.object({
  // `agent_name` pasa a obligatorio. `branch` NO: la rama cambia durante
  // la sesión y el servidor no ve el repositorio del cliente, así que queda
  // opcional de verdad, como preveía la.
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
  // obligatorio en el servidor, como ya lo exigía el cliente.
  agent_name: nonEmptyStringSchema('Agent name is required', 'Agent name must be a string'),
  // Qué unidad está bloqueada, dicho y no deducido. Se podría sacar de
  // `tasks.backlog_item_id`, y a propósito no se hace: la asociación no tiene efectos, y
  // esa promesa es lo que impide que exista una puerta trasera al lado de la compuerta de
  // revisión. Aquí el agente NOMBRA lo que está bloqueado, que es un acto explícito suyo
  // y no una consecuencia automática de a qué unidad pertenecía su tarea.
  backlog_item_id: uuidFieldSchema('Backlog item id must be a valid UUID', { optional: true })
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
  // antes se aceptaba cualquier entero y la ruta lo recortaba en silencio,
  // mientras que el cliente lo rechazaba. Ahora rechazan los dos caminos.
  top_k: integerFieldSchema(`top_k must be an integer between 1 and ${MAX_SEMANTIC_SEARCH_TOP_K}`, {
    optional: true,
    min: 1,
    max: MAX_SEMANTIC_SEARCH_TOP_K
  }),
  // `limit` es el nombre que se le ocurre a cualquiera para pedir un tope, y aquí
  // no existe: el esquema no es estricto, así que se aceptaba, se descartaba sin
  // decir nada y el cliente se quedaba con `DEFAULT_SEMANTIC_SEARCH_TOP_K` (5)
  // creyendo que había pedido otra cosa. Ahora se rechaza nombrando el campo
  // bueno. Es el mismo criterio que el comentario de arriba: mejor un 400 que
  // hacer algo distinto de lo que pidieron.
  limit: z.never({
    error: `limit is not a field of this operation: use top_k (integer between 1 and ${MAX_SEMANTIC_SEARCH_TOP_K})`
  }).optional(),
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

  // El catálogo de precios es de OpenRouter y sólo tiene modelos suyos. Con un modelo
  // de Cloudflare, preguntarle era una llamada externa que siempre terminaba sin
  // coincidencia: mismo resultado —precios a null— sin gastarla. Cloudflare tampoco
  // publica precio por token, factura en neuronas, así que aquí no hay coste que dar.
  if (resolveEmbeddingProvider(semanticStatus.embedding_model) !== 'openrouter') {
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

const releasePointerBodySchema = z.object({
  project_url: nonEmptyStringSchema('Project url is required', 'Project url must be a string', { unwrapQuotes: true }),
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
    // Solo cuando hay. La mitad de las tareas de un proyecto real no cuelgan de ninguna
    // unidad, y en la vista que existe para no gastar contexto un UUID vacio son 55 bytes
    // por fila que no dicen nada. La ausencia hay que tratarla igual: la columna es
    // nulable de por si.
    ...(task.backlog_item_id ? { backlog_item_id: task.backlog_item_id } : {}),
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
      // Viaja tambien en compact —que es la vista por defecto de los agentes— porque
      // "que commit cerro esta historia" es una linea, no un texto largo, y es
      // exactamente lo que se pregunta al mirar una unidad ya cerrada.
      code_ref: item.code_ref || null,
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

  // El hash sale por la misma puerta que el vector. Es una clave de cache interna
  // —solo la lee `persistBugEmbeddingForBacklogItem` para decidir si vuelve a
  // embeber— y son 64 caracteres de entropia por item en el contexto de quien lea
  // el backlog. Los tres campos hermanos que si viajan (modelo, norma y fecha)
  // dicen algo legible; este no.
  const { bug_embedding: _bugEmbedding, bug_embedding_hash: _bugEmbeddingHash, ...safeItem } = item;

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

const normalizeTextField = (value) => (typeof value === 'string' ? value.trim() : '');

// Antes esta función era una **segunda implementación** del embedding: su propio
// `fetch`, sus propias cabeceras, su propio plazo de espera y su propia lectura de
// la respuesta, todo copiado de `scripts/lib/semantic_embeddings.js`. Dos copias del
// mismo cálculo divergen en silencio: el plazo hubo que ponerlo dos veces,
// una en cada copia. Ahora esto es sólo el envoltorio HTTP de la única implementación.
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
      // El mensaje se pasa tal cual porque ya nombra al proveedor que falló, que
      // desde que hay dos no siempre es OpenRouter.
      throw createHttpError(502, error.message, {
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
        bug_embedding_hash: null,
        bug_embedding_updated_at: null,
        updated_at: connection.fn.now()
      });
    return { status: 'cleared', backlog_item_id: backlogItemId };
  }

  const embeddingInput = buildBugEmbeddingText(backlogItem);
  if (!embeddingInput) {
    return { status: 'skipped', backlog_item_id: backlogItemId };
  }

  // El vector se regeneraba en cada escritura del item, tocara o no el texto que
  // se embebe: cambiar el estado, la prioridad o el orden pagaba una llamada de red
  // para reescribir el mismo vector. Se compara por hash, igual que lleva haciendo
  // el camino hermano —el documento de cobertura— con `generated_from_hash`.
  //
  // El modelo entra en la comparacion porque el hash solo habla del texto: con
  // `embedding_strategy:bug_dedup:model` cambiado, el texto sigue siendo el mismo y
  // el vector guardado deja de ser comparable con los que produce la busqueda.
  // Comparar solo el hash lo dejaria pasar por bueno para siempre.
  const embeddingHash = createContentHash(embeddingInput);
  const effectiveModel = await getEffectiveEmbeddingModel(connection, BUG_EMBEDDING_STRATEGY_KEY);
  const hasCurrentEmbedding = Boolean(normalizeTextField(backlogItem.bug_embedding))
    && backlogItem.bug_embedding_hash === embeddingHash
    && backlogItem.bug_embedding_model === effectiveModel;

  if (hasCurrentEmbedding) {
    return {
      status: 'unchanged',
      backlog_item_id: backlogItemId,
      model: backlogItem.bug_embedding_model
    };
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
      bug_embedding_hash: embeddingHash,
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

// ---- set_project_constraints ----
// El campo estaba publicado y no podia llenarlo nadie. `get_project_constraints`
// existia desde el principio, pero no habia escritor en ninguna de las tres
// superficies —ni operacion MCP, ni ruta HTTP, ni pantalla del panel—, asi que un
// proyecto nuevo respondia los seis campos en null para siempre y el agente que si
// descubria los comandos no tenia donde dejarlos. Lo reporto un cliente el
// 2026-08-08, despues de deducir `npm run test` y `npm run typecheck` leyendo el
// repositorio y no encontrar como registrarlos.
//
// Parche, no reemplazo: se escriben SOLO las claves que trae la llamada, asi que
// una llamada no borra lo que no nombra. Un null explicito si borra, y gana sobre
// lo que venga de `projects.description` porque queda como clave presente en el
// JSON de config, que es la mitad que pisa a la otra en getProjectConstraints.
const PROJECT_CONSTRAINT_FIELDS = [
  'test_command',
  'lint_command',
  'typecheck_command',
  'framework',
  'language',
  'conventions'
];

// Un campo mal escrito se rechaza, no se ignora: aceptarlo y descartarlo en
// silencio devolveria 200 sobre una constraint que nunca se guardo —el mismo
// defecto que ya se cerro con `limit` en la busqueda semantica—. Y una llamada sin
// ningun campo tampoco pasa: seria un 200 que no escribe nada.
const parseProjectConstraintsPatch = (body = {}) => {
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const unknown = Object.keys(source)
    .filter((key) => !PROJECT_CONSTRAINT_FIELDS.includes(key) && key !== 'url' && key !== 'project_url');
  if (unknown.length) {
    throw createHttpError(
      400,
      `Unknown constraint field(s): ${unknown.join(', ')}. Valid fields: ${PROJECT_CONSTRAINT_FIELDS.join(', ')}`
    );
  }

  const patch = {};
  for (const field of PROJECT_CONSTRAINT_FIELDS) {
    if (!(field in source)) continue;
    const value = source[field];
    if (value === null) {
      patch[field] = null;
      continue;
    }
    if (typeof value !== 'string') {
      throw createHttpError(400, `${field} must be a string or null`);
    }
    // Mismo trato que en la lectura: los comandos y las etiquetas pierden las
    // comillas que las envuelven; `conventions` es prosa y se respeta tal cual.
    patch[field] = normalizeInputString(value, { unwrapQuotes: field !== 'conventions' }) || null;
  }

  if (!Object.keys(patch).length) {
    throw createHttpError(
      400,
      `At least one constraint field is required: ${PROJECT_CONSTRAINT_FIELDS.join(', ')}`
    );
  }

  return patch;
};

const setProjectConstraints = async (projectUrl, patch, { connection = db } = {}) => {
  const project = await connection('projects').where({ url: projectUrl }).first();
  if (!project) {
    throw createHttpError(404, 'Project not found');
  }

  const constraintsConfigKey = `${PROJECT_CONSTRAINTS_CONFIG_PREFIX}${projectUrl}`;
  const existing = await connection('config').where({ key: constraintsConfigKey }).first();
  const value = JSON.stringify({ ...parseJsonObjectOrEmpty(existing?.value), ...patch });

  await connection('config')
    .insert({ key: constraintsConfigKey, value, updated_at: connection.fn.now() })
    .onConflict('key')
    .merge({ value, updated_at: connection.fn.now() });

  // Devuelve lo EFECTIVO, no lo enviado: es la unica forma de que el llamante vea
  // el resultado de la fusion con `projects.description` sin una segunda llamada.
  return getProjectConstraints(projectUrl, { connection });
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
// Schema version of the public integration manifest.
// 1.0.0: first published version. One surface: the remote MCP endpoint.
// 1.0.1: method_conduction, para que un cliente sin descargas sepa conducir.
// 1.1.0: dos runtimes en vez de tres (VS Code fuera) y el conductor del bucle
//        publicado. Es menor y no de parche porque QUITA artefactos —las cuatro
//        plantillas `agent_template` y sus rutas— y cambia la forma de
//        `agent_runtime_adapters.mappings`: un cliente que leyera el manifiesto
//        viejo encuentra menos cosas de las que esperaba, y eso hay que poder
//        verlo en el numero.
// 1.1.1: `register_task_link_rule` dentro de `task_recovery_policy`. Es clave nueva
//        —el mismo caso que `method_conduction` en 1.0.1— y no quita ni cambia la
//        forma de nada, asi que es de parche.
const integrationManifestSchemaVersion = '1.1.1';
const publicIntegrationBasePath = '/api/public/integrar';

const integrationArtifacts = {
  skills_json: {
    route: `${publicIntegrationBasePath}/skills.json`,
    filePath: path.join(integrationRoot, 'paquete-apts', 'apts_skills.json'),
    fileName: 'apts_skills.json',
    contentType: 'application/json; charset=utf-8',
    // 1.0.2: `owns_backlog_item` en `register_task`, que separa asociar de poseer.
    artifactVersion: '1.0.2',
    kind: 'skills_contract',
    recommended: true,
    usagePriority: 'discovery',
    description: 'Machine-readable tool contract for APTS integration.'
  },
  skill_markdown: {
    route: `${publicIntegrationBasePath}/skill.md`,
    filePath: path.join(integrationRoot, 'paquete-apts', 'SKILL.md'),
    fileName: 'SKILL.md',
    contentType: 'text/markdown; charset=utf-8',
    artifactVersion: '1.1.0',
    kind: 'skill_package',
    recommended: false,
    usagePriority: 'discovery',
    description: 'Skill packaging guide for APTS integration.'
  },
  agent_guidelines: {
    route: `${publicIntegrationBasePath}/agent-guidelines.md`,
    filePath: path.join(integrationRoot, 'paquete-apts', 'apts-agent-guidelines.md'),
    fileName: 'apts-agent-guidelines.md',
    contentType: 'text/markdown; charset=utf-8',
    artifactVersion: '1.1.0',
    kind: 'agent_guidelines',
    recommended: true,
    usagePriority: 'discovery',
    description: 'Base operating rules for any agent that reports work to APTS.'
  },
  surface_spec: {
    route: `${publicIntegrationBasePath}/runtime-adapters/spec/apts-surface.json`,
    filePath: path.join(integrationRoot, 'paquete-apts', 'runtime-adapters', 'spec', 'apts-surface.json'),
    fileName: 'apts-surface.json',
    contentType: 'application/json; charset=utf-8',
    artifactVersion: '1.0.2',
    kind: 'runtime_surface_spec',
    recommended: true,
    usagePriority: 'discovery',
    optional: false,
    selection_rule: 'Single source of the agent surface (agents, commands, permissions, unified instructions, hooks). Feed it to generate-adapters.js to materialize the per-runtime adapters locally; never hand-edit the generated adapters.',
    description: 'Single runtime-surface spec; input to the adapter generator.'
  },
  adapter_generator: {
    route: `${publicIntegrationBasePath}/scripts/generate-adapters.js`,
    filePath: path.join(integrationRoot, 'paquete-apts', 'scripts', 'generate-adapters.js'),
    fileName: 'generate-adapters.js',
    contentType: 'application/javascript; charset=utf-8',
    artifactVersion: '1.1.0',
    kind: 'adapter_generator',
    recommended: true,
    usagePriority: 'primary',
    optional: false,
    dependsOnArtifactIds: ['surface_spec'],
    module_system: 'esm',
    selection_rule: 'Idempotent generator that reads apts-surface.json and emits runtime-adapters/{claude,opencode}/, each with the runtime\'s MCP registration, agents, commands, permissions and instruction file. Run it locally to (re)generate adapters; the generated files are managed and must not be hand-edited.',
    description: 'Idempotent generator that emits the per-runtime adapters from the surface spec.'
  },
  loop_conductor: {
    route: `${publicIntegrationBasePath}/conductor/apts-loop.js`,
    filePath: path.join(integrationRoot, 'conductor', 'apts-loop.js'),
    fileName: 'apts-loop.js',
    contentType: 'application/javascript; charset=utf-8',
    // 1.1.0: cada llamada MCP reintenta 3 veces con espera creciente antes de parar por
    // red. Cambia el comportamiento observable de un cliente que ya lo tuviera bajado, y
    // por eso sube la versión: sin el bump, quien cacheara por version se quedaría con un
    // conductor que se para al primer parpadeo.
    // 1.2.0: abre una tarea por unidad en APTS (`--no-task-log` la apaga). Escribe donde
    // antes no escribía, así que un cliente tiene que poder enterarse.
    // 1.3.0: esa tarea se titula con el nombre de la historia y viaja al agente como
    // `{task_id}` para que no registre otra. No es cosmética: la que registra el agente
    // va ligada al backlog item y cerrarla arrastra la historia a `done`.
    // 1.4.0: esa tarea se asocia a la unidad sin poseerla (`owns_backlog_item: false`).
    // Escribe una relación donde antes no escribía ninguna. Contra un APTS anterior al
    // campo el esquema lo descartaría en silencio y la tarea quedaría ligada, que es
    // justo lo que se evita; por eso el conductor comprueba la respuesta y avisa.
    // 1.5.0: lanza al agente con `spawn` en vez de `spawnSync`, y eso cambia tres cosas
    // observables a la vez: late mientras el agente trabaja (la tarea ya no se marca
    // `stalled` en las historias largas), copia su diario a APTS, y obedece órdenes del
    // panel —detener, pausar— matando el árbol de procesos del agente. Además, sin
    // `--project-url` ni `--agent-cmd` ya no falla: espera órdenes (`--daemon`). Un
    // cliente que se quedara con la 1.4.0 conserva un conductor que no se puede parar
    // desde ningún sitio, así que el bump es lo que le permite enterarse.
    artifactVersion: '1.5.0',
    kind: 'loop_conductor',
    recommended: false,
    usagePriority: 'optional_entrypoint',
    optional: true,
    dependsOnArtifactIds: ['loop_conductor_readme'],
    module_system: 'commonjs',
    selection_rule: 'Sequential conductor for the implementation phase: asks the engine what is next, launches ONE agent process per story with fresh context, and repeats until the engine says done or a brake trips. It keeps no state of its own — the engine holds it — so killing and relaunching it is safe. Out of scope on purpose: bug intake and the generative phases (analysis, planning, solutioning), which are interactive; if the engine recommends one, it stops and says so. Node 18+, no dependencies. Read the README before running it.',
    description: 'Loop conductor that drives the implementation phase, one agent process per story.'
  },
  loop_conductor_readme: {
    route: `${publicIntegrationBasePath}/conductor/README.md`,
    filePath: path.join(integrationRoot, 'conductor', 'README.md'),
    fileName: 'apts-loop-README.md',
    contentType: 'text/markdown; charset=utf-8',
    // 1.1.0: documenta los reintentos de red y las plantillas de prompt de `prompts/`.
    // 1.2.0: documenta el registro de la ejecución en APTS y `--no-task-log`.
    // 1.3.0: documenta `{task_id}` y por qué la tarea del conductor no se liga al item.
    // 1.4.0: documenta `owns_backlog_item` y la diferencia entre asociar y poseer.
    // 1.5.0: documenta el latido durante la ejecución, el diario en APTS
    // (`--no-journal-remote`), las órdenes desde el panel y el modo espera (`--daemon`).
    artifactVersion: '1.5.0',
    kind: 'loop_conductor_manual',
    recommended: false,
    usagePriority: 'optional_entrypoint',
    optional: true,
    selection_rule: 'Manual for the loop conductor: the --agent-cmd line for each runtime (Claude Code and opencode, plus the Windows variant), the brakes and their exit codes, the retry/model-escalation policy, and the stop notifications. The conductor is unusable without it: --agent-cmd is mandatory and its shape is runtime-specific.',
    description: 'Manual for the loop conductor: invocation per runtime, brakes, exit codes and notifications.'
  },
  // Se publica porque el README —que sí es artefacto— la nombra: un cliente que sólo
  // descarga desde esta URL leía sobre un archivo que no podía bajarse. El conductor
  // funciona sin ella (trae su plantilla por defecto dentro), así que es opcional de
  // verdad y no una dependencia escondida.
  loop_prompt_code_review: {
    route: `${publicIntegrationBasePath}/conductor/prompts/dev-story-revision-adversaria.md`,
    filePath: path.join(integrationRoot, 'conductor', 'prompts', 'dev-story-revision-adversaria.md'),
    fileName: 'dev-story-revision-adversaria.md',
    contentType: 'text/markdown; charset=utf-8',
    // 1.1.0: le dice al agente que use la tarea que el conductor ya abrió (`{task_id}`)
    // en vez de registrar la suya, que iría ligada al backlog item.
    // 1.1.1: esa explicación pasa a hablar de posesión, que es lo que el campo nuevo
    // separa. Sólo cambia el texto que lee el agente.
    artifactVersion: '1.1.1',
    kind: 'loop_conductor_prompt',
    recommended: false,
    usagePriority: 'optional_entrypoint',
    optional: true,
    dependsOnArtifactIds: ['loop_conductor'],
    selection_rule: 'Prompt template for the loop conductor (--prompt-file), replacing its built-in default. It adds an adversarial review gate before the dev-story validation step: three layers in parallel subagents under distinct lenses (Blind Hunter sees only the diff, Edge Case Hunter the boundaries, Acceptance Auditor only the story and its acceptance criteria), a triage that counts a finding only with file:line plus a concrete failure scenario, and the method\'s own {"goto":"step:5"} branch when something is confirmed. Download it only if you run the conductor and want the gate in the agent session; the engine gate (the required_for_close code_review artifact on the terminal dev-story step) applies either way. Placeholders substituted by the conductor: {story_id}, {agent_name}, {project_url}, {role}, {iteration}, {attempt}, {max_attempts}, {task_id}.',
    description: 'Prompt template for the conductor that demands an adversarial review before a story closes.'
  }
};

const buildAbsoluteUrl = (req, route) => `${req.protocol}://${req.get('host')}${route}`;

// --- Registro del MCP remoto -------------------------------------
//
// Se publica como DATO, por programa cliente: un cliente puede registrar el
// servidor copiando `config` en `config_file`, sin descargar ningún archivo.
// Las tres cabeceras de identidad son parte del registro, no un extra: sustituyen
// a la resolución automática que hacía el script local. Sin ellas el
// cliente remoto se queda sin identidad y la superficie queda peor que la actual.
//
// La URL se deriva del host de la petición, igual que `api_base_url`, porque `/mcp`
// vive fuera del árbol `/api` y no puede componerse a partir de él .
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
    surface_note: 'This endpoint is the integration surface: all contract operations arrive through tools/list. Registering it needs a URL and headers only — no file to download, no local process, no artifact version to keep in sync.'
  };
};

// --- El bucle de conducción del método, como dato ---------------------------
//
// Esto vivía como prosa descargable
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
    '3. Pick a stable, deterministic agent_name per role and reuse the same name whenever acting as that role, so re-runs upsert the same pointer instead of duplicating.',
    'Do NOT pass phase. The engine starts at analysis and produces the brief and the PRD itself; a client spec is the INPUT to those steps, not a substitute for their artifacts, and it is stored as doc_type spec precisely so it closes no phase. A starting phase later than analysis is rejected unless the artifacts that close the skipped phases already exist for the project.'
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
    '2. Produce what the step declares in outputs[], grounded in instruction_chunk, template_slice and the needs[] slices. Do not fabricate content the step does not ask for. Most steps declare nothing (outputs[] empty): submit them with an empty output, they are procedure steps.',
    '3. Submit with apts_submit_step. output is ONE flat object and the server takes from it whatever each declaration in outputs[] asks for, so a step MUST be answered for every entry it declares, not just the first one: { kind: "artifact", doc_type } consumes title and content; { kind: "backlog_items" } consumes stories[] ({ title, description?, acceptance_criteria? }); { kind: "status" } consumes status and code_ref; { kind: "code_ref" } consumes code_ref. A step declaring [{artifact:epics},{backlog_items}] needs { title, content, stories } in the same call — answering only the artifact silently creates no stories, and the lifecycle then reaches implementation with no work units and waits forever.',
    '4. apts_submit_step returns { ok, captured[], advanced_to, workflow_complete }. Check captured[] against what the step declared: it is the only confirmation that each output was really taken. If ok is false, read why and correct the call instead of retrying it unchanged — in particular, a step paused in await_input must be resumed via apts_workflow_step with answers before it can be submitted.',
    '5. If workflow_complete is false, keep serving and submitting the next step of the same workflow. When it is true, go back to drive_loop for the next workflow or phase.'
  ].join('\n'),
  dev_story_completion_rule: [
    'The iterable dev-story step does not auto-release: whoever holds the claim must drive the engine\'s dev-story workflow to completion.',
    'It is multi-step (the BMAD dev procedure; in the seeded library it is 10 iterable steps, and only the terminal step declares outputs). Acting as the SAME dev agent_name that holds the claim, walk it like a generative workflow (generative_step_rule): apts_workflow_step then apts_submit_step per step, answering any await_input, submitting empty output for the procedure steps.',
    'The terminal step declares TWO outputs, and both travel in the SAME submit: output: { status: "done", code_ref: "<commit hash>", title: "<review title>", content: "<the code review>" }. The code_review artifact is scoped to this unit and is required_for_close: a terminal submit without a non-empty output.content is rejected with ok:false, and the story is not closed. This is the adversarial review gate (bmad-code-review): review the unit\'s diff with parallel layers under distinct lenses — Blind Hunter (the diff alone, no story, no acceptance criteria), Edge Case Hunter (boundaries, empty and null input, error paths), Acceptance Auditor (the story and its acceptance criteria against the real code) — and count a finding only when it carries file:line plus a concrete failure scenario. Fix what the layers confirm before closing; output.content is the review itself.',
    'Each submit advances one step. The claimed story is marked done and the cursor released only when that terminal submit is captured (workflow_complete / iterable_unit_done). Do not re-resolve via apts_next per step, and do not expect a single submit to close the story.',
    'A backlog status update made outside this workflow is not enough: a story left at review is non-terminal, so without the terminal apts_submit_step it is never done.',
    'Once it is closed, re-enter drive_loop: apts_next hands out the next free unit, or advances the phase once every story is done.',
    'If the implementation is blocked, make sure the blocker is reflected in APTS and stop the cycle with a blocker report. Do not submit the story as done.'
  ].join('\n')
};


// ---- Reglas de conduccion por proyecto ----
// `METHOD_CONDUCTION` es la fuente autoritativa y sigue siendolo: el override no la
// reemplaza, la pisa campo a campo para el proyecto que lo pide. Se guarda en `config`,
// con el mismo patron que las restricciones del proyecto, porque es lo mismo —una
// preferencia por proyecto sobre algo global— y no merece tabla propia.
const METHOD_CONDUCTION_CONFIG_PREFIX = 'method_conduction:';
const METHOD_CONDUCTION_FIELDS = Object.keys(METHOD_CONDUCTION);

const getMethodConductionOverride = async (projectUrl, { connection = db } = {}) => {
  if (!projectUrl) return {};
  const hasConfigTable = await connection.schema.hasTable('config');
  if (!hasConfigTable) return {};

  const row = await connection('config')
    .where({ key: `${METHOD_CONDUCTION_CONFIG_PREFIX}${projectUrl}` })
    .first();

  const stored = parseJsonObjectOrEmpty(row?.value);
  const override = {};
  for (const field of METHOD_CONDUCTION_FIELDS) {
    if (typeof stored[field] === 'string' && stored[field].trim() !== '') {
      override[field] = stored[field];
    }
  }
  return override;
};

const parseMethodConductionPatch = (body = {}) => {
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const unknown = Object.keys(source)
    .filter((key) => !METHOD_CONDUCTION_FIELDS.includes(key) && key !== 'url' && key !== 'project_url');
  if (unknown.length) {
    throw createHttpError(
      400,
      `Unknown method_conduction field(s): ${unknown.join(', ')}. Valid fields: ${METHOD_CONDUCTION_FIELDS.join(', ')}`
    );
  }

  const patch = {};
  for (const field of METHOD_CONDUCTION_FIELDS) {
    if (!(field in source)) continue;
    const value = source[field];
    if (value === null) {
      patch[field] = null;
      continue;
    }
    if (typeof value !== 'string') {
      throw createHttpError(400, `${field} must be a string or null`);
    }
    patch[field] = value.trim() === '' ? null : value;
  }

  if (!Object.keys(patch).length) {
    throw createHttpError(400, `At least one field is required: ${METHOD_CONDUCTION_FIELDS.join(', ')}`);
  }

  return patch;
};

const setMethodConductionOverride = async (projectUrl, patch, { connection = db } = {}) => {
  const project = await connection('projects').where({ url: projectUrl }).first();
  if (!project) {
    throw createHttpError(404, 'Project not found');
  }

  const key = `${METHOD_CONDUCTION_CONFIG_PREFIX}${projectUrl}`;
  const existing = await connection('config').where({ key }).first();
  const merged = { ...parseJsonObjectOrEmpty(existing?.value), ...patch };
  // Un null borra la clave en vez de guardarla: aqui no hay nada debajo que tapar, solo
  // la constante, y una clave presente en null solo confundiria al siguiente lector.
  for (const field of METHOD_CONDUCTION_FIELDS) {
    if (merged[field] === null) delete merged[field];
  }
  const value = JSON.stringify(merged);

  await connection('config')
    .insert({ key, value, updated_at: connection.fn.now() })
    .onConflict('key')
    .merge({ value, updated_at: connection.fn.now() });

  return getMethodConductionOverride(projectUrl, { connection });
};

const normalizeManifestRuntime = (runtime) => {
  if (typeof runtime !== 'string') return null;

  const normalized = runtime.trim().toLowerCase();
  if (!normalized) return null;

  const aliases = {
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

// `methodConductionOverride`: lo que el proyecto nombrado en `?project_url=` haya pisado.
// Sin ese parametro la respuesta es la de siempre, clave por clave, y por eso
// `schema_version` no se mueve: no hay ninguna clave nueva que anunciar.
const buildIntegrationManifest = (req, methodConductionOverride = null) => {
  const activeRuntime = normalizeManifestRuntime(req.query.runtime);
  const methodConduction = methodConductionOverride && Object.keys(methodConductionOverride).length
    ? { ...METHOD_CONDUCTION, ...methodConductionOverride }
    : METHOD_CONDUCTION;

  return {
    service: 'APTS',
    version: rootPackage.version,
    schema_version: integrationManifestSchemaVersion,
    integration_mode: 'agent',
    runtime_filter: {
      query_param: 'runtime',
      active_runtime: activeRuntime,
      supported_runtime_values: ['claudecode', 'opencode'],
      recommendation_behavior: 'When runtime is provided, recommended artifacts are filtered to runtime-compatible entries first.'
    },
    bootstrap: {
      manifest_updates: {
        current_version: integrationManifestSchemaVersion
      },
      summary: 'APTS centralizes operational tracking for agent-executed projects and should become the source of truth for backlog and execution state.',
      service_purpose: 'Use APTS to register backlog, active tasks, blockers, heartbeats, and technical logs through the remote MCP endpoint, whose tools derive from the skills contract.',
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
        storage_recommendation: 'Define APTS_API_KEY and the three identity values the registration block references (APTS_PROJECT_URL, APTS_AGENT_NAME, APTS_AGENT_EMAIL) in a .env file at the client project root, or in an equivalent secret system that exposes them as runtime environment variables. Never hardcode the key in source code, versioned prompts, JSON files, or backlog documents.',
        preferred_env_file: '.env (client project root)',
        env_example: [
          'APTS_API_KEY=place-your-api-key-here',
          'APTS_PROJECT_URL=https://github.com/org/repo',
          'APTS_AGENT_NAME=your-agent-name',
          'APTS_AGENT_EMAIL=your-agent@example.com'
        ],
        companion_env: 'The MCP endpoint URL comes embedded in mcp_endpoint.registration_by_runtime; only the static generated adapters reference it as APTS_MCP_URL.'
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
      agent_runtime_adapters: {
        required_for_custom_agents: true,
        // Antes esta politica hablaba SOLO de VS Code, en los tres sitios: la
        // frase de estado, los tres mappings y el paso recomendado. Un cliente
        // Claude Code la leia, concluia con razon que no le aplicaba, y no
        // generaba nada: se quedaba sin agentes y sin comandos aunque el
        // generador ya los emitia. Medido el 2026-08-08 en un cliente real.
        // Ahora la politica es de los DOS runtimes soportados y no nombra
        // ninguno en la condicion.
        installation_state_policy: 'Custom-agent installation is incomplete while the adapters for the ACTIVE runtime are missing from their target paths. This applies to every supported runtime, not to one of them: pick the mappings whose runtime matches yours and materialize all of them.',
        generation: {
          spec_artifact_id: 'surface_spec',
          generator_artifact_id: 'adapter_generator',
          output_dir: 'runtime-adapters/<runtime>',
          policy: 'Generated adapters are managed: run the generator to (re)materialize them; never hand-edit them. They are not published as individual downloadable artifacts — the spec plus the generator IS the delivery.',
          how_to: 'Download surface_spec and adapter_generator, run `node generate-adapters.js` (it reads the spec next to it and needs no dependencies), then copy the whole directory of your runtime into the client project root, preserving relative paths.'
        },
        // Un mapping por runtime, y el destino es el DIRECTORIO entero: cada
        // runtime materializa el registro MCP, sus cuatro agentes, sus cinco
        // comandos, los permisos y su archivo de instrucciones. Enumerar
        // agente por agente era lo que dejaba fuera al orquestador de metodo,
        // que no figuraba en ningun mapping y es justo el que conduce el ciclo.
        mappings: [
          {
            runtime: 'claudecode',
            generated_by_artifact_id: 'adapter_generator',
            source_relative_path: 'runtime-adapters/claude/',
            target_relative_path: '<client project root>',
            materializes: [
              '.mcp.json (MCP registration)',
              'CLAUDE.md (imports AGENTS.md and carries the APTS managed section)',
              '.claude/settings.json (tool allowlist derived from the contract)',
              '.claude/agents/*.md (4 agents)',
              '.claude/commands/*.md (5 slash commands: apts-next, apts-method, apts-bug, apts-status, apts-resume)'
            ]
          },
          {
            runtime: 'opencode',
            generated_by_artifact_id: 'adapter_generator',
            source_relative_path: 'runtime-adapters/opencode/',
            target_relative_path: '<client project root>',
            materializes: [
              'opencode.json (MCP registration and permissions)',
              'AGENTS.md (APTS managed section)',
              '.opencode/agent/*.md (4 agents)',
              '.opencode/command/*.md (5 commands: apts-next, apts-method, apts-bug, apts-status, apts-resume)'
            ]
          }
        ],
        agents: [
          { id: 'apts-method-orchestrator', role: 'entrypoint', purpose: 'Bootstraps a BMAD initiative and conducts the analysis→…→done lifecycle from a client spec. This is the agent to install first when starting from a spec.' },
          { id: 'apts-backlog-orchestrator', role: 'entrypoint', purpose: 'Pulls ready backlog items from APTS and dispatches them.' },
          { id: 'backlog-item-executor-dev-test-commit', role: 'worker', purpose: 'Takes one backlog item end-to-end: implement, test, commit.' },
          { id: 'apts-bugfix-intake', role: 'optional_entrypoint', purpose: 'Read-only triage of a defect report and tracked bug registration.' }
        ]
      },
      agent_instruction_policy: {
        preferred_instruction_files: ['AGENTS.md'],
        missing_file_behavior: 'If AGENTS.md does not exist, create it from the downloaded apts-agent-guidelines.md before protected APTS calls. Claude Code additionally reads CLAUDE.md, which the generated adapter writes as an import of AGENTS.md plus the managed section, so AGENTS.md stays the single instruction file either way.',
        existing_file_behavior: 'If an instruction file already exists, preserve project-specific rules and merge or refresh only one APTS-managed section instead of replacing the whole file.',
        managed_section_markers: ['<!-- APTS:START -->', '<!-- APTS:END -->'],
        update_strategy: [
          'If an instruction file has no APTS managed section, append one managed section once.',
          'If managed markers already exist, replace only the content between markers.',
          'Do not duplicate multiple APTS managed sections in the same file.'
        ]
      },
      task_recovery_policy: {
        register_task_resume_rule: 'When register_task includes backlog_item_id and the linked backlog item already has an active task in todo, in_progress, or stalled, APTS resumes that task instead of creating a duplicate. This does not apply with owns_backlog_item: false, which never resumes: resume is looked up through the ownership pointer, so without ownership there is nothing to resume.',
        register_task_link_rule: 'backlog_item_id grants two separate things. Association: the task permanently records which unit it belonged to, with no effects. Ownership: the task becomes that unit\'s active task, and that pointer is the ONLY thing update_task_status propagates through — a linked task moved to done closes the story, bypassing any gate on the terminal step. Send owns_backlog_item: false to get association without ownership. Use it when something other than the task itself decides when the unit closes, as the loop conductor does.',
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
        'Register the remote MCP server: copy the block for your runtime from mcp_endpoint.registration_by_runtime as-is. No file has to be downloaded to use the operations that tools/list returns.',
        'If APTS_API_KEY is not yet present in the environment, request it from the operator, together with the project identity values the registration block references.',
        'Call the tools with minimal payloads: the integration layer supplies project_url and agent identity through the registration headers.',
        'Ensure the project has AGENTS.md. Create it from apts-agent-guidelines.md if it does not exist, or merge/update one APTS-managed section if it already does.',
        'Install the agents and commands for YOUR runtime, whichever of the supported ones it is: download surface_spec and adapter_generator, run the generator, and copy the directory named in the mapping for your runtime (bootstrap.agent_runtime_adapters.mappings) into the project root. Without this there is no method orchestrator and no slash commands, and the whole lifecycle has to be conducted by hand.',
        'To grind the implementation phase unattended, download loop_conductor and its README (loop_conductor_readme) and run it: it launches one agent process per story with fresh context and stops on its own when the engine says done or a brake trips. It does NOT conduct the generative phases — those are interactive.',
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
    method_conduction: methodConduction,
    auth: {
      type: 'bearer',
      header: 'Authorization',
      scheme: 'Bearer',
      env: ['APTS_API_KEY', 'APTS_PROJECT_URL', 'APTS_AGENT_NAME', 'APTS_AGENT_EMAIL'],
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
      'Register the remote MCP server from mcp_endpoint.registration_by_runtime; the contract operations arrive through tools/list, with no file to download or keep in sync.',
      'When consuming manifest artifacts, filter by runtime first (runtime query param or client-side equivalent), then apply recommended entries from that compatible subset.',
      'Use runtime-specific adapter paths only when needed for discovery (.agents/skills/apts or .claude/skills/apts), and avoid user-global skill installation.',
      'Generate and install the adapters for your runtime with the adapter_generator, as bootstrap.agent_runtime_adapters describes. Both supported runtimes need this; it is what materializes the agents and the slash commands.',
      'Maintain the local resilience log described in the bootstrap section; it is append-only and must not replace APTS as the source of truth.',
      'Read the base agent guidelines before the first APTS API call.',
      'Ensure AGENTS.md exists before protected calls: create it if it does not, or merge/update one APTS-managed section if it does.',
      'If the runtime supports custom agents and the current chat is a bugfix/reporting request or might be one, install or invoke the APTS Bugfix Intake agent before direct execution.',
      'If the current chat introduces a possible bug, error, or regression request, confirm with the user that it should be tracked as a bug in APTS before creating or updating a bug item.',
      'Only after that explicit confirmation should the issue be represented in APTS backlog as a bug item before registering execution work or starting implementation.',
      'If the current chat asks to report a solved bug, update the tracked bug backlog item and add resolution details with verification evidence.',
      'Do not run manual identity pre-flight commands: the integration layer supplies project_url and agent identity, and a call that is missing something is rejected naming the field.',
      'Use register_task with backlog_item_id to resume interrupted work for that backlog item before creating additional execution tasks.',
      'Do not force task status done for interrupted executions: pass through review first and ensure recent heartbeat or progress logs exist before closing as done.'
    ],
    identity_requirements: [
      { field: 'project_url', resolve_with: 'the integration layer (registration header); a value in the call that contradicts it is rejected' },
      { field: 'agent_name', resolve_with: 'the integration layer (registration header); a value in the call wins, which is how role switching works' },
      { field: 'agent_email', resolve_with: 'the integration layer (registration header)' },
      { field: 'branch', resolve_with: 'the call, when the operation accepts it; optional' },
      { field: 'task_id', resolve_with: 'the call; register_task returns it, and calling register_task again with the same backlog_item_id returns it back' }
    ],
    artifacts: Object.entries(integrationArtifacts).map(([id, artifact]) => ({
      runtime_compatible: isArtifactRuntimeCompatible(artifact, activeRuntime),
      id,
      kind: artifact.kind,
      artifact_version: artifact.artifactVersion,
      description: artifact.description,
      recommended: artifact.recommended && isArtifactRuntimeCompatible(artifact, activeRuntime),
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
      // La URL publicada lleva la version dentro (`?v=1.4.0`). No la lee nadie —la ruta
      // se resuelve por camino y el handler ignora la query—: existe para que la version
      // forme parte de la CLAVE DE CACHE. Cualquier intermediario reparte por URL, asi
      // que una version nueva estrena URL y no puede recibir los bytes de la anterior,
      // conteste el origen lo que conteste. Que es justo lo que fallo el 2026-08-08:
      // Cloudflare cachea por extension y guardo un `.js` que salia sin ninguna
      // directiva, de modo que el manifiesto anunciaba el conductor en 1.4.0 y la URL
      // entregaba el 1.3.0 durante horas.
      //
      // Es cinturon ademas de tirantes: el `no-cache` del origen ya lo corrige para quien
      // respete las directivas, y esto lo corrige tambien para quien no. Descartado
      // aprovecharlo para cachear la URL versionada a largo plazo (`immutable`): la
      // version la bumpeamos a mano, asi que un archivo editado sin bump quedaria clavado
      // en el borde durante lo que durase ese plazo.
      url: `${buildAbsoluteUrl(req, artifact.route)}?v=${encodeURIComponent(artifact.artifactVersion)}`,
      download_url: `${buildAbsoluteUrl(req, artifact.route)}?v=${encodeURIComponent(artifact.artifactVersion)}&download=1`
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

    // El sitio esta detras de Cloudflare, que cachea por EXTENSION: `.js` esta en su
    // lista por defecto, asi que estas rutas se servian desde el borde hasta cuatro horas
    // aunque cuelguen de `/api/`. Eso rompe justo lo que `artifact_version` promete —el
    // manifiesto anunciaba el conductor en 1.4.0 y la URL entregaba el 1.3.0, visto el
    // 2026-08-08—, y purgar a mano no es un arreglo: el hueco se reabre en el despliegue
    // siguiente. `no-cache` no prohibe guardar, obliga a revalidar; con el ETag que pone
    // express la revalidacion cuesta un 304, asi que la correccion no se paga en ancho de
    // banda. Va aqui y no en nginx porque el artefacto y su version salen del mismo sitio.
    res.setHeader('Cache-Control', 'no-cache');
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

app.get(publicIntegrationBasePath, async (req, res) => {
  // El manifiesto es publico y sin identidad, asi que el proyecto —si lo hay— viaja en la
  // consulta. Un `project_url` desconocido no es un error: se sirve lo global, que es lo
  // que ese cliente habria recibido de todos modos.
  const projectUrl = typeof req.query.project_url === 'string' && req.query.project_url.trim()
    ? normalizeUrl(req.query.project_url.trim())
    : null;

  let override = null;
  try {
    override = projectUrl ? await getMethodConductionOverride(projectUrl) : null;
  } catch (error) {
    logger.warn({ err: error, project_url: projectUrl }, 'method_conduction override read failed');
  }

  res.json(buildIntegrationManifest(req, override));
});

app.get(`${publicIntegrationBasePath}/skills.json`, async (req, res) => sendIntegrationArtifact(req, res, 'skills_json'));
app.get(`${publicIntegrationBasePath}/skill.md`, async (req, res) => sendIntegrationArtifact(req, res, 'skill_markdown'));
app.get(`${publicIntegrationBasePath}/agent-guidelines.md`, async (req, res) => sendIntegrationArtifact(req, res, 'agent_guidelines'));
app.get(`${publicIntegrationBasePath}/runtime-adapters/spec/apts-surface.json`, async (req, res) => sendIntegrationArtifact(req, res, 'surface_spec'));
app.get(`${publicIntegrationBasePath}/scripts/generate-adapters.js`, async (req, res) => sendIntegrationArtifact(req, res, 'adapter_generator'));
app.get(`${publicIntegrationBasePath}/conductor/apts-loop.js`, async (req, res) => sendIntegrationArtifact(req, res, 'loop_conductor'));
app.get(`${publicIntegrationBasePath}/conductor/README.md`, async (req, res) => sendIntegrationArtifact(req, res, 'loop_conductor_readme'));
app.get(`${publicIntegrationBasePath}/conductor/prompts/dev-story-revision-adversaria.md`, async (req, res) => sendIntegrationArtifact(req, res, 'loop_prompt_code_review'));

// Las cuatro rutas `/agentes/*.agent.md` se retiraron con VS Code el 2026-08-08:
// eran plantillas descargables para copiar a `.github/agents`, y los dos runtimes
// que quedan materializan sus agentes desde el spec con el generador. Un 404 aqui
// es la respuesta correcta, no una regresion.

// --- AGENT API (SKILLS) ---

const notifyWebhook = async (project_url, payload) => {
  try {
    const project = await db('projects').where({ url: project_url }).first();
    if (project && project.webhook_url) {
      await fetch(project.webhook_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        // sin plazo, un webhook del cliente que no responde colgaba la
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
    backlog_item_id: backlogItemId,
    owns_backlog_item: ownsBacklogItem
  } = payload;
  const url = normalizeUrl(projectUrl || '');

  if (!url) {
    throw createHttpError(400, 'Project url is required');
  }

  // Sin item no hay nada que poseer, asi que el campo solo no significa nada. Aceptarlo
  // en silencio seria publicar un campo que no hace nada.
  if (ownsBacklogItem !== undefined && !backlogItemId) {
    throw createHttpError(400, 'owns_backlog_item requires backlog_item_id');
  }

  const owns = ownsBacklogItem !== false;

  if (backlogItemId) {
    const linkedBacklogItem = await connection('backlog_items')
      .where({ id: backlogItemId, project_url: url })
      .whereNull('deleted_at')
      .first();

    if (!linkedBacklogItem) {
      throw createHttpError(400, 'Backlog item id is not valid for project url');
    }

    // La reanudacion se busca POR `active_task_id`, que es el puntero de propiedad: sin
    // propiedad no hay a quien reanudar. Y es justo lo que quiere quien pide asociacion
    // sola —el conductor—: cada pasada sobre una unidad es una ejecucion distinta, y
    // fundirlas escondería el historial que esta columna viene a construir.
    if (owns && linkedBacklogItem.active_task_id) {
      const activeTask = await connection('tasks')
        .where({ id: linkedBacklogItem.active_task_id, project_url: url })
        .first();

      if (activeTask && TASK_RESUMABLE_STATUSES.has(activeTask.status)) {
        const previousStatus = activeTask.status;

        await connection('tasks')
          .where({ id: activeTask.id })
          .update({
            status: 'in_progress',
            // Una tarea reanudada puede ser anterior a la columna, y esta es la unica
            // ocasion en que sabemos de que unidad era sin adivinarlo.
            backlog_item_id: backlogItemId,
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
          () => stageBacklogCoverageDocument(connection, backlogItemId),
          { action: 'register_task.resume_backlog_sync', backlog_item_id: backlogItemId, project_url: url }
        );

        return {
          task_id: activeTask.id,
          status: 'in_progress',
          backlog_item_id: backlogItemId,
          owns_backlog_item: true,
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
    // La asociacion se escribe siempre que venga el item, la pida como dueña o no: es la
    // mitad informativa y no tiene efectos.
    backlog_item_id: backlogItemId || null,
    status: 'in_progress',
    last_heartbeat: connection.fn.now()
  }).returning('*');

  // Y la propiedad solo si se pide. Esto es lo unico que abre la propagacion de estado:
  // desde aqui, cerrar la tarea cierra la historia.
  if (backlogItemId && owns) {
    await connection('backlog_items')
      .where({ id: backlogItemId, project_url: url })
      .update({
        status: 'in_progress',
        active_task_id: task.id,
        updated_at: connection.fn.now()
      });

    await runNonBlockingSemanticOperation(
      () => stageBacklogCoverageDocument(connection, backlogItemId),
      { action: 'register_task.create_backlog_sync', backlog_item_id: backlogItemId, project_url: url }
    );
  }

  return {
    task_id: task.id,
    status: task.status,
    backlog_item_id: backlogItemId || null,
    owns_backlog_item: backlogItemId ? owns : false,
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
    () => stageBacklogCoverageDocument(connection, backlogItem.id),
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
    () => stageBacklogCoverageDocument(connection, backlogItem.id),
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
      () => stageBacklogCoverageDocuments(connection, affectedBacklogItems.map((item) => item.id)),
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

const logAgentProgressInternal = async (taskId, payload, { connection = db, actionType = null } = {}) => {
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
    action_type: actionType,
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
    agent_name: agentName,
    backlog_item_id: backlogItemId
  } = payload;
  const url = normalizeUrl(projectUrl || '');

  if (!url) {
    throw createHttpError(400, 'Project url is required');
  }

  const task = await connection('tasks').where({ id: taskId }).first();
  if (!task) {
    throw createHttpError(404, 'Task not found');
  }

  if (backlogItemId) {
    const named = await connection('backlog_items')
      .where({ id: backlogItemId, project_url: url })
      .whereNull('deleted_at')
      .first('id');
    if (!named) {
      throw createHttpError(400, 'Backlog item id is not valid for project url');
    }
  }

  await connection('tasks')
    .where({ id: taskId })
    .update({ status: 'stalled', updated_at: connection.fn.now() });

  await connection('projects').where({ url }).update({ status: 'blocked' });
  // La unidad que el agente nombra, y la que su tarea posea. Son dos caminos y no uno
  // porque una tarea puede no poseer ninguna —la del conductor no lo hace— y hasta ahora
  // eso dejaba el bloqueo sin apuntar a nada: se marcaba el proyecto entero, que no
  // estaba bloqueado, y no la unidad, que si. Nombrar la misma que ya se posee no la
  // marca dos veces: es el mismo `id` en el `whereIn`.
  const objetivos = [...new Set([
    ...(backlogItemId ? [backlogItemId] : []),
    ...(await connection('backlog_items').where({ active_task_id: taskId }).pluck('id'))
  ])];
  const blockedBacklogItems = objetivos.length
    ? await connection('backlog_items')
      .whereIn('id', objetivos)
      .update({ status: 'blocked', updated_at: connection.fn.now() })
      .returning(['id'])
    : [];
  await runNonBlockingSemanticOperation(
    () => stageBacklogCoverageDocuments(connection, blockedBacklogItems.map((item) => item.id)),
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
// piezas que hasta ahora vivían dentro de la ruta express.
//
// La superficie MCP remota ejecuta en proceso: no tiene `req.query` ni
// `req.params`, así que el parseo de parámetros y las tres lecturas que llevaban
// la consulta incrustada en la ruta se extraen aquí. Las rutas y la superficie
// remota llaman a las mismas funciones, que es lo que hace que la igualdad de
// sea por construcción y no por casualidad.
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

// `create_backlog_item` era la única de las siete operaciones de lote que
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

// la validación de create_initiative vive aquí para que la hereden las dos
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

  // Sin recorte: el esquema ya acota top_k a 1..MAX_SEMANTIC_SEARCH_TOP_K.
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
// Remote MCP surface: POST /mcp (Streamable HTTP, stateless).
//
// la ejecución no da ningún salto HTTP interno: dispatch() recibe un ejecutor
// en proceso con las mismas 21 funciones que
// exportaba el cliente, y cada una llama directamente a la función de negocio.
// ---------------------------------------------------------------------------

// Identity headers set once in the client's MCP registration block.
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
// que decide qué se exige antes de ejecutar. Mientras el archivo
// descargable siga publicándose, la prueba interna de contrato comprueba
// que esta tabla y la del cliente no se separen.
const MCP_IDENTITY_FIELDS_BY_OPERATION = {
  register_task: ['project_url', 'agent_name', 'agent_email'],
  read_project_context: ['url'],
  list_backlog_items: ['url'],
  get_project_constraints: ['url'],
  set_project_constraints: ['url'],
  search_similar_bug_reports: ['url'],
  create_backlog_item: ['project_url'],
  update_task_status: ['task_id', 'project_url', 'agent_name', 'agent_email'],
  // `branch` sale de la lista: sin cliente por medio no hay resolución
  // automática que cortar, y siempre fue opcional de verdad.
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

  mcpRuntimePromise = import(pathToFileURL(path.join(__dirname, 'scripts', 'lib', 'mcp_stdio_runtime.mjs')).href)
    .then((server) => ({ server }))
    .catch((error) => {
      mcpRuntimePromise = null;
      throw error;
    });

  return mcpRuntimePromise;
};

// --- Ejecutor en proceso ----------------------------------------
//
// dispatch() llama a `client[clientExport](payload)`. Ese objeto es el de abajo:
// las 21 funciones llamando directamente a la función de negocio que ejecutaría
// la ruta express, sin pasar por HTTP.
//
// Cada función reproduce **la ruta concreta que el cliente habría llamado** con
// ese mismo payload: mismo esquema de validación, mismo cuerpo de respuesta y,
// cuando falla, el mismo error que el cliente habría construido a partir de la
// respuesta HTTP. Es lo que hace comparable el resultado en .

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

// Traduce un error del servidor al mismo objeto que se obtendría leyendo la
// respuesta HTTP. Sin esto, un mismo rechazo se vería distinto según el camino
// aunque la causa fuera la misma.
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

  setProjectConstraints: (payload) => runMcpOperation(
    () => {
      const url = normalizeUrl(payload?.url);
      if (!url) {
        throw createHttpError(400, 'Project url is required');
      }
      return setProjectConstraints(url, parseProjectConstraintsPatch(payload));
    },
    { fallbackMessage: 'Failed to write project constraints', logMessage: 'write_project_constraints failed' }
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
      // Diferencia declarada: el servidor valida el resto del cuerpo
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
// escribiría contra el proyecto equivocado.
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
      // "la llamada gana a la cabecera" existe para el cambio de rol,
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
  // the client program actually sends the registration headers.
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

// set_project_constraints: hermana de escritura de la ruta de arriba. Parche —solo
// los campos que vienen— sobre la fila `config` del proyecto; responde lo efectivo.
app.put('/api/projects/:url/constraints', apiLimiter, authenticateAgent, async (req, res) => {
  try {
    const url = normalizeUrl(decodeURIComponent(req.params.url));

    if (!url) {
      return res.status(400).json({ error: 'Project url is required' });
    }

    const constraints = await setProjectConstraints(url, parseProjectConstraintsPatch(req.body));
    return res.json(constraints);
  } catch (routeError) {
    return sendApiError(res, routeError, {
      fallbackMessage: 'Failed to write project constraints',
      logMessage: 'write_project_constraints failed',
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

// create_initiative: operación de bootstrap del método conducible desde el
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

// set_agent_role: registra/actualiza el puntero de un rol del roster en
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

// motor de método (servidor-autoritativo). Forwards finos hacia el
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

// apts_workflow_step: goteo modelo B. Sirve el paso actual reconstruido
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

// apts_submit_step: captura el output del paso (doc→semantic_documents
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

// ---- Diario del conductor ----
// El conductor escribe un JSONL local con cada decision que toma y ese archivo vive en la
// maquina de quien lo corre: desde APTS, una ejecucion desatendida era una tarea que
// cambiaba de estado sin que constara por que. Esta ruta le da un segundo destino.
//
// No es operacion MCP a proposito: no es del metodo ni la llama un agente, la llama el
// programa que conduce. Meterla en el contrato subiria la superficie que todo cliente ve
// para algo que solo usa el conductor.
//
// `task_id` es obligatorio porque el listado del panel une `agent_logs` con `tasks` para
// saber de que proyecto es cada fila: una fila sin tarea seria invisible, y escribir algo
// que nadie puede leer es peor que no escribirlo.
app.post('/api/conductor/journal', apiLimiter, authenticateAgent, async (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const taskId = typeof body.task_id === 'string' ? body.task_id.trim() : '';
  const message = typeof body.message === 'string' ? body.message.trim() : '';

  if (!taskId) return res.status(400).json({ error: 'task_id is required' });
  if (!message) return res.status(400).json({ error: 'message is required' });

  try {
    const logged = await logAgentProgressInternal(taskId, {
      agent_name: body.agent_name || req.headers['x-apts-agent-name'] || null,
      message,
      technical_details: body.event === undefined ? null : body.event
    }, { actionType: 'journal' });

    return res.json(logged);
  } catch (routeError) {
    return sendApiError(res, routeError, {
      fallbackMessage: 'Failed to record conductor journal entry',
      logMessage: 'conductor_journal failed',
      logContext: { task_id: taskId }
    });
  }
});

// ---- Órdenes para el conductor ----
// Buzón, no canal en vivo: el conductor pregunta cada diez segundos. Mismas dos razones
// que el diario para no ser operación MCP —no es del método y no la llama un agente— y
// una más: el panel también escribe aquí, y el panel va por sesión, no por clave.
const CONDUCTOR_COMMANDS = ['start', 'stop', 'pause', 'resume'];
const CONDUCTOR_ORDER_STATUSES = ['pending', 'acked', 'done', 'cancelled'];

app.get('/api/conductor/orders/next', apiLimiter, authenticateAgent, async (req, res) => {
  const agentName = String(req.query.agent_name || req.headers['x-apts-agent-name'] || '').trim();
  if (!agentName) return res.status(400).json({ error: 'agent_name is required' });

  try {
    const order = await db('conductor_orders')
      .where({ agent_name: agentName, status: 'pending' })
      .orderBy('created_at', 'asc')
      .first();

    return res.json({ order: order || null });
  } catch (error) {
    return sendApiError(res, error, {
      fallbackMessage: 'Failed to read conductor orders',
      logMessage: 'conductor_orders_next failed',
      logContext: { agent_name: agentName }
    });
  }
});

app.post('/api/conductor/orders/:id/ack', apiLimiter, authenticateAgent, async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const status = String(body.status || 'acked').trim();
  if (!CONDUCTOR_ORDER_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${CONDUCTOR_ORDER_STATUSES.join(', ')}` });
  }

  try {
    const updated = await db('conductor_orders')
      .where({ id: req.params.id })
      .update({
        status,
        detail: typeof body.detail === 'string' ? body.detail : null,
        acked_at: db.fn.now(),
        updated_at: db.fn.now()
      })
      .returning('*');

    if (!updated.length) return res.status(404).json({ error: 'Order not found' });
    return res.json({ order: updated[0] });
  } catch (error) {
    return sendApiError(res, error, {
      fallbackMessage: 'Failed to acknowledge conductor order',
      logMessage: 'conductor_orders_ack failed',
      logContext: { order_id: req.params.id }
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

// Las restricciones del proyecto ya se leian y escribian, pero solo por la superficie de
// agente (`/api/projects/:url/constraints`, con `authenticateAgent`), y el panel no lleva
// clave de API sino sesion: por eso el campo seguia sin pantalla. Estas dos rutas son las
// mismas funciones detras de `requireAuth`; no hay logica duplicada.
app.get('/api/dashboard/projects/:url/constraints', requireAuth, async (req, res) => {
  try {
    const url = normalizeUrl(decodeURIComponent(req.params.url));
    if (!url) return res.status(400).json({ error: 'Project url is required' });

    const constraints = await getProjectConstraints(url);
    return res.json(constraints);
  } catch (error) {
    return sendApiError(res, error, {
      fallbackMessage: 'Failed to read project constraints',
      logMessage: 'Dashboard project constraints read failed',
      logContext: { project_url: req.params.url }
    });
  }
});

app.put('/api/dashboard/projects/:url/constraints', requireAuth, async (req, res) => {
  try {
    const url = normalizeUrl(decodeURIComponent(req.params.url));
    if (!url) return res.status(400).json({ error: 'Project url is required' });

    const constraints = await setProjectConstraints(url, parseProjectConstraintsPatch(req.body));
    return res.json(constraints);
  } catch (error) {
    return sendApiError(res, error, {
      fallbackMessage: 'Failed to write project constraints',
      logMessage: 'Dashboard project constraints write failed',
      logContext: { project_url: req.params.url }
    });
  }
});

// ---- Roster del metodo, editable ----
// La biblioteca BMAD (`entities`) es de solo lectura a proposito: la siembra el corpus y
// el seed la reescribe. Lo editable vive en `entity_overrides`, con '*' por ambito global
// y la URL del proyecto por ambito particular; asi re-sembrar el metodo no borra nada de
// lo que escriba una persona desde el panel.
const ENTITY_OVERRIDE_GLOBAL_SCOPE = '*';

const parseEntityOverridePatch = (body = {}) => {
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const unknown = Object.keys(source).filter((key) => !ENTITY_PROFILE_FIELDS.includes(key));
  if (unknown.length) {
    throw createHttpError(
      400,
      `Unknown entity field(s): ${unknown.join(', ')}. Valid fields: ${ENTITY_PROFILE_FIELDS.join(', ')}`
    );
  }

  const patch = {};
  for (const field of ENTITY_PROFILE_FIELDS) {
    if (!(field in source)) continue;
    const value = source[field];
    if (value === null) {
      patch[field] = null;
      continue;
    }
    if (typeof value !== 'string') {
      throw createHttpError(400, `${field} must be a string or null`);
    }
    // Vacio es heredar, no "pisar con vacio": no hay forma de querer que un agente no
    // tenga persona, y si la hubiera se expresaria borrandola en la biblioteca.
    patch[field] = value.trim() === '' ? null : value;
  }

  if (!Object.keys(patch).length) {
    throw createHttpError(400, `At least one field is required: ${ENTITY_PROFILE_FIELDS.join(', ')}`);
  }

  return patch;
};

const setEntityOverride = async (scope, entityKey, patch) => {
  const entity = await db('entities').where({ key: entityKey }).first('key');
  if (!entity) {
    throw createHttpError(404, `Unknown entity key: ${entityKey}`);
  }

  const existing = await db('entity_overrides')
    .where({ scope_project_url: scope, entity_key: entityKey })
    .first();
  const merged = { ...(existing || {}), ...patch };

  const row = {};
  for (const field of ENTITY_PROFILE_FIELDS) {
    row[field] = merged[field] == null ? null : merged[field];
  }

  const empty = ENTITY_PROFILE_FIELDS.every((field) => row[field] === null);
  if (empty) {
    // Un override sin ningun campo no dice nada: se borra la fila en vez de dejarla
    // vacia, para que "no hay override" sea un solo estado y no dos.
    await db('entity_overrides').where({ scope_project_url: scope, entity_key: entityKey }).del();
    return null;
  }

  await db('entity_overrides')
    .insert({ scope_project_url: scope, entity_key: entityKey, ...row, updated_at: db.fn.now() })
    .onConflict(['scope_project_url', 'entity_key'])
    .merge({ ...row, updated_at: db.fn.now() });

  return db('entity_overrides').where({ scope_project_url: scope, entity_key: entityKey }).first();
};

const listRoster = async (projectUrl = null) => {
  const entities = await db('entities')
    .where({ kind: 'role' })
    .orderBy('key')
    .select('key', 'name', 'source_ref', ...ENTITY_PROFILE_FIELDS.filter((field) => field !== 'name'));

  const scopes = projectUrl ? [ENTITY_OVERRIDE_GLOBAL_SCOPE, projectUrl] : [ENTITY_OVERRIDE_GLOBAL_SCOPE];
  const overrides = await db('entity_overrides').whereIn('scope_project_url', scopes);

  const agents = [];
  for (const entity of entities) {
    agents.push({
      key: entity.key,
      source_ref: entity.source_ref,
      library: Object.fromEntries(ENTITY_PROFILE_FIELDS.map((field) => [field, entity[field] ?? null])),
      global_override: overrides.find(
        (row) => row.entity_key === entity.key && row.scope_project_url === ENTITY_OVERRIDE_GLOBAL_SCOPE
      ) || null,
      project_override: projectUrl
        ? overrides.find((row) => row.entity_key === entity.key && row.scope_project_url === projectUrl) || null
        : null,
      // Lo efectivo es lo que recibe el agente: la misma funcion que usa el motor.
      effective: await resolveEntityProfile(db, entity.key, projectUrl)
    });
  }

  const workflows = await db('workflow_definitions')
    .orderBy(['phase', 'key'])
    .select('key', 'phase', 'status', 'source_ref');

  return { agents, workflows };
};

app.get('/api/dashboard/roster', requireAuth, async (req, res) => {
  try {
    return res.json(await listRoster());
  } catch (error) {
    return sendApiError(res, error, {
      fallbackMessage: 'Failed to load roster',
      logMessage: 'Dashboard roster read failed'
    });
  }
});

app.put('/api/dashboard/roster/entities/:key', requireAuth, async (req, res) => {
  try {
    const override = await setEntityOverride(
      ENTITY_OVERRIDE_GLOBAL_SCOPE,
      String(req.params.key || '').trim(),
      parseEntityOverridePatch(req.body)
    );
    return res.json({
      entity_key: req.params.key,
      override,
      effective: await resolveEntityProfile(db, String(req.params.key || '').trim(), null)
    });
  } catch (error) {
    return sendApiError(res, error, {
      fallbackMessage: 'Failed to write entity override',
      logMessage: 'Dashboard entity override write failed',
      logContext: { entity_key: req.params.key }
    });
  }
});

app.get('/api/dashboard/projects/:url/roster', requireAuth, async (req, res) => {
  try {
    const url = normalizeUrl(decodeURIComponent(req.params.url));
    if (!url) return res.status(400).json({ error: 'Project url is required' });

    return res.json(await listRoster(url));
  } catch (error) {
    return sendApiError(res, error, {
      fallbackMessage: 'Failed to load project roster',
      logMessage: 'Dashboard project roster read failed',
      logContext: { project_url: req.params.url }
    });
  }
});

app.put('/api/dashboard/projects/:url/roster/:key', requireAuth, async (req, res) => {
  try {
    const url = normalizeUrl(decodeURIComponent(req.params.url));
    if (!url) return res.status(400).json({ error: 'Project url is required' });

    const project = await db('projects').where({ url }).first();
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const entityKey = String(req.params.key || '').trim();
    const override = await setEntityOverride(url, entityKey, parseEntityOverridePatch(req.body));
    return res.json({
      project_url: url,
      entity_key: entityKey,
      override,
      effective: await resolveEntityProfile(db, entityKey, url)
    });
  } catch (error) {
    return sendApiError(res, error, {
      fallbackMessage: 'Failed to write project entity override',
      logMessage: 'Dashboard project entity override write failed',
      logContext: { project_url: req.params.url, entity_key: req.params.key }
    });
  }
});

app.get('/api/dashboard/projects/:url/method-conduction', requireAuth, async (req, res) => {
  try {
    const url = normalizeUrl(decodeURIComponent(req.params.url));
    if (!url) return res.status(400).json({ error: 'Project url is required' });

    const override = await getMethodConductionOverride(url);
    return res.json({
      project_url: url,
      defaults: METHOD_CONDUCTION,
      override,
      effective: { ...METHOD_CONDUCTION, ...override }
    });
  } catch (error) {
    return sendApiError(res, error, {
      fallbackMessage: 'Failed to read method conduction',
      logMessage: 'Dashboard method conduction read failed',
      logContext: { project_url: req.params.url }
    });
  }
});

app.put('/api/dashboard/projects/:url/method-conduction', requireAuth, async (req, res) => {
  try {
    const url = normalizeUrl(decodeURIComponent(req.params.url));
    if (!url) return res.status(400).json({ error: 'Project url is required' });

    const override = await setMethodConductionOverride(url, parseMethodConductionPatch(req.body));
    return res.json({
      project_url: url,
      defaults: METHOD_CONDUCTION,
      override,
      effective: { ...METHOD_CONDUCTION, ...override }
    });
  } catch (error) {
    return sendApiError(res, error, {
      fallbackMessage: 'Failed to write method conduction',
      logMessage: 'Dashboard method conduction write failed',
      logContext: { project_url: req.params.url }
    });
  }
});

// El panel escribe las órdenes y lee el estado. No hay estado propio que mantener: lo que
// se muestra se deduce de lo que el conductor ya deja —su tarea abierta y las filas de
// diario— más la última orden que se le mandó. Un estado guardado aparte sería una segunda
// versión de la verdad que se desincronizaría en cuanto alguien matara el proceso a mano.
app.post('/api/dashboard/conductor/orders', requireAuth, async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const command = String(body.command || '').trim();
  const agentName = String(body.agent_name || '').trim();

  if (!CONDUCTOR_COMMANDS.includes(command)) {
    return res.status(400).json({ error: `command must be one of: ${CONDUCTOR_COMMANDS.join(', ')}` });
  }
  if (!agentName) return res.status(400).json({ error: 'agent_name is required' });

  try {
    const projectUrl = body.project_url ? normalizeUrl(String(body.project_url)) : null;
    if (projectUrl) {
      const project = await db('projects').where({ url: projectUrl }).first();
      if (!project) return res.status(404).json({ error: 'Project not found' });
    }

    const [order] = await db('conductor_orders').insert({
      project_url: projectUrl,
      agent_name: agentName,
      command,
      payload: body.payload == null ? null : JSON.stringify(body.payload)
    }).returning('*');

    return res.json({ order });
  } catch (error) {
    return sendApiError(res, error, {
      fallbackMessage: 'Failed to create conductor order',
      logMessage: 'Dashboard conductor order create failed',
      logContext: { agent_name: agentName, command }
    });
  }
});

app.get('/api/dashboard/projects/:url/conductor', requireAuth, async (req, res) => {
  try {
    const url = normalizeUrl(decodeURIComponent(req.params.url));
    if (!url) return res.status(400).json({ error: 'Project url is required' });

    const agentName = String(req.query.agent_name || '').trim();

    const orders = await db('conductor_orders')
      .where((builder) => {
        builder.where({ project_url: url });
        if (agentName) builder.orWhere({ agent_name: agentName });
      })
      .orderBy('created_at', 'desc')
      .limit(10);

    const journal = await db('agent_logs')
      .join('tasks', 'agent_logs.task_id', 'tasks.id')
      .where('tasks.project_url', url)
      .where('agent_logs.action_type', 'journal')
      .orderBy('agent_logs.created_at', 'desc')
      .limit(10)
      .select('agent_logs.*', 'tasks.title as task_title');

    const activeTask = agentName
      ? await db('tasks')
        .where({ project_url: url, agent_name: agentName })
        .whereIn('status', ['todo', 'in_progress', 'review'])
        .orderBy('updated_at', 'desc')
        .first()
      : null;

    return res.json({ project_url: url, agent_name: agentName || null, orders, journal, active_task: activeTask || null });
  } catch (error) {
    return sendApiError(res, error, {
      fallbackMessage: 'Failed to read conductor state',
      logMessage: 'Dashboard conductor state read failed',
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

// Soltar la unidad que sostiene un puntero de método.
//
// El arrendamiento ya existe —`METHOD_CLAIM_TTL_MS`, y «caducar es soltar»— pero solo
// corre contra los punteros de OTROS agentes: el propio se devuelve tal cual mientras la
// unidad no sea terminal, y eso es deliberado, porque es lo que permite matar y relanzar
// el conductor sin perder el sitio. Lo que faltaba era poder devolverla a propósito.
//
// Es ruta de panel y no operación de agente por dos razones. Una, que soltar SOLO no
// sirve al agente: el `apts_next` siguiente vuelve a reclamar la misma unidad, porque
// sigue siendo la primera del plan. Dos, que el caso real es que una persona mire un
// atasco y decida; para eso ya existe el precedente de al lado, `/api/tasks/:id/resolve`,
// que deja su rastro firmado. Este hace lo mismo con el puntero.
//
// Sin unidad reclamada no hay nada que soltar y se responde 409 en vez de un 200 que no
// hizo nada: la diferencia importa cuando alguien lo llama para desatascar algo y quiere
// saber si desatascó.
app.post('/api/method/pointers/:agent/release', requireAuth, async (req, res) => {
  const agentName = normalizeInputString(req.params?.agent, { unwrapQuotes: true });
  const parsedBody = releasePointerBodySchema.safeParse(req.body || {});
  if (!parsedBody.success) {
    return res.status(400).json({ error: zodErrorMessage(parsedBody.error) });
  }

  const url = normalizeUrl(parsedBody.data.project_url);
  const { instruction } = parsedBody.data;

  if (!agentName) {
    return res.status(400).json({ error: 'Agent name is required' });
  }

  try {
    const pointer = await db('project_state')
      .where({ project_url: url, agent_name: agentName })
      .first('id', 'cursor', 'step_status');

    if (!pointer) {
      return res.status(404).json({ error: 'Method pointer not found for that project and agent' });
    }

    const heldStoryId = (pointer.cursor && pointer.cursor.story_id) || null;
    if (!heldStoryId) {
      return res.status(409).json({ error: 'That pointer is not holding any unit' });
    }

    await db('project_state').where({ id: pointer.id }).update({
      cursor: null,
      step_status: 'idle',
      updated_at: db.fn.now()
    });

    await db('agent_logs').insert({
      // Sin tarea: lo que se suelta es el puntero del método, que no es de nadie en
      // particular. La columna es nulable y el rastro vale igual.
      task_id: null,
      agent_name: 'Human Supervisor',
      action_type: 'update',
      message: `Method claim released for ${agentName} on unit ${heldStoryId}: ${instruction}`
    });

    return res.json({
      success: true,
      agent_name: agentName,
      project_url: url,
      released_backlog_item_id: heldStoryId
    });
  } catch (error) {
    return sendApiError(res, error, {
      fallbackMessage: 'Failed to release method claim',
      logMessage: 'Method claim release failed',
      logContext: { project_url: url, agent_name: agentName }
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

// Auto-chequeo de contrato. Se ejecuta en el arranque, antes de escuchar, y aborta
// si la superficie remota se ha separado de `apts_skills.json`.
//
// Comprueba dos cosas que ningún otro sitio comprueba:
//   1. el ejecutor en proceso expone exactamente una función por operación;
//   2. la tabla de identidad no nombra operaciones que no existen.
const checkRemoteMcpContract = async () => {
  const { contractOperations } = await import(pathToFileURL(path.join(__dirname, 'scripts', 'lib', 'contract_check.mjs')).href);
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

