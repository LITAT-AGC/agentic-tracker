const { execSync } = require('node:child_process');

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

async function readProjectContext(url, limit = 5) {
  const encodedUrl = encodeURIComponent(url);
  return request(`/projects/context?url=${encodedUrl}&limit=${limit}`, {
    method: 'GET',
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

module.exports = {
  heartbeat,
  logAgentProgress,
  readProjectContext,
  registerTask,
  reportBlocker,
  resolveGitIdentity,
  updateTaskStatus,
};