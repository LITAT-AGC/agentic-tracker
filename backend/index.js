require('dotenv').config();
const fs = require('node:fs/promises');
const path = require('node:path');
const express = require('express');
const cors = require('cors');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const pino = require('pino');
const pinoHttp = require('pino-http');
const { z } = require('zod');
const knexConfig = require('./knexfile');
const rootPackage = require('../package.json');
const db = require('knex')(knexConfig[process.env.NODE_ENV || 'development']);

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
const DEFAULT_OPENROUTER_MODEL = process.env.OPENROUTER_DEFAULT_MODEL || 'google/gemini-2.0-flash-lite-001';
const CONFIG_KEYS = {
  openrouterModel: 'openrouter_model'
};
const AUTO_TRIAGE_BACKLOG_STATUSES = new Set(['draft', 'needs_details', 'ready']);
const MAX_BATCH_SIZE = 100;

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

const isUuid = (value) => typeof value === 'string' && UUID_REGEX.test(value);

const normalizeSchemaInputString = (value, options = {}) => {
  if (typeof value !== 'string') return value;
  return normalizeInputString(value, options);
};

const zodErrorMessage = (validationError) => validationError.issues?.[0]?.message || 'Invalid request payload';

const createHttpError = (statusCode, message) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
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

const mapBacklogItemRecord = (item) => {
  if (!item) return item;

  return {
    ...item,
    llm_missing_details: parseJsonArray(item.llm_missing_details),
    llm_confidence: toNumberOrNull(item.llm_confidence)
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

const listBacklogItems = async (projectUrl, status, { includeDeleted = false } = {}) => {
  const query = db('backlog_items')
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

  const items = await query.select('*');
  return items.map(mapBacklogItemRecord);
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
const integrationManifestSchemaVersion = '2.0.15';
const publicIntegrationBasePath = '/api/public/integrar';
// Append-only history: never replace older versions with only the latest entry.
const integrationManifestReleaseNotes = [
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
    artifactVersion: '2.0.15',
    updatedInSchemaVersion: '2.0.15',
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
    artifactVersion: '2.0.15',
    updatedInSchemaVersion: '2.0.15',
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
    artifactVersion: '2.0.15',
    updatedInSchemaVersion: '2.0.15',
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
    artifactVersion: '2.0.15',
    updatedInSchemaVersion: '2.0.15',
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
    artifactVersion: '2.0.15',
    updatedInSchemaVersion: '2.0.15',
    kind: 'agent_template',
    recommended: false,
    syncAction: 'overwrite',
    deprecatedFilenames: [
      'orquestador.agent.md',
      'orquestador-agent.md'
    ],
    description: 'Orchestrator agent template that pulls ready backlog items from APTS.'
  },
  bugfix_intake_agent: {
    route: `${publicIntegrationBasePath}/agentes/intake-bugfix-apts.agent.md`,
    filePath: path.join(integrationRoot, 'plantillas-agentes', 'intake-bugfix-apts.agent.md'),
    fileName: 'intake-bugfix-apts.agent.md',
    contentType: 'text/markdown; charset=utf-8',
    artifactVersion: '2.0.12',
    updatedInSchemaVersion: '2.0.12',
    kind: 'agent_template',
    recommended: false,
    syncAction: 'overwrite',
    deprecatedFilenames: [],
    description: 'Bug intake agent template that creates or reuses a tracked APTS bug item before implementation starts.'
  },
  js_client_commonjs: {
    route: `${publicIntegrationBasePath}/apts-client.js`,
    filePath: path.join(integrationRoot, 'paquete-apts', 'apts-client.js'),
    fileName: 'apts-client.js',
    contentType: 'application/javascript; charset=utf-8',
    artifactVersion: '2.0.7',
    updatedInSchemaVersion: '2.0.7',
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
    artifactVersion: '2.0.7',
    updatedInSchemaVersion: '2.0.7',
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
    artifactVersion: '2.0.9',
    updatedInSchemaVersion: '2.0.9',
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
    artifactVersion: '2.0.9',
    updatedInSchemaVersion: '2.0.9',
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

const buildIntegrationManifest = (req) => ({
  service: 'APTS',
  version: rootPackage.version,
  schema_version: integrationManifestSchemaVersion,
  integration_mode: 'agent',
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
      bugfix_intake_required: true,
      recommended_agent_entrypoint: 'APTS Bugfix Intake',
      detect_as_bugfix_when_request_mentions: [
        'bug fixes',
        'errors or exceptions',
        'failing behavior caused by an existing defect',
        'regressions',
        'incidents where existing functionality is broken'
      ],
      required_backlog_item_type: 'bug',
      existing_item_policy: 'Before creating a new defect entry, inspect APTS backlog and reuse an existing non-deleted bug item when it already tracks the same symptom, scope, or failure.',
      new_item_policy: 'If no matching bug item exists, create one in APTS before implementation starts and capture the symptom, expected behavior, observed behavior, and any reproduction evidence available from the chat.',
      task_link_policy: 'Only register or continue execution work after the task can reference that backlog_item_id.',
      source_tracking: {
        source_kind: 'chat_request',
        source_ref_rule: 'Persist a stable conversation or thread identifier in source_ref when the runtime exposes one; otherwise omit source_ref.'
      },
      custom_agent_policy: 'If the client runtime supports custom agents and APTS Bugfix Intake is installed, invoke it first for new defect requests from chat. Otherwise follow the same backlog-first policy manually.',
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
    artifact_sync_policy: {
      source_of_truth: 'manifest_artifacts',
      compare_strategy: 'by_artifact_id_and_artifact_version',
      when_version_changes: 'overwrite_local_file',
      delete_known_legacy_files: true,
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
      'Resolve project and agent identity from local Git.',
      'If APTS_API_KEY is not yet present in the environment, request APTS_API_KEY from the operator and confirm APTS_BASE_URL as well.',
      'Create or update a .env file at the client project root with APTS_BASE_URL and APTS_API_KEY before using protected APIs.',
      'Ensure the project has AGENTS.md or .github/copilot-instructions.md. Create AGENTS.md from apts-agent-guidelines.md if neither file exists, or merge/update one APTS-managed section if an instruction file already exists.',
      'Create a workspace-local integration folder such as .ia/apts, place the APTS contract and HTTP client there, and only then wire runtime-specific adapters if needed.',
      'Treat interrupted execution as resumable work: call register_task with backlog_item_id so APTS can resume existing stalled/todo/in_progress tasks for that backlog item instead of creating duplicates.',
      'Do not merge legacy local wrappers into official APTS scripts; keep official scripts unchanged and move extra project logic to thin adapters when needed.',
      'If the project previously used ad-hoc APTS wrapper scripts for base operations, remove them once the official client or CLI is installed and keep only thin discovery adapters when the runtime still needs them.',
      'Prepare a local append-only resilience journal, for example at .apts/agent-resilience-log.jsonl, without treating it as a source of truth.',
      'Inspect local files that currently contain backlog, planning, or operational tracking.',
      'If the current chat request is a new bugfix, error investigation, or regression report, inspect APTS backlog for a matching bug item or create one with item_type=bug before implementation starts.',
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
    'Use runtime-specific adapter paths only when needed for discovery (.github/skills/apts, .agents/skills/apts, or .claude/skills/apts), and avoid user-global skill installation.',
    'Maintain the local resilience log described in the bootstrap section; it is append-only and must not replace APTS as the source of truth.',
    'Download and install the skills contract first.',
    'Read the base agent guidelines before the first APTS API call.',
    'Ensure AGENTS.md or .github/copilot-instructions.md exists before protected calls: create AGENTS.md if neither exists, or merge/update one APTS-managed section if an instruction file already exists.',
    'If the current chat introduces a new bug, error, or regression request, ensure it is represented in APTS backlog as a bug item before registering execution work or starting implementation.',
    'If the runtime supports custom agents, install and use APTS Bugfix Intake as the first entrypoint for chat-triggered defect intake.',
    'Choose the reference client that matches the client project module system: apts-client.js for CommonJS or apts-client.mjs for ESM.',
    'If the runtime prefers shellable command entrypoints over importing JavaScript modules, download the matching CLI as well: apts-cli.js for CommonJS or apts-cli.mjs for ESM, keeping it beside the matching client file.',
    'Use register_task with backlog_item_id to resume interrupted work for that backlog item before creating additional execution tasks.',
    'Do not force task status done for interrupted executions: pass through review first and ensure recent heartbeat or progress logs exist before closing as done.',
    'For base APTS operations, use only official scripts published by this manifest and never merge legacy wrapper code into downloaded managed scripts.',
    'After installing the official client or CLI, remove older local APTS wrapper scripts for base operations to avoid drift. Keep only thin runtime-specific discovery adapters when required.',
    'Download the optional agent templates only if your runtime supports custom agents.',
    'Use APTS_BASE_URL with the published /api base path.'
  ],
  identity_requirements: [
    { field: 'project_url', resolve_with: 'git remote get-url origin' },
    { field: 'agent_name', resolve_with: 'git config user.name' },
    { field: 'agent_email', resolve_with: 'git config user.email' },
    { field: 'branch', resolve_with: 'git branch --show-current' }
  ],
  artifacts: Object.entries(integrationArtifacts).map(([id, artifact]) => ({
    id,
    kind: artifact.kind,
    artifact_version: artifact.artifactVersion,
    updated_in_schema_version: artifact.updatedInSchemaVersion,
    sync_action: artifact.syncAction,
    deprecated_filenames: artifact.deprecatedFilenames || [],
    description: artifact.description,
    recommended: artifact.recommended,
    optional: artifact.optional || false,
    module_system: artifact.module_system || null,
    selection_rule: artifact.selection_rule || null,
    depends_on_artifact_ids: artifact.dependsOnArtifactIds || [],
    media_type: artifact.contentType,
    url: buildAbsoluteUrl(req, artifact.route),
    download_url: `${buildAbsoluteUrl(req, artifact.route)}?download=1`
  }))
});

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
    return res.status(500).json({ error: `Unable to read integration artifact: ${error.message}` });
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
app.get(`${publicIntegrationBasePath}/agentes/intake-bugfix-apts.agent.md`, async (req, res) => sendIntegrationArtifact(req, res, 'bugfix_intake_agent'));
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
      }).catch(err => console.error('[Webhook Error]', err.message));
    }
  } catch (error) {
    console.error('[Webhook DB Error]', error.message);
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

        return {
          task_id: activeTask.id,
          status: 'in_progress',
          backlog_item_id: backlogItemId,
          resumed: true,
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
  }

  return {
    task_id: task.id,
    status: task.status,
    backlog_item_id: backlogItemId || null,
    resumed: false,
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

  return { backlog_item: mapBacklogItemRecord(backlogItem) };
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

  return { backlog_item: mapBacklogItemRecord(backlogItem) };
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

    await connection('backlog_items')
      .where({ active_task_id: taskId })
      .update(backlogUpdate);
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
  await connection('backlog_items')
    .where({ active_task_id: taskId })
    .update({ status: 'blocked', updated_at: connection.fn.now() });
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
    if (useStrictBatchMode) {
      return res.status(routeError.statusCode || 500).json({
        error: routeError.message,
        strict: true,
        failed_index: routeError.failedIndex
      });
    }
    return res.status(routeError.statusCode || 500).json({ error: routeError.message });
  }
});

