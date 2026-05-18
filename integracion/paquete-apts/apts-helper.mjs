import * as client from './apts-client.mjs';

const OPERATIONS = {
  'resolve-git-identity': {
    expectsPayload: false,
    supportsOptions: false,
    invoke: () => client.resolveGitIdentity(),
  },
  'show-execution-context': {
    expectsPayload: false,
    supportsOptions: false,
    invoke: () => client.getExecutionContext(),
  },
  'set-execution-context': {
    expectsPayload: true,
    supportsOptions: false,
    invoke: (payload) => client.setExecutionContext(payload),
  },
  'clear-execution-context': {
    expectsPayload: false,
    supportsOptions: false,
    invoke: () => client.clearStoredExecutionContext(),
  },
  'register-task': {
    expectsPayload: true,
    supportsOptions: true,
    invoke: (payload, options) => client.registerTask(payload, options),
  },
  'read-project-context': {
    expectsPayload: true,
    supportsOptions: false,
    invoke: (payload) => client.readProjectContext(payload),
  },
  'list-backlog-items': {
    expectsPayload: true,
    supportsOptions: false,
    invoke: (payload) => client.listBacklogItems(payload),
  },
  'get-backlog-item': {
    expectsPayload: true,
    supportsOptions: false,
    invoke: (payload) => client.getBacklogItem(payload),
  },
  'get-task': {
    expectsPayload: true,
    supportsOptions: false,
    invoke: (payload) => client.getTask(payload),
  },
  'get-project-constraints': {
    expectsPayload: true,
    supportsOptions: false,
    invoke: (payload) => client.getProjectConstraints(payload),
  },
  'search-similar-bug-reports': {
    expectsPayload: true,
    supportsOptions: false,
    invoke: (payload) => client.searchSimilarBugReports(payload),
  },
  'create-backlog-item': {
    expectsPayload: true,
    supportsOptions: true,
    invoke: (payload, options) => client.createBacklogItem(payload, options),
  },
  'update-backlog-item': {
    expectsPayload: true,
    supportsOptions: true,
    invoke: (payload, options) => client.updateBacklogItem(payload, options),
  },
  'delete-backlog-item': {
    expectsPayload: true,
    supportsOptions: true,
    invoke: (payload, options) => client.deleteBacklogItem(payload, options),
  },
  'update-task-status': {
    expectsPayload: true,
    supportsOptions: true,
    invoke: (payload, options) => client.updateTaskStatus(payload, options),
  },
  'log-agent-progress': {
    expectsPayload: true,
    supportsOptions: true,
    invoke: (payload, options) => client.logAgentProgress(payload, options),
  },
  'report-blocker': {
    expectsPayload: true,
    supportsOptions: true,
    invoke: (payload, options) => client.reportBlocker(payload, options),
  },
  heartbeat: {
    expectsPayload: true,
    supportsOptions: true,
    invoke: (payload, options) => client.heartbeat(payload, options),
  },
};

function canonicalizeOperationName(value) {
  return String(value || '').trim().toLowerCase().replace(/_/g, '-');
}

function helperUsageError(message) {
  const error = new Error(message);
  error.code = 'APTS_HELPER_USAGE_ERROR';
  return error;
}

function resolveOperation(operationName) {
  const normalized = canonicalizeOperationName(operationName);
  return normalized ? OPERATIONS[normalized] : null;
}

async function invoke(operationName, payload, options) {
  const normalized = canonicalizeOperationName(operationName);
  const operation = resolveOperation(normalized);

  if (!operation) {
    throw helperUsageError(`Unknown APTS helper operation: ${operationName}`);
  }

  if (operation.expectsPayload && payload === undefined) {
    throw helperUsageError(`Operation ${normalized} requires a JSON object payload`);
  }

  if (!operation.expectsPayload && payload !== undefined) {
    throw helperUsageError(`Operation ${normalized} does not accept a payload`);
  }

  if (options !== undefined && !operation.supportsOptions) {
    throw helperUsageError(`Operation ${normalized} does not accept options`);
  }

  return operation.invoke(payload, options);
}

function buildAptsHelper() {
  return {
    call: invoke,
    run: invoke,
    commands: Object.keys(OPERATIONS),
    showExecutionContext: client.getExecutionContext,
    setExecutionContext: client.setExecutionContext,
    clearExecutionContext: client.clearStoredExecutionContext,
    registerTask: client.registerTask,
    readProjectContext: client.readProjectContext,
    listBacklogItems: client.listBacklogItems,
    getBacklogItem: client.getBacklogItem,
    getTask: client.getTask,
    getProjectConstraints: client.getProjectConstraints,
    searchSimilarBugReports: client.searchSimilarBugReports,
    createBacklogItem: client.createBacklogItem,
    updateBacklogItem: client.updateBacklogItem,
    deleteBacklogItem: client.deleteBacklogItem,
    updateTaskStatus: client.updateTaskStatus,
    logAgentProgress: client.logAgentProgress,
    reportBlocker: client.reportBlocker,
    heartbeat: client.heartbeat,
  };
}

const apts = buildAptsHelper();
const {
  AptsClientError,
  clearStoredExecutionContext,
  createBacklogItem,
  deleteBacklogItem,
  getBacklogItem,
  getExecutionContext,
  getLoadedEnvFiles,
  getProjectConstraints,
  getTask,
  heartbeat,
  listBacklogItems,
  logAgentProgress,
  readProjectContext,
  registerTask,
  reportBlocker,
  resolveExecutionIdentity,
  resolveGitIdentity,
  searchSimilarBugReports,
  setExecutionContext,
  updateBacklogItem,
  updateTaskStatus,
} = client;

export default apts;
export {
  AptsClientError,
  buildAptsHelper,
  clearStoredExecutionContext,
  client,
  createBacklogItem,
  deleteBacklogItem,
  getBacklogItem,
  getExecutionContext,
  getLoadedEnvFiles,
  getProjectConstraints,
  getTask,
  heartbeat,
  invoke,
  listBacklogItems,
  logAgentProgress,
  readProjectContext,
  registerTask,
  reportBlocker,
  resolveOperation,
  resolveExecutionIdentity,
  resolveGitIdentity,
  searchSimilarBugReports,
  setExecutionContext,
  updateBacklogItem,
  updateTaskStatus,
};
