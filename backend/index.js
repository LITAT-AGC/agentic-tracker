require('dotenv').config();
const fs = require('node:fs/promises');
const path = require('node:path');
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

app.use(express.json());
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
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
}));

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5 });
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 100 });

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
const OPENROUTER_EMBEDDINGS_URL = 'https://openrouter.ai/api/v1/embeddings';
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

const sendApiError = (res, error, {
  fallbackMessage = 'Internal server error',
  logMessage = 'Request failed',
  logContext = {},
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

const sendBatchOperationResponse = (res, results, { successStatus = 200 } = {}) => {
  const failed = results.filter((item) => !item.success).length;
  const succeeded = results.length - failed;

  return res.status(failed > 0 ? 207 : successStatus).json({
    success: failed === 0,
    processed: results.length,
    succeeded,
    failed,
    results
  });
};

const nonEmptyStringSchema = (
  requiredMessage,
  invalidTypeMessage = requiredMessage,
  options = {}
) => z.preprocess(
  (value) => normalizeSchemaInputString(value, options),
  z.string({ invalid_type_error: invalidTypeMessage }).min(1, requiredMessage)
);

const optionalStringSchema = (invalidTypeMessage, options = {}) => z.preprocess(
  (value) => {
    if (value === undefined) return undefined;
    return normalizeSchemaInputString(value, options);
  },
  z.string({ invalid_type_error: invalidTypeMessage }).optional()
);

const optionalNullableStringSchema = (invalidTypeMessage, options = {}) => z.preprocess(
  (value) => {
    if (value === undefined) return undefined;
    if (value === null || value === '') return null;
    return normalizeSchemaInputString(value, options);
  },
  z.string({ invalid_type_error: invalidTypeMessage }).nullable().optional()
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
    z.string({ invalid_type_error: invalidTypeMessage })
      .refine((value) => allowedValues.includes(value), { message: invalidValueMessage })
  );

  return optional ? schema.optional() : schema;
};

const integerFieldSchema = (invalidMessage, { optional = false } = {}) => {
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
    z.number({ invalid_type_error: invalidMessage }).int(invalidMessage)
  );

  return optional ? schema.optional() : schema;
};

const numberFieldSchema = (invalidMessage, { optional = false, min, max } = {}) => {
  let numberSchema = z.number({ invalid_type_error: invalidMessage });

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
    z.string({ invalid_type_error: invalidMessage }).regex(UUID_REGEX, invalidMessage)
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
  agent_name: optionalStringSchema('Agent name must be a string'),
  agent_email: optionalStringSchema('Agent email must be a string'),
  context: z.preprocess(
    (value) => {
      if (value === undefined || value === null) return undefined;
      return normalizeSchemaInputString(value);
    },
    z.string({ invalid_type_error: 'Context must be a string' }).optional()
  ),
  backlog_item_id: uuidFieldSchema('Backlog item id must be a valid UUID', { optional: true })
});

const taskStatusUpdateBodySchema = z.object({
  status: enumFieldSchema(TASK_STATUSES, 'Invalid task status', 'Invalid task status'),
  project_url: optionalStringSchema('Project url must be a string', { unwrapQuotes: true }),
  agent_name: optionalStringSchema('Agent name must be a string')
});

const taskStatusUpdateBatchBodySchema = taskStatusUpdateBodySchema.extend({
  task_id: uuidFieldSchema('Task id must be a valid UUID')
});

