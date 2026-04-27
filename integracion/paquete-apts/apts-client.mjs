import { execSync } from 'node:child_process';

function getBaseUrl() {
  return (process.env.APTS_BASE_URL || 'http://localhost:46100/api').replace(/\/$/, '');
}

function getHeaders() {
  const apiKey = process.env.APTS_API_KEY;
  if (!apiKey) {
    throw new Error('Missing APTS_API_KEY');
  }

  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
}

async function request(path, options = {}) {
  const response = await fetch(`${getBaseUrl()}${path}`, {
    ...options,
    headers: {
      ...getHeaders(),
      ...(options.headers || {}),
    },
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `APTS request failed with status ${response.status}`);
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

async function registerTask(payload) {
  return request('/projects/tasks', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

async function readProjectContext(url, limitOrOptions = 5) {
  const options = typeof limitOrOptions === 'object' && limitOrOptions !== null
    ? limitOrOptions
    : { limit: limitOrOptions };
  const params = new URLSearchParams({
    url,
    limit: String(options.limit ?? 5),
  });

  if (options.backlogStatus) {
    params.set('backlog_status', options.backlogStatus);
  }

  return request(`/projects/context?${params.toString()}`, {
    method: 'GET',
  });
}

async function listBacklogItems(url, statusOrOptions = null) {
  const options = typeof statusOrOptions === 'object' && statusOrOptions !== null
    ? statusOrOptions
    : { status: statusOrOptions };
  const params = new URLSearchParams({ url });

  if (options.status) {
    params.set('status', options.status);
  }

  if (options.includeDeleted) {
    params.set('include_deleted', 'true');
  }

  return request(`/projects/backlog?${params.toString()}`, {
    method: 'GET',
  });
}

async function createBacklogItem(payload) {
  return request('/projects/backlog', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

async function updateBacklogItem(backlogItemId, payload) {
  return request(`/backlog/${backlogItemId}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

async function deleteBacklogItem(backlogItemId) {
  return request(`/backlog/${backlogItemId}`, {
    method: 'DELETE',
  });
}

async function updateTaskStatus(taskId, payload) {
  return request(`/tasks/${taskId}/status`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

async function logAgentProgress(taskId, payload) {
  return request(`/tasks/${taskId}/logs`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

async function reportBlocker(payload) {
  return request('/projects/blockers', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

async function heartbeat(taskId, payload) {
  return request(`/tasks/${taskId}/heartbeat`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export {
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