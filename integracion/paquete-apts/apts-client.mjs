import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TASK_STATUSES = ['todo', 'in_progress', 'review', 'done', 'stalled'];
const BACKLOG_STATUSES = ['draft', 'needs_details', 'ready', 'in_progress', 'review', 'blocked', 'done', 'archived'];
const BACKLOG_ITEM_TYPES = ['feature', 'bug', 'chore', 'research'];
let envLoaded = false;

function parseEnvLine(rawLine) {
  const line = rawLine.trim();
  if (!line || line.startsWith('#')) return null;

  const normalized = line.startsWith('export ') ? line.slice(7).trim() : line;
  const separator = normalized.indexOf('=');
  if (separator <= 0) return null;

  const key = normalized.slice(0, separator).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;

  let value = normalized.slice(separator + 1).trim();
  const isDoubleQuoted = value.startsWith('"') && value.endsWith('"');
  const isSingleQuoted = value.startsWith("'") && value.endsWith("'");

  if (isDoubleQuoted || isSingleQuoted) {
    value = value.slice(1, -1);
  } else {
    value = value.replace(/\s+#.*$/, '').trim();
  }

  return [key, value];
}

function loadEnvFile(filePath) {
  let contents;

  try {
    contents = fs.readFileSync(filePath, 'utf8');
  } catch {
    return;
  }

  for (const line of contents.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;

    const [key, value] = parsed;
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function loadProjectEnv() {
  if (envLoaded) return;
  envLoaded = true;

  const envPath = path.join(process.cwd(), '.env');
  if (fs.existsSync(envPath) && fs.statSync(envPath).isFile()) {
    loadEnvFile(envPath);
  }
}

loadProjectEnv();

class AptsClientError extends Error {
  constructor(message, {
    statusCode = null,
    errorCode = 'APTS_CLIENT_ERROR',
    retriable = false,
    details = null,
    cause,
  } = {}) {
    super(message);
    this.name = 'AptsClientError';
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.retriable = retriable;
    this.details = details;

    if (cause) {
      this.cause = cause;
    }
  }
}

function getBaseUrl() {
  return (process.env.APTS_BASE_URL || 'http://localhost:47301/api').replace(/\/$/, '');
}

function getHeaders() {
  const apiKey = process.env.APTS_API_KEY;
  if (!apiKey) {
    const expectedEnvPath = path.join(process.cwd(), '.env');
    throw new AptsClientError(`Missing APTS_API_KEY. Checked process.env and ${expectedEnvPath}. Run this script from the project root or export APTS_API_KEY in your environment.`, {
      errorCode: 'MISSING_API_KEY',
      retriable: false,
    });
  }

  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unwrapMatchingQuotes(value) {
  if (typeof value !== 'string') return value;

  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;

  const startsWithDouble = trimmed.startsWith('"') && trimmed.endsWith('"');
  const startsWithSingle = trimmed.startsWith("'") && trimmed.endsWith("'");

  if (!startsWithDouble && !startsWithSingle) return trimmed;
  return trimmed.slice(1, -1).trim();
}

function normalizeString(value, { lowercase = false, unwrapQuotes = false } = {}) {
  if (typeof value !== 'string') return value;

  let normalized = value.trim();
  if (unwrapQuotes) {
    normalized = unwrapMatchingQuotes(normalized);
  }
  if (lowercase) {
    normalized = normalized.toLowerCase();
  }

  return normalized;
}

function invalidArgument(message, details = null) {
  return new AptsClientError(message, {
    errorCode: 'INVALID_ARGUMENT',
    retriable: false,
    details,
  });
}

function assertPayloadObject(payload, operationName) {
  if (!isPlainObject(payload)) {
    throw invalidArgument(`${operationName} expects a JSON object payload`, {
      operation: operationName,
      expected: 'object',
      received: payload == null ? String(payload) : typeof payload,
    });
  }
}

function requiredString(payload, field, operationName, { unwrapQuotes = false } = {}) {
  const value = normalizeString(payload[field], { unwrapQuotes });
  if (typeof value !== 'string' || !value) {
    throw invalidArgument(`${operationName} requires non-empty string field '${field}'`, {
      operation: operationName,
      field,
      expected: 'non-empty string',
      received: payload[field],
    });
  }
  return value;
}

function optionalString(payload, field, operationName, { unwrapQuotes = false, nullable = false } = {}) {
  const original = payload[field];

  if (original === undefined) return undefined;
  if (nullable && (original === null || original === '')) return null;

  const value = normalizeString(original, { unwrapQuotes });
  if (typeof value !== 'string') {
    throw invalidArgument(`${operationName} expects '${field}' to be a string`, {
      operation: operationName,
      field,
      expected: 'string',
      received: original,
    });
  }

  return value;
}

function optionalInteger(payload, field, operationName) {
  const original = payload[field];
  if (original === undefined) return undefined;

  let value = original;
  if (typeof value === 'string' && value.trim()) {
    value = Number(value.trim());
  }

  if (!Number.isInteger(value)) {
    throw invalidArgument(`${operationName} expects '${field}' to be an integer`, {
      operation: operationName,
      field,
      expected: 'integer',
      received: original,
    });
  }

  return value;
}

function optionalBoolean(payload, field, operationName) {
  const original = payload[field];
  if (original === undefined) return undefined;
  if (typeof original !== 'boolean') {
    throw invalidArgument(`${operationName} expects '${field}' to be a boolean`, {
      operation: operationName,
      field,
      expected: 'boolean',
      received: original,
    });
  }

  return original;
}

function optionalUuid(payload, field, operationName, { nullable = false } = {}) {
  const original = payload[field];
  if (original === undefined) return undefined;
  if (nullable && (original === null || original === '')) return null;

  const value = normalizeString(original, { unwrapQuotes: true });
  if (typeof value !== 'string' || !UUID_REGEX.test(value)) {
    throw invalidArgument(`${operationName} expects '${field}' to be a valid UUID`, {
      operation: operationName,
      field,
      expected: 'uuid',
      received: original,
    });
  }

  return value;
}

function requiredUuid(payload, field, operationName) {
  const value = optionalUuid(payload, field, operationName);
  if (!value) {
    throw invalidArgument(`${operationName} requires '${field}'`, {
      operation: operationName,
      field,
      expected: 'uuid',
      received: payload[field],
    });
  }

  return value;
}

function optionalEnum(payload, field, allowedValues, operationName) {
  const original = payload[field];
  if (original === undefined) return undefined;

  const value = normalizeString(original, { unwrapQuotes: true, lowercase: true });
  if (typeof value !== 'string' || !allowedValues.includes(value)) {
    throw invalidArgument(`${operationName} has invalid '${field}' value`, {
      operation: operationName,
      field,
      expected: allowedValues,
      received: original,
    });
  }

  return value;
}

function statusToErrorCode(statusCode) {
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
}

function isRetriableStatus(statusCode) {
  return statusCode === 408 || statusCode === 425 || statusCode === 429 || statusCode >= 500;
}

async function request(path, options = {}) {
  let response;

  try {
    response = await fetch(`${getBaseUrl()}${path}`, {
      ...options,
      headers: {
        ...getHeaders(),
        ...(options.headers || {}),
      },
    });
  } catch (error) {
    throw new AptsClientError('Network error while calling APTS', {
      errorCode: 'NETWORK_ERROR',
      retriable: true,
      cause: error,
    });
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new AptsClientError(data.error || `APTS request failed with status ${response.status}`, {
      statusCode: response.status,
      errorCode: typeof data.error_code === 'string' ? data.error_code : statusToErrorCode(response.status),
      retriable: typeof data.retriable === 'boolean' ? data.retriable : isRetriableStatus(response.status),
      details: data,
    });
  }

  return data;
}

function readGit(command) {
  return execSync(command, { encoding: 'utf8' }).trim();
}

function resolveGitIdentity() {
  return {
    project_url: readGit('git remote get-url origin'),
    agent_name: readGit('git config user.name'),
    agent_email: readGit('git config user.email'),
    branch: readGit('git branch --show-current'),
  };
}

function validateRegisterTaskPayload(payload) {
  const operation = 'register_task';
  assertPayloadObject(payload, operation);

  return {
    project_url: requiredString(payload, 'project_url', operation, { unwrapQuotes: true }),
    title: requiredString(payload, 'title', operation),
    agent_name: requiredString(payload, 'agent_name', operation),
    agent_email: requiredString(payload, 'agent_email', operation),
    context: optionalString(payload, 'context', operation),
    backlog_item_id: optionalUuid(payload, 'backlog_item_id', operation),
  };
}

function validateReadProjectContextInput(urlOrOptions, limitOrOptions = 5) {
  const operation = 'read_project_context';

  if (isPlainObject(urlOrOptions)) {
    const payload = urlOrOptions;
    assertPayloadObject(payload, operation);

    return {
      url: requiredString(payload, 'url', operation, { unwrapQuotes: true }),
      limit: optionalInteger(payload, 'limit', operation) ?? 5,
      backlog_status: optionalEnum(payload, 'backlog_status', BACKLOG_STATUSES, operation),
    };
  }

  const url = normalizeString(urlOrOptions, { unwrapQuotes: true });
  if (typeof url !== 'string' || !url) {
    throw invalidArgument(`${operation} requires 'url'`, {
      operation,
      field: 'url',
      expected: 'non-empty string',
      received: urlOrOptions,
    });
  }

  const options = isPlainObject(limitOrOptions)
    ? limitOrOptions
    : { limit: limitOrOptions };

  return {
    url,
    limit: optionalInteger(options, 'limit', operation) ?? 5,
    backlog_status: optionalEnum(
      {
        backlog_status: options.backlog_status ?? options.backlogStatus,
      },
      'backlog_status',
      BACKLOG_STATUSES,
      operation
    ),
  };
}

function validateListBacklogItemsInput(urlOrOptions, statusOrOptions = null) {
  const operation = 'list_backlog_items';

  if (isPlainObject(urlOrOptions)) {
    const payload = urlOrOptions;
    assertPayloadObject(payload, operation);

    return {
      url: requiredString(payload, 'url', operation, { unwrapQuotes: true }),
      status: optionalEnum(payload, 'status', BACKLOG_STATUSES, operation),
      include_deleted: optionalBoolean(payload, 'include_deleted', operation) ?? false,
    };
  }

  const url = normalizeString(urlOrOptions, { unwrapQuotes: true });
  if (typeof url !== 'string' || !url) {
    throw invalidArgument(`${operation} requires 'url'`, {
      operation,
      field: 'url',
      expected: 'non-empty string',
      received: urlOrOptions,
    });
  }

  const options = isPlainObject(statusOrOptions)
    ? statusOrOptions
    : { status: statusOrOptions };

  return {
    url,
    status: optionalEnum(options, 'status', BACKLOG_STATUSES, operation),
    include_deleted: optionalBoolean(
      {
        include_deleted: options.include_deleted ?? options.includeDeleted,
      },
      'include_deleted',
      operation
    ) ?? false,
  };
}

function validateCreateBacklogItemPayload(payload) {
  const operation = 'create_backlog_item';
  assertPayloadObject(payload, operation);

  return {
    project_url: requiredString(payload, 'project_url', operation, { unwrapQuotes: true }),
    title: requiredString(payload, 'title', operation),
    description: optionalString(payload, 'description', operation, { nullable: true }),
    acceptance_criteria: optionalString(payload, 'acceptance_criteria', operation, { nullable: true }),
    item_type: optionalEnum(payload, 'item_type', BACKLOG_ITEM_TYPES, operation),
    status: optionalEnum(payload, 'status', BACKLOG_STATUSES, operation),
    priority: optionalInteger(payload, 'priority', operation),
    sort_order: optionalInteger(payload, 'sort_order', operation),
    source_kind: optionalString(payload, 'source_kind', operation, { nullable: true }),
    source_ref: optionalString(payload, 'source_ref', operation, { nullable: true }),
  };
}

function validateUpdateBacklogItemInput(inputOrBacklogId, maybePayload) {
  const operation = 'update_backlog_item';

  let payload;
  if (typeof inputOrBacklogId === 'string') {
    payload = {
      ...(isPlainObject(maybePayload) ? maybePayload : {}),
      backlog_item_id: inputOrBacklogId,
    };
  } else {
    payload = inputOrBacklogId;
  }

  assertPayloadObject(payload, operation);

  const backlog_item_id = optionalUuid(payload, 'backlog_item_id', operation);
  if (!backlog_item_id) {
    throw invalidArgument(`${operation} requires 'backlog_item_id'`, {
      operation,
      field: 'backlog_item_id',
      expected: 'uuid',
      received: payload.backlog_item_id,
    });
  }

  const normalizedPayload = {
    title: optionalString(payload, 'title', operation),
    description: optionalString(payload, 'description', operation, { nullable: true }),
    acceptance_criteria: optionalString(payload, 'acceptance_criteria', operation, { nullable: true }),
    item_type: optionalEnum(payload, 'item_type', BACKLOG_ITEM_TYPES, operation),
    status: optionalEnum(payload, 'status', BACKLOG_STATUSES, operation),
    priority: optionalInteger(payload, 'priority', operation),
    sort_order: optionalInteger(payload, 'sort_order', operation),
    source_kind: optionalString(payload, 'source_kind', operation, { nullable: true }),
    source_ref: optionalString(payload, 'source_ref', operation, { nullable: true }),
    active_task_id: optionalUuid(payload, 'active_task_id', operation, { nullable: true }),
  };

  const hasAnyUpdateField = Object.values(normalizedPayload).some((value) => value !== undefined);
  if (!hasAnyUpdateField) {
    throw invalidArgument(`${operation} requires at least one field to update`, {
      operation,
      field: 'payload',
      expected: 'at least one updatable field',
      received: payload,
    });
  }

  return {
    backlog_item_id,
    payload: normalizedPayload,
  };
}

function validateDeleteBacklogItemInput(inputOrBacklogId) {
  const operation = 'delete_backlog_item';

  if (typeof inputOrBacklogId === 'string') {
    const backlog_item_id = normalizeString(inputOrBacklogId, { unwrapQuotes: true });
    if (!UUID_REGEX.test(backlog_item_id)) {
      throw invalidArgument(`${operation} expects backlog item id to be a valid UUID`, {
        operation,
        field: 'backlog_item_id',
        expected: 'uuid',
        received: inputOrBacklogId,
      });
    }
    return backlog_item_id;
  }

  assertPayloadObject(inputOrBacklogId, operation);
  const backlog_item_id = optionalUuid(inputOrBacklogId, 'backlog_item_id', operation);
  if (!backlog_item_id) {
    throw invalidArgument(`${operation} requires 'backlog_item_id'`, {
      operation,
      field: 'backlog_item_id',
      expected: 'uuid',
      received: inputOrBacklogId.backlog_item_id,
    });
  }

  return backlog_item_id;
}

function validateUpdateTaskStatusInput(inputOrTaskId, maybePayload) {
  const operation = 'update_task_status';

  let payload;
  if (typeof inputOrTaskId === 'string') {
    payload = {
      ...(isPlainObject(maybePayload) ? maybePayload : {}),
      task_id: inputOrTaskId,
    };
  } else {
    payload = inputOrTaskId;
  }

  assertPayloadObject(payload, operation);

  return {
    task_id: requiredUuid(payload, 'task_id', operation),
    status: optionalEnum(payload, 'status', TASK_STATUSES, operation) || requiredString(payload, 'status', operation),
    project_url: requiredString(payload, 'project_url', operation, { unwrapQuotes: true }),
    agent_name: requiredString(payload, 'agent_name', operation),
    agent_email: requiredString(payload, 'agent_email', operation),
  };
}

function validateLogAgentProgressInput(inputOrTaskId, maybePayload) {
  const operation = 'log_agent_progress';

  let payload;
  if (typeof inputOrTaskId === 'string') {
    payload = {
      ...(isPlainObject(maybePayload) ? maybePayload : {}),
      task_id: inputOrTaskId,
    };
  } else {
    payload = inputOrTaskId;
  }

  assertPayloadObject(payload, operation);

  return {
    task_id: requiredUuid(payload, 'task_id', operation),
    project_url: requiredString(payload, 'project_url', operation, { unwrapQuotes: true }),
    agent_name: requiredString(payload, 'agent_name', operation),
    branch: requiredString(payload, 'branch', operation, { unwrapQuotes: true }),
    message: requiredString(payload, 'message', operation),
    technical_details: payload.technical_details,
  };
}

function validateReportBlockerPayload(payload) {
  const operation = 'report_blocker';
  assertPayloadObject(payload, operation);

  return {
    project_url: requiredString(payload, 'project_url', operation, { unwrapQuotes: true }),
    task_id: requiredUuid(payload, 'task_id', operation),
    error_message: requiredString(payload, 'error_message', operation),
    agent_name: requiredString(payload, 'agent_name', operation),
  };
}

function validateHeartbeatInput(inputOrTaskId, maybePayload) {
  const operation = 'heartbeat';

  let payload;
  if (typeof inputOrTaskId === 'string') {
    payload = {
      ...(isPlainObject(maybePayload) ? maybePayload : {}),
      task_id: inputOrTaskId,
    };
  } else {
    payload = inputOrTaskId;
  }

  assertPayloadObject(payload, operation);

  return {
    task_id: requiredUuid(payload, 'task_id', operation),
    agent_name: requiredString(payload, 'agent_name', operation),
    project_url: requiredString(payload, 'project_url', operation, { unwrapQuotes: true }),
  };
}

function normalizeBatchOptions(options, operationName) {
  if (options === undefined) {
    return { strict: false };
  }

  if (!isPlainObject(options)) {
    throw invalidArgument(`${operationName} options must be an object`, {
      operation: operationName,
      expected: 'object',
      received: options,
    });
  }

  if (options.strict !== undefined && typeof options.strict !== 'boolean') {
    throw invalidArgument(`${operationName} option 'strict' must be a boolean`, {
      operation: operationName,
      field: 'strict',
      expected: 'boolean',
      received: options.strict,
    });
  }

  return {
    strict: options.strict === true,
  };
}

function buildBatchPath(pathname, options) {
  if (!options?.strict) return pathname;
  return `${pathname}?strict=true`;
}

function normalizeBatchPayload(input, operationName, itemValidator, options) {
  const normalizedOptions = normalizeBatchOptions(options, operationName);

  if (!Array.isArray(input)) {
    return { isBatch: false, items: [itemValidator(input)], options: normalizedOptions };
  }

  if (!input.length) {
    throw invalidArgument(`${operationName} expects a non-empty array when using batch mode`, {
      operation: operationName,
      expected: 'non-empty array',
      received: input,
    });
  }

  return {
    isBatch: true,
    items: input.map((item) => itemValidator(item)),
    options: normalizedOptions,
  };
}

async function registerTask(payload, options) {
  const { isBatch, items, options: batchOptions } = normalizeBatchPayload(payload, 'register_task', validateRegisterTaskPayload, options);
  return request(buildBatchPath('/projects/tasks', isBatch ? batchOptions : { strict: false }), {
    method: 'POST',
    body: JSON.stringify(isBatch ? items : items[0]),
  });
}

async function readProjectContext(urlOrOptions, limitOrOptions = 5) {
  const options = validateReadProjectContextInput(urlOrOptions, limitOrOptions);
  const params = new URLSearchParams({
    url: options.url,
    limit: String(options.limit ?? 5),
  });

  if (options.backlog_status) {
    params.set('backlog_status', options.backlog_status);
  }

  return request(`/projects/context?${params.toString()}`, {
    method: 'GET',
  });
}

async function listBacklogItems(urlOrOptions, statusOrOptions = null) {
  const options = validateListBacklogItemsInput(urlOrOptions, statusOrOptions);
  const params = new URLSearchParams({ url: options.url });

  if (options.status) {
    params.set('status', options.status);
  }

  if (options.include_deleted) {
    params.set('include_deleted', 'true');
  }

  return request(`/projects/backlog?${params.toString()}`, {
    method: 'GET',
  });
}

async function createBacklogItem(payload, options) {
  const { isBatch, items, options: batchOptions } = normalizeBatchPayload(payload, 'create_backlog_item', validateCreateBacklogItemPayload, options);
  return request(buildBatchPath('/projects/backlog', isBatch ? batchOptions : { strict: false }), {
    method: 'POST',
    body: JSON.stringify(isBatch ? items : items[0]),
  });
}

async function updateBacklogItem(inputOrBacklogId, payload, options) {
  if (Array.isArray(inputOrBacklogId)) {
    if (options !== undefined) {
      throw invalidArgument('update_backlog_item batch mode accepts at most two arguments: array payload and options', {
        operation: 'update_backlog_item',
        expected: '[arrayPayload, options]',
      });
    }

    const batchOptions = normalizeBatchOptions(payload, 'update_backlog_item');
    const normalizedItems = inputOrBacklogId.map((item) => validateUpdateBacklogItemInput(item));
    return request(buildBatchPath('/backlog', batchOptions), {
      method: 'PATCH',
      body: JSON.stringify(normalizedItems.map((item) => ({
        backlog_item_id: item.backlog_item_id,
        ...item.payload,
      }))),
    });
  }

  const normalized = validateUpdateBacklogItemInput(inputOrBacklogId, payload);
  return request(`/backlog/${normalized.backlog_item_id}`, {
    method: 'PATCH',
    body: JSON.stringify(normalized.payload),
  });
}

async function deleteBacklogItem(inputOrBacklogId, options) {
  if (Array.isArray(inputOrBacklogId)) {
    if (!inputOrBacklogId.length) {
      throw invalidArgument('delete_backlog_item expects a non-empty array when using batch mode', {
        operation: 'delete_backlog_item',
        expected: 'non-empty array',
        received: inputOrBacklogId,
      });
    }

    const batchOptions = normalizeBatchOptions(options, 'delete_backlog_item');
    const normalizedIds = inputOrBacklogId.map((item) => validateDeleteBacklogItemInput(item));
    return request(buildBatchPath('/backlog', batchOptions), {
      method: 'DELETE',
      body: JSON.stringify(normalizedIds.map((backlog_item_id) => ({ backlog_item_id }))),
    });
  }

  const backlogItemId = validateDeleteBacklogItemInput(inputOrBacklogId);
  return request(`/backlog/${backlogItemId}`, {
    method: 'DELETE',
  });
}

async function updateTaskStatus(inputOrTaskId, payload, options) {
  if (Array.isArray(inputOrTaskId)) {
    if (options !== undefined) {
      throw invalidArgument('update_task_status batch mode accepts at most two arguments: array payload and options', {
        operation: 'update_task_status',
        expected: '[arrayPayload, options]',
      });
    }

    if (!inputOrTaskId.length) {
      throw invalidArgument('update_task_status expects a non-empty array when using batch mode', {
        operation: 'update_task_status',
        expected: 'non-empty array',
        received: inputOrTaskId,
      });
    }

    const batchOptions = normalizeBatchOptions(payload, 'update_task_status');
    const normalizedItems = inputOrTaskId.map((item) => validateUpdateTaskStatusInput(item));
    return request(buildBatchPath('/tasks/status', batchOptions), {
      method: 'PATCH',
      body: JSON.stringify(normalizedItems),
    });
  }

  const normalizedPayload = validateUpdateTaskStatusInput(inputOrTaskId, payload);
  const { task_id: taskId, ...body } = normalizedPayload;

  return request(`/tasks/${taskId}/status`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

async function logAgentProgress(inputOrTaskId, payload, options) {
  if (Array.isArray(inputOrTaskId)) {
    if (options !== undefined) {
      throw invalidArgument('log_agent_progress batch mode accepts at most two arguments: array payload and options', {
        operation: 'log_agent_progress',
        expected: '[arrayPayload, options]',
      });
    }

    if (!inputOrTaskId.length) {
      throw invalidArgument('log_agent_progress expects a non-empty array when using batch mode', {
        operation: 'log_agent_progress',
        expected: 'non-empty array',
        received: inputOrTaskId,
      });
    }

    const batchOptions = normalizeBatchOptions(payload, 'log_agent_progress');
    const normalizedItems = inputOrTaskId.map((item) => validateLogAgentProgressInput(item));
    return request(buildBatchPath('/tasks/logs', batchOptions), {
      method: 'POST',
      body: JSON.stringify(normalizedItems),
    });
  }

  const normalizedPayload = validateLogAgentProgressInput(inputOrTaskId, payload);
  const { task_id: taskId, project_url: _projectUrl, ...body } = normalizedPayload;

  return request(`/tasks/${taskId}/logs`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

async function reportBlocker(payload, options) {
  const { isBatch, items, options: batchOptions } = normalizeBatchPayload(payload, 'report_blocker', validateReportBlockerPayload, options);
  return request(buildBatchPath('/projects/blockers', isBatch ? batchOptions : { strict: false }), {
    method: 'POST',
    body: JSON.stringify(isBatch ? items : items[0]),
  });
}

async function heartbeat(inputOrTaskId, payload, options) {
  if (Array.isArray(inputOrTaskId)) {
    if (options !== undefined) {
      throw invalidArgument('heartbeat batch mode accepts at most two arguments: array payload and options', {
        operation: 'heartbeat',
        expected: '[arrayPayload, options]',
      });
    }

    if (!inputOrTaskId.length) {
      throw invalidArgument('heartbeat expects a non-empty array when using batch mode', {
        operation: 'heartbeat',
        expected: 'non-empty array',
        received: inputOrTaskId,
      });
    }

    const batchOptions = normalizeBatchOptions(payload, 'heartbeat');
    const normalizedItems = inputOrTaskId.map((item) => validateHeartbeatInput(item));
    return request(buildBatchPath('/tasks/heartbeat', batchOptions), {
      method: 'POST',
      body: JSON.stringify(normalizedItems),
    });
  }

  const normalizedPayload = validateHeartbeatInput(inputOrTaskId, payload);
  const { task_id: taskId, ...body } = normalizedPayload;

  return request(`/tasks/${taskId}/heartbeat`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export {
  AptsClientError,
  createBacklogItem,
  deleteBacklogItem,
  heartbeat,
  listBacklogItems,
  logAgentProgress,
  readProjectContext,
  registerTask,
  reportBlocker,
  resolveGitIdentity,
  updateBacklogItem,
  updateTaskStatus,
};