// Skill 1: read_project_context
app.get('/api/projects/context', apiLimiter, authenticateAgent, async (req, res) => {
  const url = normalizeUrl(req.query.url);
  const limit = parseInt(req.query.limit) || 5;

  try {
    const tasks = await db('tasks').where({ project_url: url });
    const backlog = await listBacklogItems(url, req.query.backlog_status);
    const logs = await db('agent_logs')
      .join('tasks', 'agent_logs.task_id', 'tasks.id')
      .where('tasks.project_url', url)
      .orderBy('agent_logs.created_at', 'desc')
      .limit(limit)
      .select('agent_logs.*');

    res.json({ tasks, backlog, logs });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Skill 1b: list_backlog_items
app.get('/api/projects/backlog', apiLimiter, authenticateAgent, async (req, res) => {
  const url = normalizeUrl(req.query.url);
  const status = req.query.status;
  const includeDeleted = parseBooleanFlag(req.query.include_deleted);

  if (!url) {
    return res.status(400).json({ error: 'Project url is required' });
  }

  if (status && !BACKLOG_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'Invalid backlog status' });
  }

  try {
    const backlog = await listBacklogItems(url, status, { includeDeleted });
    res.json({ backlog });
  } catch (error) {
    res.status(500).json({ error: error.message });
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
    if (useStrictBatchMode) {
      return res.status(routeError.statusCode || 500).json({
        error: routeError.message,
        strict: true,
        failed_index: routeError.failedIndex
      });
    }
    return res.status(routeError.statusCode || 500).json({ error: routeError.message });
  }
});

// Skill 1d: update_backlog_item
app.patch('/api/backlog/:id', apiLimiter, authenticateAgent, async (req, res) => {
  try {
    const updated = await updateBacklogItemInternal(req.params.id, req.body);
    return res.json(updated);
  } catch (routeError) {
    return res.status(routeError.statusCode || 500).json({ error: routeError.message });
  }
});

app.delete('/api/backlog/:id', apiLimiter, authenticateAgent, async (req, res) => {
  try {
    const deleted = await deleteBacklogItemInternal(req.params.id);
    return res.json(deleted);
  } catch (routeError) {
    return res.status(routeError.statusCode || 500).json({ error: routeError.message });
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
    if (useStrictBatchMode) {
      return res.status(routeError.statusCode || 500).json({
        error: routeError.message,
        strict: true,
        failed_index: routeError.failedIndex
      });
    }
    return res.status(routeError.statusCode || 500).json({ error: routeError.message });
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
    if (useStrictBatchMode) {
      return res.status(routeError.statusCode || 500).json({
        error: routeError.message,
        strict: true,
        failed_index: routeError.failedIndex
      });
    }
    return res.status(routeError.statusCode || 500).json({ error: routeError.message });
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
    return res.status(routeError.statusCode || 500).json({ error: routeError.message });
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
    if (useStrictBatchMode) {
      return res.status(routeError.statusCode || 500).json({
        error: routeError.message,
        strict: true,
        failed_index: routeError.failedIndex
      });
    }
    return res.status(routeError.statusCode || 500).json({ error: routeError.message });
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
    return res.status(routeError.statusCode || 500).json({ error: routeError.message });
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
    if (useStrictBatchMode) {
      return res.status(routeError.statusCode || 500).json({
        error: routeError.message,
        strict: true,
        failed_index: routeError.failedIndex
      });
    }
    return res.status(routeError.statusCode || 500).json({ error: routeError.message });
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
    if (useStrictBatchMode) {
      return res.status(routeError.statusCode || 500).json({
        error: routeError.message,
        strict: true,
        failed_index: routeError.failedIndex
      });
    }
    return res.status(routeError.statusCode || 500).json({ error: routeError.message });
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
    return res.status(routeError.statusCode || 500).json({ error: routeError.message });
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
    if (useStrictBatchMode) {
      return res.status(routeError.statusCode || 500).json({
        error: routeError.message,
        strict: true,
        failed_index: routeError.failedIndex
      });
    }
    return res.status(routeError.statusCode || 500).json({ error: routeError.message });
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
    const projects = await db('projects').select('*');
    const tasks = await db('tasks').select('*');
    const feed = await db('agent_logs')
      .join('tasks', 'agent_logs.task_id', 'tasks.id')
      .orderBy('agent_logs.created_at', 'desc')
      .limit(20)
      .select('agent_logs.*', 'tasks.title as task_title', 'tasks.project_url');

    res.json({ projects, tasks, feed });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/dashboard/projects', requireAuth, async (req, res) => {
  try {
    const [projects, backlogNeedsDetails] = await Promise.all([
      db('projects').select('*').orderBy('updated_at', 'desc'),
      db('backlog_items')
        .select('project_url')
        .count({ needs_details_count: '*' })
        .where({ status: 'needs_details' })
        .whereNull('deleted_at')
        .groupBy('project_url')
    ]);

    const needsDetailsByProject = new Map(
      backlogNeedsDetails.map((row) => [row.project_url, Number.parseInt(row.needs_details_count, 10) || 0])
    );

    res.json({
      projects: projects.map((project) => {
        const needsDetailsCount = needsDetailsByProject.get(project.url) || 0;

        return {
          ...project,
          needs_details_count: needsDetailsCount,
          has_needs_details: needsDetailsCount > 0
        };
      })
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
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
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/dashboard/projects/:url/backlog', requireAuth, async (req, res) => {
  try {
    const url = normalizeUrl(decodeURIComponent(req.params.url));
    const includeDeleted = parseBooleanFlag(req.query.include_deleted);
    const backlog = await listBacklogItems(url, req.query.status, { includeDeleted });
    res.json({ backlog });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/dashboard/projects/:url/backlog', requireAuth, async (req, res) => {
  const url = normalizeUrl(decodeURIComponent(req.params.url));
  const { payload, error } = getBacklogPayload(req.body);

  if (error) {
    return res.status(400).json({ error });
  }

  try {
    await ensureProjectExists(url);

    const [backlogItem] = await db('backlog_items').insert({
      project_url: url,
      priority: 100,
      sort_order: 0,
      ...payload
    }).returning('*');

    res.status(201).json({ backlog_item: mapBacklogItemRecord(backlogItem) });
  } catch (routeError) {
    res.status(500).json({ error: routeError.message });
  }
});

app.patch('/api/dashboard/backlog/:id', requireAuth, async (req, res) => {
  const { payload, error } = getBacklogPayload(req.body, { partial: true });

  if (error) {
    return res.status(400).json({ error });
  }

  if (!Object.keys(payload).length) {
    return res.status(400).json({ error: 'No backlog fields to update' });
  }

  try {
    const [backlogItem] = await db('backlog_items')
      .where({ id: req.params.id })
      .whereNull('deleted_at')
      .update({
        ...payload,
        updated_at: db.fn.now()
      })
      .returning('*');

    if (!backlogItem) {
      return res.status(404).json({ error: 'Backlog item not found' });
    }

    res.json({ backlog_item: mapBacklogItemRecord(backlogItem) });
  } catch (routeError) {
    res.status(500).json({ error: routeError.message });
  }
});

app.delete('/api/dashboard/backlog/:id', requireAuth, async (req, res) => {
  try {
    const deletedRows = await db('backlog_items')
      .where({ id: req.params.id })
      .del();

    if (!deletedRows) {
      return res.status(404).json({ error: 'Backlog item not found' });
    }

    res.json({ success: true, deleted_rows: deletedRows });
  } catch (error) {
    res.status(500).json({ error: error.message });
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
    res.status(error.statusCode || 500).json({ error: error.message });
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
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.get('/api/dashboard/config/openrouter', requireAuth, async (_req, res) => {
  try {
    const selectedModel = await getConfigValue(CONFIG_KEYS.openrouterModel);

    res.json({
      openrouter: {
        api_key_configured: Boolean((process.env.OPENROUTER_API_KEY || '').trim()),
        selected_model: selectedModel,
        effective_model: selectedModel || DEFAULT_OPENROUTER_MODEL,
        default_model: DEFAULT_OPENROUTER_MODEL
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/dashboard/config/openrouter/models', requireAuth, async (_req, res) => {
  try {
    const models = await fetchOpenRouterModels();
    res.json({ models });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.patch('/api/dashboard/config/openrouter', requireAuth, async (req, res) => {
  const model = typeof req.body?.model === 'string' ? req.body.model.trim() : '';

  if (!model) {
    return res.status(400).json({ error: 'Model is required' });
  }

  try {
    await setConfigValue(CONFIG_KEYS.openrouterModel, model);
    res.json({
      openrouter: {
        selected_model: model,
        effective_model: model,
        default_model: DEFAULT_OPENROUTER_MODEL
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
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
    res.status(500).json({ error: error.message });
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

    app.listen(PORT, () => {
      logger.info({ port: PORT }, 'Backend running');
    });

    startBackgroundJobs();
  } catch (error) {
    logger.fatal({ err: error }, 'Backend startup failed while applying migrations');
    process.exit(1);
  }
};

startServer();

