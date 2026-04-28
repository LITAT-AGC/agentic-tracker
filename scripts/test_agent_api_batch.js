const fs = require('node:fs');
const path = require('node:path');

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

function loadEnvFromCwd() {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath) || !fs.statSync(envPath).isFile()) {
    return envPath;
  }

  const contents = fs.readFileSync(envPath, 'utf8');
  for (const line of contents.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;

    const [key, value] = parsed;
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  return envPath;
}

const expectedEnvPath = loadEnvFromCwd();
const API_KEY = process.env.APTS_API_KEY || 'default-dev-key';
const BASE_URL = process.env.APTS_BASE_URL || 'http://localhost:47301/api';

if (!process.env.APTS_API_KEY) {
  console.warn(`[APTS] Missing APTS_API_KEY. Checked process.env and ${expectedEnvPath}. Using fallback default-dev-key for local batch smoke test.`);
}

const headers = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${API_KEY}`,
};

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function request(endpoint, { method = 'GET', body, expectedStatuses = [200] } = {}) {
  const response = await fetch(`${BASE_URL}${endpoint}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (_error) {
      data = { raw: text };
    }
  }

  if (!expectedStatuses.includes(response.status)) {
    throw new Error(`Unexpected HTTP ${response.status} for ${method} ${endpoint}: ${JSON.stringify(data)}`);
  }

  return { status: response.status, data };
}

function expectBatchSuccess(result, label, expectedCount) {
  assert(result.data.success === true, `${label} should be success=true`);
  assert(result.data.processed === expectedCount, `${label} should process ${expectedCount} items`);
  assert(result.data.failed === 0, `${label} should have no failed items`);
}

function getBatchDataList(result) {
  return (result.data.results || []).map((item) => item.data);
}

async function runBatchSmoke() {
  const seed = Date.now();
  const projectUrl = `https://github.com/agentic-org/apts-batch-${seed}`;
  const agentName = 'Batch-Smoke-Agent';
  const agentEmail = 'batch-smoke@agents.local';
  const invalidTaskId = '11111111-1111-4111-8111-111111111111';
  const invalidBacklogId = '22222222-2222-4222-8222-222222222222';

  console.log('--- APTS Batch Smoke Test ---');

  const createBacklog = await request('/projects/backlog', {
    method: 'POST',
    body: [
      {
        project_url: projectUrl,
        title: 'Batch Backlog Item 1',
        description: 'Created from batch smoke test',
        item_type: 'feature',
      },
      {
        project_url: projectUrl,
        title: 'Batch Backlog Item 2',
        description: 'Created from batch smoke test',
        item_type: 'chore',
      },
    ],
    expectedStatuses: [201],
  });
  expectBatchSuccess(createBacklog, 'create_backlog_item batch', 2);
  const backlogItems = getBatchDataList(createBacklog).map((entry) => entry.backlog_item);
  const backlogIds = backlogItems.map((item) => item.id);

  const registerTasks = await request('/projects/tasks', {
    method: 'POST',
    body: [
      {
        project_url: projectUrl,
        title: 'Batch Task 1',
        agent_name: agentName,
        agent_email: agentEmail,
        backlog_item_id: backlogIds[0],
      },
      {
        project_url: projectUrl,
        title: 'Batch Task 2',
        agent_name: agentName,
        agent_email: agentEmail,
        backlog_item_id: backlogIds[1],
      },
    ],
  });
  expectBatchSuccess(registerTasks, 'register_task batch', 2);
  const taskIds = getBatchDataList(registerTasks).map((entry) => entry.task_id);

  const logBatch = await request('/tasks/logs', {
    method: 'POST',
    body: [
      {
        task_id: taskIds[0],
        project_url: projectUrl,
        agent_name: agentName,
        branch: 'batch/smoke-1',
        message: 'batch log entry 1',
      },
      {
        task_id: taskIds[1],
        project_url: projectUrl,
        agent_name: agentName,
        branch: 'batch/smoke-2',
        message: 'batch log entry 2',
      },
    ],
  });
  expectBatchSuccess(logBatch, 'log_agent_progress batch', 2);

  const heartbeatBatch = await request('/tasks/heartbeat', {
    method: 'POST',
    body: [
      {
        task_id: taskIds[0],
        project_url: projectUrl,
        agent_name: agentName,
      },
      {
        task_id: taskIds[1],
        project_url: projectUrl,
        agent_name: agentName,
      },
    ],
  });
  expectBatchSuccess(heartbeatBatch, 'heartbeat batch', 2);

  const statusBatch = await request('/tasks/status', {
    method: 'PATCH',
    body: [
      {
        task_id: taskIds[0],
        status: 'review',
        project_url: projectUrl,
        agent_name: agentName,
        agent_email: agentEmail,
      },
      {
        task_id: taskIds[1],
        status: 'review',
        project_url: projectUrl,
        agent_name: agentName,
        agent_email: agentEmail,
      },
    ],
  });
  expectBatchSuccess(statusBatch, 'update_task_status batch', 2);

  const strictFail = await request('/tasks/status?strict=true', {
    method: 'PATCH',
    body: [
      {
        task_id: taskIds[0],
        status: 'done',
        project_url: projectUrl,
        agent_name: agentName,
        agent_email: agentEmail,
      },
      {
        task_id: invalidTaskId,
        status: 'done',
        project_url: projectUrl,
        agent_name: agentName,
        agent_email: agentEmail,
      },
    ],
    expectedStatuses: [404],
  });
  assert(strictFail.data.strict === true, 'strict mode should report strict=true on failure');
  assert(strictFail.data.failed_index === 1, 'strict mode should report failing index');

  const projectContext = await request(`/projects/context?url=${encodeURIComponent(projectUrl)}&limit=10`);
  const firstTask = (projectContext.data.tasks || []).find((task) => task.id === taskIds[0]);
  assert(firstTask?.status === 'review', 'strict rollback should keep first task in review status');

  const updateBacklogBatch = await request('/backlog', {
    method: 'PATCH',
    body: [
      {
        backlog_item_id: backlogIds[0],
        source_kind: 'batch-smoke',
        status: 'review',
      },
      {
        backlog_item_id: backlogIds[1],
        source_kind: 'batch-smoke',
        status: 'review',
      },
    ],
  });
  expectBatchSuccess(updateBacklogBatch, 'update_backlog_item batch', 2);

  const deleteBacklogPartial = await request('/backlog', {
    method: 'DELETE',
    body: [
      { backlog_item_id: backlogIds[0] },
      { backlog_item_id: invalidBacklogId },
      { backlog_item_id: backlogIds[1] },
    ],
    expectedStatuses: [207],
  });
  assert(deleteBacklogPartial.data.failed === 1, 'partial delete should fail exactly one item');
  assert(deleteBacklogPartial.data.succeeded === 2, 'partial delete should succeed in two items');

  console.log('Batch success checks: OK');
  console.log('Strict all-or-nothing rollback check: OK');
  console.log('--- Batch Smoke Completed ---');
}

runBatchSmoke().catch((error) => {
  console.error('Batch smoke failed:', error.message);
  process.exit(1);
});