const logAgentProgressBodySchema = z.object({
  agent_name: optionalStringSchema('Agent name must be a string'),
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
  agent_name: optionalStringSchema('Agent name must be a string')
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
  top_k: integerFieldSchema('top_k must be an integer between 1 and 20', { optional: true }),
  threshold: numberFieldSchema('threshold must be a number between 0 and 1', { optional: true, min: 0, max: 1 }),
  include_closed: z.preprocess(
    (value) => {
      if (value === undefined) return undefined;
      if (typeof value === 'boolean') return value;
      if (typeof value === 'string') return parseBooleanFlag(value);
      return value;
    },
    z.boolean({ invalid_type_error: 'include_closed must be a boolean' }).optional()
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

const getEffectiveOpenRouterEmbeddingModel = async () => {
  const configuredModel = await getConfigValue(CONFIG_KEYS.openrouterEmbeddingModel);
  return configuredModel || DEFAULT_OPENROUTER_EMBEDDING_MODEL;
};

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
  const response = await fetch(OPENROUTER_MODELS_URL, {
    headers: getOpenRouterHeaders()
  });
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

const requestOpenRouterEmbedding = async (inputText, {
  usageType = 'embedding',
  projectUrl = null,
  backlogItemId = null
} = {}) => {
  const normalizedInput = normalizeTextField(inputText);
  if (!normalizedInput) {
    throw createHttpError(400, 'Embedding input text is required');
  }

  const model = await getEffectiveOpenRouterEmbeddingModel();

  const response = await fetch(OPENROUTER_EMBEDDINGS_URL, {
    method: 'POST',
    headers: getOpenRouterHeaders(),
    body: JSON.stringify({
      model,
      input: normalizedInput
    })
  });

  const data = await readOpenRouterResponse(response);
  await persistOpenRouterUsage({
    usageType,
    model,
    usage: data?.usage,
    projectUrl,
    backlogItemId
  });
  const embedding = parseEmbeddingVector(data?.data?.[0]?.embedding);

  if (!embedding.length) {
    throw createHttpError(502, 'OpenRouter embedding response did not include a valid vector');
  }

  return {
    model,
    embedding,
    norm: vectorNorm(embedding)
  };
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
  const response = await fetch(OPENROUTER_CHAT_URL, {
    method: 'POST',
    headers: getOpenRouterHeaders(),
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: buildBacklogAnalysisMessages(backlogItem)
    })
  });
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
const integrationManifestSchemaVersion = '2.0.37';
const publicIntegrationBasePath = '/api/public/integrar';
// Append-only history: never replace older versions with only the latest entry.
const integrationManifestReleaseNotes = [
  {
    version: '2.0.37',
    date: '2026-05-12',
    changes: [
      'The dedicated bug-intake custom agent and VS Code runtime adapter were removed from the public integration manifest and downloadable artifacts.',
      'Bootstrap and integration instructions now use direct backlog actions for defects: report bug situations as backlog item_type=bug and report solved bugs by updating tracked bug items to review/done with resolution evidence.'
    ]
  },
  {
    version: '2.0.36',
    date: '2026-05-12',
    changes: [
      'APTS integration shell routing for VS Code on Windows now requires APTS client/CLI calls to run through WSL terminals/tasks, alongside test execution.',
      'Downloadable integration guides now clarify that only non-APTS non-test operations should run through PowerShell terminals/tasks.'
    ]
  },
  {
    version: '2.0.35',
    date: '2026-05-11',
    changes: [
      'APTS bugfix intake policy now requires read-only triage first and explicit user confirmation before creating/updating bug backlog items or registering bugfix execution tasks.',
      'Downloadable intake agent templates, VS Code adapter, skills contract, and base guidelines were updated so chat false positives do not get registered as tracked bugs without operator approval.'
    ]
  },
  {
    version: '2.0.34',
    date: '2026-05-11',
    changes: [
      'APTS integration guidance now defines explicit shell routing for VS Code on Windows: run tests through WSL and run non-test operations through PowerShell.',
      'The downloadable skill package and base agent guidelines now publish this routing policy so client agents can replicate deterministic shell usage in Windows + VS Code workflows.'
    ]
  },
  {
    version: '2.0.33',
    date: '2026-05-11',
    changes: [
      'Integration guidance and downloadable agent templates now enforce a CLI-first protocol policy: avoid manual Git identity discovery in normal flows and prefer minimum payloads with official client/CLI auto-fill.',
      'Operational docs now clarify that protocol fields should be inspected only when required-field failures occur (for example via show-execution-context), reducing setup overhead for APTS-integrated clients.'
    ]
  },
  {
    version: '2.0.32',
    date: '2026-05-10',
    changes: [
      'Public integration manifest now supports runtime-aware recommendation filtering via query param runtime, so artifact installation can filter by runtime compatibility before applying recommended entries.',
      'Executor agent artifacts are published again as subagent-oriented (`user-invocable: false`, `disable-model-invocation: false`) to reduce skill-vs-agent invocation ambiguity in mixed runtimes such as OpenCode + VS Code setups.'
    ]
  },
  {
    version: '2.0.31',
    date: '2026-05-10',
    changes: [
      'Executor agent artifacts now publish explicit invocation compatibility metadata (`user-invocable: true` and `disable-model-invocation: false`) to reduce cross-runtime subagent launch failures in heterogeneous integrations.',
      'The update keeps orchestrator-to-executor delegation deterministic when the same APTS-integrated project is executed from runtimes that interpret invocability flags differently.'
    ]
  },
  {
    version: '2.0.30',
    date: '2026-05-10',
    changes: [
      'Agent guidelines now include a copy-ready runtime validation checklist for server-dependent tests, covering runtime detection, readiness checks, deterministic teardown, and blocker reporting.',
      'The checklist makes cross-runtime execution explicit so integrators can run the same APTS flow from VS Code, OpenCode, or other agent runtimes without orphaning background processes.'
    ]
  },
  {
    version: '2.0.29',
    date: '2026-05-10',
    changes: [
      'Executor process guidance is now runtime-aware so the same APTS-integrated project can run safely across VS Code, OpenCode, and other agent runtimes without assuming one shell lifecycle model.',
      'VS Code executor adapter now requires VS Code-native non-blocking process controls, while OpenCode plugin requirements remain explicit only for synchronous OpenCode bash environments.'
    ]
  },
  {
    version: '2.0.28',
    date: '2026-05-10',
    changes: [
      'Integration guidance now documents OpenCode process plugin setup (`@zenobius/opencode-background` and `opencode-pty`) to prevent synchronous bash hangs when validations need local servers.',
      'Executor templates now require OpenCode-safe process lifecycle management: never background servers with raw bash (`&` or `nohup`), use `createBackgroundProcess` or `pty_spawn`, verify readiness, and stop processes with `killProcesses` or `pty_kill` after tests.'
    ]
  },
  {
    version: '2.0.27',
    date: '2026-05-10',
    changes: [
      'Executor and orchestrator downloadable agent templates now state explicitly that any server required for validation must be started in background mode, verified as ready, and stopped after tests.',
      'VS Code runtime adapter artifacts for orchestrator and executor were updated to mirror the same background-mode server-testing requirement for delegated backlog execution flows.'
    ]
  },
  {
    version: '2.0.26',
    date: '2026-05-10',
    changes: [
      'Agent API now supports targeted read endpoints for one backlog item and one task, plus lightweight section filtering in read_project_context and id/ids pagination filters in list_backlog_items to reduce token-heavy orchestration loops.',
      'Official APTS clients and CLIs now expose get-backlog-item, get-task, and get-project-constraints operations and improve PowerShell-safe JSON handling with --json @file support and resilient inline parser normalization.'
    ]
  },
  {
    version: '2.0.25',
    date: '2026-05-09',
    changes: [
      'Public integration downloads now expose compatibility aliases for the bugfix intake agent and the VS Code bugfix intake adapter to avoid client timeouts caused by stale route names with aggressive retries.',
      'The VS Code bugfix intake adapter metadata now publishes a deprecated legacy filename so local updaters can clean old intake naming during sync.'
    ]
  },
  {
    version: '2.0.24',
    date: '2026-05-08',
    changes: [
      'APTS agent-facing reads now default to compact summaries at both the HTTP API and official client layers; explicit view=full remains available for follow-up detail fetches.',
      'Public integration docs, skills metadata, and agent templates now describe compact as the default operating mode for agents and full as an on-demand escalation path.'
    ]
  },
  {
    version: '2.0.23',
    date: '2026-05-08',
    changes: [
      'read_project_context and list_backlog_items now support view=compact to return summary-oriented payloads that omit long text fields, full task context, and full log technical_details.',
      'Official APTS clients, CLI help, skills contract, and agent guidance now expose and recommend compact reads for token-sensitive agent loops, escalating to full payloads only when needed.'
    ]
  },
  {
    version: '2.0.22',
    date: '2026-05-08',
    changes: [
      'Bootstrap metadata now publishes explicit PowerShell CLI reliability guidance, including staged minimal payload strategy, known parser pitfalls, and post-write verification rules.',
      'Official integration documentation and CLI help now emphasize update_backlog_item must use backlog_item_id (not id) and provide safer Windows examples for --json and --stdin usage.'
    ]
  },
  {
    version: '2.0.21',
    date: '2026-05-08',
    changes: [
      'Public integration manifest now declares explicit runtime agent discovery metadata for VS Code, including discovery path, filename glob, and post-sync reload requirement.',
      'APTS now publishes dedicated VS Code runtime adapter artifacts for orchestrator, executor, and bugfix intake under .github/agents so custom agents are discoverable and invocable after sync.'
    ]
  },
  {
    version: '2.0.20',
    date: '2026-05-08',
    changes: [
      'APTS adds semantic bug lookup via OpenRouter embeddings at search_similar_bug_reports to reduce duplicate defect intake before implementation starts.',
      'Official APTS clients, CLIs, and skills contract now expose search-similar-bug-reports while backlog bug items keep embedding metadata synchronized automatically.'
    ]
  },
  {
    version: '2.0.19',
    date: '2026-05-07',
    changes: [
      'Official APTS clients now persist managed execution context locally and reuse it as fallback for automatic payload field resolution across commands.',
      'Official CLI now exposes execution-context commands and updated help to keep repeated execution calls near-zero payload after register_task.'
    ]
  },
  {
    version: '2.0.18',
    date: '2026-05-07',
    changes: [
      'Official APTS clients now auto-resolve task_id from APTS_TASK_ID for repeated execution calls, further reducing protocol payload overhead in agents.',
      'Official skills contract and CLI guidance now publish reduced minimum payloads for update_task_status, log_agent_progress, report_blocker, and heartbeat under the managed client/CLI flow.'
    ]
  },
  {
    version: '2.0.17',
    date: '2026-05-07',
    changes: [
      'Official APTS clients now auto-resolve missing identity fields (project_url/url, agent_name, agent_email, branch) from environment variables first and local Git as fallback.',
      'Official CLI command guidance and skills contract now publish reduced minimum payloads aligned with identity auto-fill in managed client scripts.'
    ]
  },
  {
    version: '2.0.16',
    date: '2026-05-06',
    changes: [
      'Public APTS integration guidance now publishes explicit minimum payload fields, a short common-fields table, and a full happy-path sequence for the core commands.',
      'Official CLI help for CommonJS and ESM now shows per-command required fields and copy-ready examples, including Windows PowerShell-friendly usage patterns.'
    ]
  },
  {
    version: '2.0.15',
    date: '2026-04-29',
    changes: [
      'register_task now resumes an active task for the same backlog item when that task is in todo, in_progress, or stalled, instead of always creating duplicate execution tasks.',
      'Task status transitions are now strict: done is accepted only from review and only with recent execution activity (heartbeat or progress log), reducing accidental closure of interrupted executions.'
    ]
  },
  {
    version: '2.0.14',
    date: '2026-04-29',
    changes: [
      'Bootstrap metadata now defines an explicit official-script policy: base APTS integration operations must use only scripts published by the manifest.',
      'Integration guidance now forbids merging legacy local wrapper snippets into downloaded official APTS scripts, requiring full artifact replacement on version updates.'
    ]
  },
  {
    version: '2.0.13',
    date: '2026-04-29',
    changes: [
      'Bootstrap metadata now defines an explicit AGENTS.md setup policy so integrators can create a new instruction file when missing and safely update an existing one without replacing project-specific rules.',
      'The public APTS integration guides now include an idempotent create-or-update flow for AGENTS.md and .github/copilot-instructions.md using a managed section strategy.'
    ]
  },
  {
    version: '2.0.12',
    date: '2026-04-29',
    changes: [
      'The public integration package now publishes a dedicated APTS Bugfix Intake agent template for chat-triggered bug, error, and regression requests.',
      'Bootstrap metadata and base guidance now recommend using that agent as the first entrypoint for defect intake when the client runtime supports custom agents.'
    ]
  },
  {
    version: '2.0.11',
    date: '2026-04-28',
    changes: [
      'The public integration guidance now requires chat-triggered bugfix, error, and regression requests to be represented in APTS backlog before implementation starts.',
      'Bootstrap metadata, the skills contract, and the base agent guidelines now instruct integrators to reuse an existing tracked bug when possible or create a new backlog item with item_type=bug before registering execution work.'
    ]
  },
  {
    version: '2.0.10',
    date: '2026-04-28',
    changes: [
      'Bootstrap guidance now explicitly instructs integrators to remove older ad-hoc APTS wrapper scripts for base contract operations after installing the official client or CLI.',
      'The artifact sync policy now clarifies that only filenames published by APTS are deleted automatically; custom wrapper cleanup remains a manual migration step unless declared as legacy metadata.'
    ]
  },
  {
    version: '2.0.9',
    date: '2026-04-28',
    changes: [
      'The public integration package now publishes official CLI entrypoints for CommonJS and ESM so agents can invoke APTS through one stable shell command instead of generating ad-hoc wrapper scripts.',
      'CLI artifacts now declare the matching reference client artifact they depend on, so integrators keep both files together in the same workspace-local folder.'
    ]
  },
  {
    version: '2.0.8',
    date: '2026-04-28',
    changes: [
      'The public integration manifest now publishes explicit artifact_version metadata for scripts and agent templates.',
      'A new artifact synchronization policy now instructs local updaters to overwrite managed files on version change and remove known legacy filenames.'
    ]
  },
  {
    version: '2.0.7',
    date: '2026-04-28',
    changes: [
      'Batch mutating endpoints now support optional strict all-or-nothing execution via query parameter strict=true.',
      'When strict mode is enabled, batch mutations run in a single transaction and rollback entirely on the first failing item.'
    ]
  },
  {
    version: '2.0.6',
    date: '2026-04-28',
    changes: [
      'Agent API mutating endpoints now support batch payloads by accepting either a single JSON object or a non-empty JSON array of objects.',
      'Official integration clients and skills contract now support object-or-array payloads for batch operations, including dedicated batch routes for backlog/status/log/heartbeat updates.'
    ]
  },
  {
    version: '2.0.5',
    date: '2026-04-28',
    changes: [
      'Official integration clients now accept contract-first JSON object inputs for update_task_status, log_agent_progress, heartbeat, update_backlog_item, and delete_backlog_item while remaining backward compatible with previous positional signatures.',
      'Official integration guidance now defines an anti-loop retry policy that distinguishes non-retriable contract/auth/not-found errors from retriable network/rate-limit/server failures.'
    ]
  },
  {
    version: '2.0.4',
    date: '2026-04-28',
    changes: [
      'Integration guidance now recommends a workspace-local, runtime-neutral base folder at .ia/apts for APTS skills artifacts.',
      'Bootstrap instructions now explicitly recommend runtime-specific adapter paths only when needed (.github/skills/apts, .agents/skills/apts, .claude/skills/apts) and discourage user-global skill installation.'
    ]
  },
  {
    version: '2.0.3',
    date: '2026-04-27',
    changes: [
      'The public integration manifest bootstrap content is now fully in English for better LLM compatibility during agent onboarding.',
      'The public integration package and agent-facing guidance files were translated to English while preserving existing API route names.'
    ]
  },
  {
    version: '2.0.2',
    date: '2026-04-27',
    changes: [
      'Bootstrap manifest_updates.notes history was synchronized one time with the real repository commit chronology.',
      'Missing entries for versions 1.0.0, 1.1.0, and 1.2.0 were added to preserve full manifest traceability.'
    ]
  },
  {
    version: '2.0.1',
    date: '2026-04-27',
    changes: [
      'Integrators are explicitly instructed to define APTS_BASE_URL and APTS_API_KEY in a .env file at the client project root (or an equivalent secret store) (commit 45297ae).',
      'A variables example was added to reduce URL and API key discovery errors during bootstrap (commit 45297ae).'
    ]
  },
  {
    version: '2.0.0',
    date: '2026-04-27',
    changes: [
      'Agent templates published by the manifest were renamed to more descriptive functional names (commit c477837).',
      'Agent download routes changed to /agentes/orquestador-backlog-apts.agent.md and /agentes/ejecutor-item-backlog-dev-test-commit.agent.md without legacy aliases (commit c477837).'
    ]
  },
  {
    version: '1.9.0',
    date: '2026-04-27',
    changes: [
      'The agent API added structured validation with Zod for critical POST/PATCH payloads (commit f9d3f98).',
      'Mutating endpoints now return more consistent 400/404 errors for invalid types, out-of-contract enums, or invalid IDs (commit f9d3f98).'
    ]
  },
  {
    version: '1.8.0',
    date: '2026-04-27',
    changes: [
      'The official integration client (CommonJS and ESM) now covers backlog soft-delete and listing with include_deleted (commit 40efcc0).',
      'The skills contract was updated to include delete_backlog_item and needs_details backlog status support (commit 40efcc0).'
    ]
  },
  {
    version: '1.7.0',
    date: '2026-04-27',
    changes: [
      'Soft-delete support was added for backlog_items in the agent API (commits 3d90bb0 and 20163e9).',
      'Backlog listings now exclude deleted items by default and can include them with include_deleted=true (commits 3d90bb0 and 20163e9).'
    ]
  },
  {
    version: '1.6.0',
    date: '2026-04-25',
    changes: [
      'The orchestrator template was published as orquestador.agent.md for compatibility with custom agent detection in VS Code (commit f683262).',
      'That version also published a legacy route for older orquestador-agent.md downloads (removed in 2.0.0) (commit f683262).'
    ]
  },
  {
    version: '1.5.0',
    date: '2026-04-25',
    changes: [
      'The manifest now publishes separate HTTP clients for CommonJS and ESM (commit 92d170f).',
      'Each artifact declares when to use it based on the client Node.js module configuration (commit 92d170f).'
    ]
  },
  {
    version: '1.4.0',
    date: '2026-04-25',
    changes: [
      'bootstrap.manifest_updates was added to publish changes per manifest version (commit fc44071).',
      'The current manifest version is referenced in bootstrap.manifest_updates.current_version (commit fc44071).'
    ]
  },
  {
    version: '1.3.0',
    date: '2026-04-25',
    changes: [
      'Append-only local resilience log guidance was added, including the policy that it is not a source of truth (commit e612b89).',
      'Migration guidance from local tracking to APTS as the operational source of truth was reinforced (commit e612b89).'
    ]
  },
  {
    version: '1.2.0',
    date: '2026-04-25',
    changes: [
      'Explicit APTS_API_KEY bootstrap guidance for integrators was documented (commit ee2bdbf).',
      'Protected calls were clarified to require the secret before invoking authenticated skills (commit ee2bdbf).'
    ]
  },
  {
    version: '1.1.0',
    date: '2026-04-25',
    changes: [
      'Initial bootstrap guidance was added to the public integration manifest (commit 23ea8c4).',
      'Bootstrap publication under /api/public/integrar was consolidated for agent flows (commits 23ea8c4 and cc18a7d).'
    ]
  },
  {
    version: '1.0.0',
    date: '2026-04-25',
    changes: [
      'The agent integration manifest was published for the first time in APTS (commit 6bcac00).',
      'A public bootstrap entry endpoint without token was established for initial discovery (commit 6bcac00).'
    ]
  }
];

const validateIntegrationManifestReleaseHistory = (history, currentVersion) => {
  if (!Array.isArray(history) || history.length === 0) {
    throw new Error('integrationManifestReleaseNotes must be a non-empty array');
  }

  if (history.length < 2) {
    throw new Error('integrationManifestReleaseNotes must keep version history (not only the latest change)');
  }

  if (history[0]?.version !== currentVersion) {
    throw new Error('integrationManifestReleaseNotes[0].version must match integrationManifestSchemaVersion');
  }

  const uniqueVersions = new Set(history.map((entry) => entry.version));
  if (uniqueVersions.size !== history.length) {
    throw new Error('integrationManifestReleaseNotes cannot contain duplicated versions');
  }
};

validateIntegrationManifestReleaseHistory(integrationManifestReleaseNotes, integrationManifestSchemaVersion);

const integrationArtifacts = {
  skills_json: {
    route: `${publicIntegrationBasePath}/skills.json`,
    filePath: path.join(integrationRoot, 'paquete-apts', 'apts_skills.json'),
    fileName: 'apts_skills.json',
    contentType: 'application/json; charset=utf-8',
    artifactVersion: '2.0.35',
    updatedInSchemaVersion: '2.0.35',
    kind: 'skills_contract',
    recommended: true,
    syncAction: 'overwrite',
    deprecatedFilenames: [],
    description: 'Machine-readable tool contract for APTS integration.'
  },
  skill_markdown: {
    route: `${publicIntegrationBasePath}/skill.md`,
    filePath: path.join(integrationRoot, 'paquete-apts', 'SKILL.md'),
    fileName: 'SKILL.md',
    contentType: 'text/markdown; charset=utf-8',
    artifactVersion: '2.0.36',
    updatedInSchemaVersion: '2.0.36',
    kind: 'skill_package',
    recommended: false,
    syncAction: 'overwrite',
    deprecatedFilenames: [],
    description: 'Copilot skill packaging guide for APTS integration.'
  },
  agent_guidelines: {
    route: `${publicIntegrationBasePath}/agent-guidelines.md`,
    filePath: path.join(integrationRoot, 'paquete-apts', 'apts-agent-guidelines.md'),
    fileName: 'apts-agent-guidelines.md',
    contentType: 'text/markdown; charset=utf-8',
    artifactVersion: '2.0.36',
    updatedInSchemaVersion: '2.0.36',
    kind: 'agent_guidelines',
    recommended: true,
    syncAction: 'overwrite',
    deprecatedFilenames: [],
    description: 'Base operating rules for any agent that reports work to APTS.'
  },
  executor_agent: {
    route: `${publicIntegrationBasePath}/agentes/ejecutor-item-backlog-dev-test-commit.agent.md`,
    filePath: path.join(integrationRoot, 'plantillas-agentes', 'ejecutor-item-backlog-dev-test-commit.agent.md'),
    fileName: 'ejecutor-item-backlog-dev-test-commit.agent.md',
    contentType: 'text/markdown; charset=utf-8',
    artifactVersion: '2.0.33',
    updatedInSchemaVersion: '2.0.33',
    kind: 'agent_template',
    recommended: false,
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
    artifactVersion: '2.0.33',
    updatedInSchemaVersion: '2.0.33',
    kind: 'agent_template',
    recommended: false,
    syncAction: 'overwrite',
    deprecatedFilenames: [
      'orquestador.agent.md',
      'orquestador-agent.md'
    ],
    description: 'Orchestrator agent template that pulls ready backlog items from APTS.'
  },
  vscode_orchestrator_agent_adapter: {
    route: `${publicIntegrationBasePath}/agentes/vscode/apts-backlog-orchestrator.agent.md`,
    filePath: path.join(integrationRoot, 'paquete-apts', 'runtime-adapters', 'vscode', 'agents', 'apts-backlog-orchestrator.agent.md'),
    fileName: 'apts-backlog-orchestrator.agent.md',
    contentType: 'text/markdown; charset=utf-8',
    artifactVersion: '2.0.33',
    updatedInSchemaVersion: '2.0.33',
    kind: 'agent_runtime_adapter',
    recommended: true,
    syncAction: 'overwrite',
    deprecatedFilenames: [],
    runtime: 'vscode',
    discoveryPath: '.github/agents',
    requiredGlob: '*.agent.md',
    targetRelativePath: '.github/agents/apts-backlog-orchestrator.agent.md',
    canonicalSourceArtifactId: 'orchestrator_agent',
    invocationName: 'APTS Backlog Orchestrator',
    invocationAliases: ['Orquestador Backlog APTS'],
    description: 'VS Code discovery adapter for the APTS backlog orchestrator agent.'
  },
  vscode_executor_agent_adapter: {
    route: `${publicIntegrationBasePath}/agentes/vscode/backlog-item-executor-dev-test-commit.agent.md`,
    filePath: path.join(integrationRoot, 'paquete-apts', 'runtime-adapters', 'vscode', 'agents', 'backlog-item-executor-dev-test-commit.agent.md'),
    fileName: 'backlog-item-executor-dev-test-commit.agent.md',
    contentType: 'text/markdown; charset=utf-8',
    artifactVersion: '2.0.33',
    updatedInSchemaVersion: '2.0.33',
    kind: 'agent_runtime_adapter',
    recommended: true,
    syncAction: 'overwrite',
    deprecatedFilenames: [],
    runtime: 'vscode',
    discoveryPath: '.github/agents',
    requiredGlob: '*.agent.md',
    targetRelativePath: '.github/agents/backlog-item-executor-dev-test-commit.agent.md',
    canonicalSourceArtifactId: 'executor_agent',
    invocationName: 'Backlog Item Executor Dev Test Commit',
    invocationAliases: ['Ejecutor Item Backlog Dev Test Commit'],
    description: 'VS Code discovery adapter for the backlog item worker agent.'
  },
  js_client_commonjs: {
    route: `${publicIntegrationBasePath}/apts-client.js`,
    filePath: path.join(integrationRoot, 'paquete-apts', 'apts-client.js'),
    fileName: 'apts-client.js',
    contentType: 'application/javascript; charset=utf-8',
    artifactVersion: '2.0.26',
    updatedInSchemaVersion: '2.0.26',
    kind: 'reference_client',
    recommended: false,
    optional: true,
    syncAction: 'overwrite',
    deprecatedFilenames: [],
    module_system: 'commonjs',
    selection_rule: 'Use this file when the client project runs Node.js in CommonJS mode, typically with require(...) and without type=module in package.json.',
    description: 'Optional JavaScript HTTP client for CommonJS runtimes.'
  },
  js_client_esm: {
    route: `${publicIntegrationBasePath}/apts-client.mjs`,
    filePath: path.join(integrationRoot, 'paquete-apts', 'apts-client.mjs'),
    fileName: 'apts-client.mjs',
    contentType: 'application/javascript; charset=utf-8',
    artifactVersion: '2.0.26',
    updatedInSchemaVersion: '2.0.26',
    kind: 'reference_client',
    recommended: false,
    optional: true,
    syncAction: 'overwrite',
    deprecatedFilenames: [],
    module_system: 'esm',
    selection_rule: 'Use this file when the client project runs Node.js in ESM mode, typically with import/export or type=module in package.json.',
    description: 'Optional JavaScript HTTP client for ESM runtimes.'
  },
  js_cli_commonjs: {
    route: `${publicIntegrationBasePath}/apts-cli.js`,
    filePath: path.join(integrationRoot, 'paquete-apts', 'apts-cli.js'),
    fileName: 'apts-cli.js',
    contentType: 'application/javascript; charset=utf-8',
    artifactVersion: '2.0.26',
    updatedInSchemaVersion: '2.0.26',
    kind: 'reference_cli',
    recommended: false,
    optional: true,
    syncAction: 'overwrite',
    deprecatedFilenames: [],
    dependsOnArtifactIds: ['js_client_commonjs'],
    module_system: 'commonjs',
    selection_rule: 'Use this file when the runtime prefers shellable Node.js commands over direct module imports and the client project runs in CommonJS mode. Keep it in the same folder as apts-client.js.',
    description: 'Optional CommonJS CLI wrapper over the official APTS client.'
  },
  js_cli_esm: {
    route: `${publicIntegrationBasePath}/apts-cli.mjs`,
    filePath: path.join(integrationRoot, 'paquete-apts', 'apts-cli.mjs'),
    fileName: 'apts-cli.mjs',
    contentType: 'application/javascript; charset=utf-8',
    artifactVersion: '2.0.26',
    updatedInSchemaVersion: '2.0.26',
    kind: 'reference_cli',
    recommended: false,
    optional: true,
    syncAction: 'overwrite',
    deprecatedFilenames: [],
    dependsOnArtifactIds: ['js_client_esm'],
    module_system: 'esm',
    selection_rule: 'Use this file when the runtime prefers shellable Node.js commands over direct module imports and the client project runs in ESM mode. Keep it in the same folder as apts-client.mjs.',
    description: 'Optional ESM CLI wrapper over the official APTS client.'
  }
};

const buildAbsoluteUrl = (req, route) => `${req.protocol}://${req.get('host')}${route}`;

const buildLegacyCleanupTargets = () => Object.entries(integrationArtifacts)
  .flatMap(([id, artifact]) => (artifact.deprecatedFilenames || []).map((fileName) => ({
    artifact_id: id,
    file_name: fileName
  })));

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
        history_mode: 'append_only',
        current_version: integrationManifestSchemaVersion,
        latest_note: integrationManifestReleaseNotes[0],
        notes: integrationManifestReleaseNotes
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
        new_item_policy: 'If no matching bug item exists, create one in APTS before implementation starts and capture the symptom, expected behavior, observed behavior, and any reproduction evidence available from the chat.',
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
      client_download_guidance: {
        decision_input: 'Review the client Node.js module configuration before downloading the HTTP client.',
        choose_commonjs_when: [
          'the project uses require(...)',
          'package.json does not declare type=module',
          'the runtime expects .js files treated as CommonJS modules'
        ],
        choose_esm_when: [
          'the project uses import/export',
          'package.json declares type=module',
          'the runtime expects .mjs files or ESM modules'
        ],
        choose_cli_when: [
          'the runtime can invoke shell commands more easily than loading JavaScript modules directly',
          'you want one stable entrypoint instead of generating ad-hoc wrapper scripts around the APTS client',
          'the matching reference client artifact is available in the same local folder as the CLI'
        ],
        cli_dependency_rule: 'apts-cli.js depends on apts-client.js and apts-cli.mjs depends on apts-client.mjs. Keep each CLI and its matching client artifact together in the same workspace-local folder.',
        official_script_integrity_rule: 'For base APTS operations, use only official scripts published by this manifest (apts-client.js, apts-client.mjs, apts-cli.js, or apts-cli.mjs). Do not merge legacy wrapper snippets into those files.',
        adapter_exception_rule: 'If runtime-specific glue is still needed, keep it as a thin adapter that delegates to the official script unchanged.',
        legacy_wrapper_cleanup_rule: 'After installing the official client or CLI, remove older project-local scripts that only wrapped base APTS operations such as register_task, read_project_context, update_task_status, log_agent_progress, report_blocker, or heartbeat. Keep only thin runtime-specific adapters when discovery requires them.',
        default_rule: 'If in doubt, inspect package.json and the client project code before choosing an artifact. Download the CLI only together with the matching client artifact.'
      },
      powershell_cli_safety: {
        applies_to: ['apts-cli.js', 'apts-cli.mjs'],
        mandatory_field_reminders: {
          update_backlog_item: 'Use backlog_item_id in payloads. Do not send id for update-backlog-item or delete-backlog-item operations.',
          update_payload_shape: 'Use one JSON object for single update calls, or a non-empty JSON array for batch calls.'
        },
        common_failure_modes: [
          'Inline escaped JSON in PowerShell can be split into extra arguments when quoting is inconsistent.',
          'Single-line here-string declarations are invalid and trigger parser errors.',
          'stdin-based calls can appear hung if the input stream remains open or no JSON payload is piped.'
        ],
        recommended_execution_pattern: [
          'Validate command semantics first with a minimal payload (for example status-only update) before sending long acceptance_criteria text.',
          'When payload content is large or includes special characters, write JSON to a temporary file and pipe it with Get-Content ... | node ... --stdin.',
          'If a stdin flow appears stuck, retry with a short --json payload to verify command response before reattempting the full payload.',
          'Apply multi-step updates for high-risk text: first minimal field update, then full content update after the first call succeeds.'
        ],
        post_write_verification: 'After mutating calls, read backlog/task state and confirm persisted fields match expected values instead of relying only on process exit success.'
      },
      artifact_sync_policy: {
        source_of_truth: 'manifest_artifacts',
        compare_strategy: 'by_artifact_id_and_artifact_version',
        when_version_changes: 'overwrite_local_file',
        delete_known_legacy_files: true,
        runtime_filtering_required_before_recommended: true,
        runtime_filtering_rule: 'Before applying recommended artifacts, keep only entries where runtime is null or equals the active runtime. Then apply recommended=true on that filtered set.',
        runtime_filter_query_param: 'runtime',
        legacy_cleanup_targets: buildLegacyCleanupTargets(),
        managed_artifact_integrity: 'Treat downloaded official APTS scripts as managed artifacts. Do not hand-edit them or splice legacy wrapper code into them; replace the full file when artifact_version changes.',
        manual_cleanup_note: 'Automatic cleanup only applies to filenames explicitly published by APTS in legacy_cleanup_targets. If the client project previously created custom APTS wrapper scripts for base operations, remove them manually during migration unless APTS later publishes those filenames as deprecated.',
        updater_contract: [
          'For each manifest artifact id, compare local metadata with artifact_version from this manifest.',
          'If local version differs from artifact_version, re-download and overwrite the local managed file.',
          'Never compose mixed scripts by merging legacy local wrappers with downloaded official APTS artifacts.',
          'If delete_known_legacy_files is true, remove local files listed under legacy_cleanup_targets before finishing sync.'
        ]
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
        validation_checklist: [
          'Confirm orchestrator and executor adapters exist in .github/agents.',
          'Validate YAML frontmatter for each adapter and ensure name is present and unique.',
          'Reload VS Code window so the runtime reindexes custom agents.'
        ]
      },
      agent_runtime_adapters: {
        required_for_custom_agents: true,
        installation_state_policy: 'If the runtime is VS Code and required adapters are missing in .github/agents, custom-agent installation is incomplete.',
        mappings: [
          {
            runtime: 'vscode',
            canonical_artifact_id: 'orchestrator_agent',
            adapter_artifact_id: 'vscode_orchestrator_agent_adapter',
            target_relative_path: '.github/agents/apts-backlog-orchestrator.agent.md',
            invocation_name: 'APTS Backlog Orchestrator',
            invocation_aliases: ['Orquestador Backlog APTS']
          },
          {
            runtime: 'vscode',
            canonical_artifact_id: 'executor_agent',
            adapter_artifact_id: 'vscode_executor_agent_adapter',
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
      official_integration_script_policy: {
        required: true,
        scope: 'base_apts_contract_operations',
        allowed_artifact_ids: ['js_client_commonjs', 'js_client_esm', 'js_cli_commonjs', 'js_cli_esm'],
        single_source_of_truth: 'For base integration operations, invoke only official scripts published by APTS in this manifest.',
        mixed_script_forbidden: 'Do not merge, splice, or partially reuse legacy local wrapper code inside downloaded official scripts.',
        migration_rule: 'If legacy wrappers still contain project-specific logic, extract that logic into a thin adapter and keep official scripts unchanged.'
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
        'Use official client/CLI with minimal payloads first; avoid manual Git identity discovery unless a required-field error forces protocol debugging.',
        'If APTS_API_KEY is not yet present in the environment, request APTS_API_KEY from the operator and confirm APTS_BASE_URL as well.',
        'Create or update a .env file at the client project root with APTS_BASE_URL and APTS_API_KEY before using protected APIs.',
        'Ensure the project has AGENTS.md or .github/copilot-instructions.md. Create AGENTS.md from apts-agent-guidelines.md if neither file exists, or merge/update one APTS-managed section if an instruction file already exists.',
        'Create a workspace-local integration folder such as .ia/apts, place the APTS contract and HTTP client there, and only then wire runtime-specific adapters if needed.',
        'If the runtime is VS Code and custom agents are required, install runtime adapters in .github/agents before backlog execution and reload the editor window after sync.',
        'Treat interrupted execution as resumable work: call register_task with backlog_item_id so APTS can resume existing stalled/todo/in_progress tasks for that backlog item instead of creating duplicates.',
        'Do not merge legacy local wrappers into official APTS scripts; keep official scripts unchanged and move extra project logic to thin adapters when needed.',
        'If the project previously used ad-hoc APTS wrapper scripts for base operations, remove them once the official client or CLI is installed and keep only thin discovery adapters when the runtime still needs them.',
        'Prepare a local append-only resilience journal, for example at .apts/agent-resilience-log.jsonl, without treating it as a source of truth.',
        'Inspect local files that currently contain backlog, planning, or operational tracking.',
        'If the current chat request is a new bugfix, error investigation, or regression report, run search_similar_bug_reports and inspect APTS backlog for a matching bug item before creating a new item_type=bug.',
        'If the current chat request asks to report a solved defect, update the tracked bug item status to review or done and include resolution evidence.',
        'Create or update backlog_items in APTS to reflect that initial state.',
        'From that point onward, use APTS as the primary tracking system and do not invent work outside APTS.'
      ],
      operator_prompt_template: 'Read this public manifest, understand that APTS is the tracking source of truth, request APTS_BASE_URL and APTS_API_KEY from the operator if missing, store them in a .env file at the client project root (or equivalent secret store), prepare a local append-only resilience journal, and if the current user request is a new bug, error, or regression from chat, first ensure there is a corresponding APTS backlog item with item_type=bug before implementation starts.'
    },
    entrypoint: buildAbsoluteUrl(req, publicIntegrationBasePath),
    api_base_url: buildAbsoluteUrl(req, '/api'),
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
      'Store APTS_BASE_URL and APTS_API_KEY in a .env file at the root of the client project, or in an equivalent project secret store.',
      'Install APTS integration artifacts in a workspace-local base folder such as .ia/apts.',
      'When consuming manifest artifacts, filter by runtime first (runtime query param or client-side equivalent), then apply recommended entries from that compatible subset.',
      'Use runtime-specific adapter paths only when needed for discovery (.github/skills/apts, .agents/skills/apts, or .claude/skills/apts), and avoid user-global skill installation.',
      'If using VS Code custom agents, install the published agent runtime adapters into .github/agents and reload the window so those agents become discoverable.',
      'Maintain the local resilience log described in the bootstrap section; it is append-only and must not replace APTS as the source of truth.',
      'Download and install the skills contract first.',
      'Read the base agent guidelines before the first APTS API call.',
      'Ensure AGENTS.md or .github/copilot-instructions.md exists before protected calls: create AGENTS.md if neither exists, or merge/update one APTS-managed section if an instruction file already exists.',
      'If the current chat introduces a new bug, error, or regression request, ensure it is represented in APTS backlog as a bug item before registering execution work or starting implementation.',
      'If the current chat asks to report a solved bug, update the tracked bug backlog item and add resolution details with verification evidence.',
      'If the runtime is VS Code on Windows, route tests through WSL terminals/tasks and route non-test operations through PowerShell terminals/tasks.',
      'Choose the reference client that matches the client project module system: apts-client.js for CommonJS or apts-client.mjs for ESM.',
      'If the runtime prefers shellable command entrypoints over importing JavaScript modules, download the matching CLI as well: apts-cli.js for CommonJS or apts-cli.mjs for ESM, keeping it beside the matching client file.',
      'Do not run manual identity pre-flight commands by default; let official client/CLI auto-fill protocol fields and inspect execution context only when a call reports missing required data.',
      'Official APTS client/CLI auto-fills missing identity fields from environment variables first, local managed execution context second, and local Git as fallback; provide explicit identity fields only when raw API calls are used.',
      'Official client/CLI persist managed execution context in .apts/execution-context.json by default (override with APTS_CONTEXT_FILE) so repeated execution calls can omit task_id and identity fields.',
      'Use register_task with backlog_item_id to resume interrupted work for that backlog item before creating additional execution tasks.',
      'Do not force task status done for interrupted executions: pass through review first and ensure recent heartbeat or progress logs exist before closing as done.',
      'For base APTS operations, use only official scripts published by this manifest and never merge legacy wrapper code into downloaded managed scripts.',
      'After installing the official client or CLI, remove older local APTS wrapper scripts for base operations to avoid drift. Keep only thin runtime-specific discovery adapters when required.',
      'Download the optional agent templates only if your runtime supports custom agents.',
      'Use APTS_BASE_URL with the published /api base path.'
    ],
    identity_requirements: [
      { field: 'project_url', resolve_with: 'APTS_PROJECT_URL, managed execution context, or git remote get-url origin' },
      { field: 'agent_name', resolve_with: 'APTS_AGENT_NAME, managed execution context, or git config user.name' },
      { field: 'agent_email', resolve_with: 'APTS_AGENT_EMAIL, managed execution context, or git config user.email' },
      { field: 'branch', resolve_with: 'APTS_BRANCH, managed execution context, or git branch --show-current' },
      { field: 'task_id', resolve_with: 'APTS_TASK_ID or managed execution context (for repeated execution calls)' }
    ],
    artifacts: Object.entries(integrationArtifacts).map(([id, artifact]) => ({
      runtime_compatible: isArtifactRuntimeCompatible(artifact, activeRuntime),
      id,
      kind: artifact.kind,
      artifact_version: artifact.artifactVersion,
      updated_in_schema_version: artifact.updatedInSchemaVersion,
      sync_action: artifact.syncAction,
      deprecated_filenames: artifact.deprecatedFilenames || [],
      description: artifact.description,
      recommended: artifact.recommended && isArtifactRuntimeCompatible(artifact, activeRuntime),
      recommended_unfiltered: artifact.recommended,
      optional: artifact.optional || false,
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
app.get(`${publicIntegrationBasePath}/agentes/ejecutor-item-backlog-dev-test-commit.agent.md`, async (req, res) => sendIntegrationArtifact(req, res, 'executor_agent'));
app.get(`${publicIntegrationBasePath}/agentes/orquestador-backlog-apts.agent.md`, async (req, res) => sendIntegrationArtifact(req, res, 'orchestrator_agent'));
app.get(`${publicIntegrationBasePath}/agentes/vscode/apts-backlog-orchestrator.agent.md`, async (req, res) => sendIntegrationArtifact(req, res, 'vscode_orchestrator_agent_adapter'));
app.get(`${publicIntegrationBasePath}/agentes/vscode/backlog-item-executor-dev-test-commit.agent.md`, async (req, res) => sendIntegrationArtifact(req, res, 'vscode_executor_agent_adapter'));
app.get(`${publicIntegrationBasePath}/apts-client.js`, async (req, res) => sendIntegrationArtifact(req, res, 'js_client_commonjs'));
app.get(`${publicIntegrationBasePath}/apts-client.mjs`, async (req, res) => sendIntegrationArtifact(req, res, 'js_client_esm'));
app.get(`${publicIntegrationBasePath}/apts-cli.js`, async (req, res) => sendIntegrationArtifact(req, res, 'js_cli_commonjs'));
app.get(`${publicIntegrationBasePath}/apts-cli.mjs`, async (req, res) => sendIntegrationArtifact(req, res, 'js_cli_esm'));

// --- AGENT API (SKILLS) ---

const notifyWebhook = async (project_url, payload) => {
  try {
    const project = await db('projects').where({ url: project_url }).first();
    if (project && project.webhook_url) {
      await fetch(project.webhook_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
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

// Skill 0: register_task
app.post('/api/projects/tasks', apiLimiter, authenticateAgent, async (req, res) => {
  const { isBatch, items, error } = normalizeBatchRequestBody(req.body);
  if (error) {
    return res.status(400).json({ error });
  }
  const useStrictBatchMode = shouldUseStrictBatchMode(req, isBatch);

  const parsedItems = [];
  for (let index = 0; index < items.length; index += 1) {
    const parsedBody = registerTaskBodySchema.safeParse(items[index] || {});
    if (!parsedBody.success) {
      return res.status(400).json({ error: `Invalid payload at index ${index}: ${zodErrorMessage(parsedBody.error)}` });
    }
    parsedItems.push(parsedBody.data);
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
    const url = normalizeUrl(req.query.url);
    const view = validateResponseView(req.query.view);
    const includeSections = parseProjectContextInclude(req.query.include);
    const limit = parseOptionalNonNegativeInteger(req.query.limit, 'limit', { max: MAX_TASK_DETAIL_LOG_LIMIT }) ?? 5;
    const backlogStatus = normalizeInputString(req.query.backlog_status, { unwrapQuotes: true, lowercase: true }) || null;

    if (!url) {
      return res.status(400).json({ error: 'Project url is required' });
    }

    if (backlogStatus && !BACKLOG_STATUSES.includes(backlogStatus)) {
      return res.status(400).json({ error: 'Invalid backlog status' });
    }

    const responsePayload = {};

    if (includeSections.has('tasks')) {
      const tasksQuery = db('tasks').where({ project_url: url });
      const tasks = (view === 'compact'
        ? await tasksQuery.select(TASK_COMPACT_SELECT_COLUMNS)
        : await tasksQuery.select('*'))
        .map((task) => mapTaskRecord(task, { view }));
      responsePayload.tasks = tasks;
    }

    if (includeSections.has('backlog')) {
      const backlog = await listBacklogItems(url, backlogStatus, { view });
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

    return res.json(responsePayload);
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
    const url = normalizeUrl(req.query.url);
    const status = normalizeInputString(req.query.status, { unwrapQuotes: true, lowercase: true }) || null;
    const includeDeleted = parseBooleanFlag(req.query.include_deleted);
    const view = validateResponseView(req.query.view);
    const id = normalizeInputString(req.query.id, { unwrapQuotes: true }) || null;
    const ids = parseCommaSeparatedUuidList(req.query.ids, 'ids');
    const limit = parseOptionalNonNegativeInteger(req.query.limit, 'limit');
    const offset = parseOptionalNonNegativeInteger(req.query.offset, 'offset');

    if (!url) {
      return res.status(400).json({ error: 'Project url is required' });
    }

    if (status && !BACKLOG_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Invalid backlog status' });
    }

    if (id && !isUuid(id)) {
      return res.status(400).json({ error: 'id must be a valid UUID' });
    }

    if (id && ids.length > 0) {
      return res.status(400).json({ error: 'Use either id or ids, not both' });
    }

    const backlog = await listBacklogItems(url, status, {
      includeDeleted,
      view,
      id,
      ids,
      limit,
      offset
    });
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

  const {
    url,
    query_text: queryText,
    top_k: requestedTopK,
    threshold: requestedThreshold,
    include_closed: includeClosed,
    exclude_backlog_item_id: excludeBacklogItemId
  } = parsedBody.data;

  const topK = Math.max(1, Math.min(MAX_SEMANTIC_SEARCH_TOP_K, requestedTopK ?? DEFAULT_SEMANTIC_SEARCH_TOP_K));
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

    return res.json({
      query: {
        url: normalizeUrl(url),
        query_text: queryText,
        top_k: topK,
        threshold,
        include_closed: includeClosed === true,
        exclude_backlog_item_id: excludeBacklogItemId || null
      },
      ...result
    });
  } catch (routeError) {
    return sendApiError(res, normalizeSemanticError(routeError, {
      unavailableMessage: 'Semantic bug search is temporarily unavailable',
      internalMessage: 'Semantic bug search failed',
      unavailableCode: 'SEMANTIC_BUG_SEARCH_UNAVAILABLE',
      internalCode: 'SEMANTIC_BUG_SEARCH_FAILED'
    }), {
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
    const view = validateResponseView(req.query.view || 'full');
    const includeDeleted = parseBooleanFlag(req.query.include_deleted);

    const backlogItemQuery = db('backlog_items').where({ id: parsedParams.data.id });
    if (!includeDeleted) {
      backlogItemQuery.whereNull('deleted_at');
    }

    const backlogItem = view === 'compact'
      ? await backlogItemQuery.select(BACKLOG_COMPACT_SELECT_COLUMNS).first()
      : await backlogItemQuery.select('*').first();

    if (!backlogItem) {
      return res.status(404).json({ error: 'Backlog item not found' });
    }

    return res.json({ backlog_item: mapBacklogItemRecord(backlogItem, { view }) });
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

  const normalizedItems = [];
  for (let index = 0; index < items.length; index += 1) {
    const rawItem = items[index] || {};
    const parsedBacklogId = backlogIdBodySchema.safeParse(rawItem);
    if (!parsedBacklogId.success) {
      return res.status(400).json({ error: `Invalid payload at index ${index}: ${zodErrorMessage(parsedBacklogId.error)}` });
    }

    normalizedItems.push({
      backlog_item_id: parsedBacklogId.data.backlog_item_id,
      body: rawItem
    });
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

  const normalizedItems = [];
  for (let index = 0; index < items.length; index += 1) {
    const parsedBacklogId = backlogIdBodySchema.safeParse(items[index] || {});
    if (!parsedBacklogId.success) {
      return res.status(400).json({ error: `Invalid payload at index ${index}: ${zodErrorMessage(parsedBacklogId.error)}` });
    }
    normalizedItems.push(parsedBacklogId.data.backlog_item_id);
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

app.get('/api/tasks/:id', apiLimiter, authenticateAgent, async (req, res) => {
  const parsedParams = taskIdParamSchema.safeParse(req.params || {});
  if (!parsedParams.success) {
    return res.status(400).json({ error: zodErrorMessage(parsedParams.error) });
  }

  try {
    const view = validateResponseView(req.query.view || 'full');
    const logsLimit = parseOptionalNonNegativeInteger(req.query.limit, 'limit', { max: MAX_TASK_DETAIL_LOG_LIMIT })
      ?? DEFAULT_TASK_DETAIL_LOG_LIMIT;
    const taskId = parsedParams.data.id;

    const taskQuery = db('tasks').where({ id: taskId });
    const task = view === 'compact'
      ? await taskQuery.select(TASK_COMPACT_SELECT_COLUMNS).first()
      : await taskQuery.select('*').first();

    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
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

    return res.json({
      task: mapTaskRecord(task, { view }),
      recent_heartbeats: recentHeartbeats,
      logs
    });
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

  const parsedItems = [];
  for (let index = 0; index < items.length; index += 1) {
    const parsedBody = taskStatusUpdateBatchBodySchema.safeParse(items[index] || {});
    if (!parsedBody.success) {
      return res.status(400).json({ error: `Invalid payload at index ${index}: ${zodErrorMessage(parsedBody.error)}` });
    }
    parsedItems.push(parsedBody.data);
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

  const parsedItems = [];
  for (let index = 0; index < items.length; index += 1) {
    const parsedBody = logAgentProgressBatchBodySchema.safeParse(items[index] || {});
    if (!parsedBody.success) {
      return res.status(400).json({ error: `Invalid payload at index ${index}: ${zodErrorMessage(parsedBody.error)}` });
    }
    parsedItems.push(parsedBody.data);
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

  const parsedItems = [];
  for (let index = 0; index < items.length; index += 1) {
    const parsedBody = reportBlockerBodySchema.safeParse(items[index] || {});
    if (!parsedBody.success) {
      return res.status(400).json({ error: `Invalid payload at index ${index}: ${zodErrorMessage(parsedBody.error)}` });
    }
    parsedItems.push(parsedBody.data);
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

  const parsedItems = [];
  for (let index = 0; index < items.length; index += 1) {
    const parsedBody = heartbeatBatchBodySchema.safeParse(items[index] || {});
    if (!parsedBody.success) {
      return res.status(400).json({ error: `Invalid payload at index ${index}: ${zodErrorMessage(parsedBody.error)}` });
    }
    parsedItems.push(parsedBody.data);
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

const startServer = async () => {
  try {
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

