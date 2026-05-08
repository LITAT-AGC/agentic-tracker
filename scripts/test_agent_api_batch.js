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

async function runCompactViewRegression({ projectUrl, backlogId, taskId }) {
  const compactBacklog = await request(`/projects/backlog?url=${encodeURIComponent(projectUrl)}`);
  const fullBacklog = await request(`/projects/backlog?url=${encodeURIComponent(projectUrl)}&view=full`);
  const fullBacklogItem = (fullBacklog.data.backlog || []).find((item) => item.id === backlogId);
  const compactBacklogItem = (compactBacklog.data.backlog || []).find((item) => item.id === backlogId);

  assert(fullBacklogItem?.description, 'full backlog view should include description');
  assert(fullBacklogItem?.acceptance_criteria, 'full backlog view should include acceptance_criteria');
  assert(compactBacklogItem?.text_excerpt, 'compact backlog view should include text_excerpt');
  assert(compactBacklogItem.description === undefined, 'compact backlog view should omit description');
  assert(compactBacklogItem.acceptance_criteria === undefined, 'compact backlog view should omit acceptance_criteria');
  assert(compactBacklogItem.has_description === true, 'compact backlog view should flag existing description');
  assert(compactBacklogItem.has_acceptance_criteria === true, 'compact backlog view should flag existing acceptance criteria');

  const compactContext = await request(`/projects/context?url=${encodeURIComponent(projectUrl)}&limit=20`);
  const fullContext = await request(`/projects/context?url=${encodeURIComponent(projectUrl)}&limit=20&view=full`);
  const fullTask = (fullContext.data.tasks || []).find((task) => task.id === taskId);
  const compactTask = (compactContext.data.tasks || []).find((task) => task.id === taskId);
  const fullDetailedLog = (fullContext.data.logs || []).find((log) => log.task_id === taskId && log.technical_details);
  const compactDetailedLog = (compactContext.data.logs || []).find((log) => log.task_id === taskId && log.has_technical_details === true);

  assert(fullTask?.context, 'full project context should include task context');
  assert(compactTask?.context_excerpt, 'compact project context should include task context excerpt');
  assert(compactTask.context === undefined, 'compact project context should omit raw task context');
  assert(compactTask.has_context === true, 'compact project context should flag existing task context');
  assert(fullDetailedLog?.technical_details, 'full project context should include technical_details when present');
  assert(compactDetailedLog?.has_technical_details === true, 'compact project context should preserve technical_details presence as a flag');
  assert(compactDetailedLog.technical_details === undefined, 'compact project context should omit raw technical_details');
}

async function runBlockerAndResumeRegression({ projectUrl, agentName, agentEmail }) {
  const createBacklog = await request('/projects/backlog', {
    method: 'POST',
    body: {
      project_url: projectUrl,
      title: 'Regression: blocker then log should work',
      description: 'Validates log insert works before and after report_blocker',
      item_type: 'bug',
      status: 'ready',
    },
    expectedStatuses: [201],
  });

  const blockerBacklogId = createBacklog.data.backlog_item?.id;
  assert(blockerBacklogId, 'regression backlog item should be created');

  const registerTask = await request('/projects/tasks', {
    method: 'POST',
    body: {
      project_url: projectUrl,
      title: 'Regression task for blocker/log flow',
      agent_name: agentName,
      agent_email: agentEmail,
      backlog_item_id: blockerBacklogId,
    },
  });

  const taskId = registerTask.data.task_id;
  assert(taskId, 'regression task should be created');

  const logBeforeBlocker = await request(`/tasks/${taskId}/logs`, {
    method: 'POST',
    body: {
      agent_name: agentName,
      branch: 'batch/regression-blocker-log',
      message: 'regression log before blocker',
      technical_details: {
        phase: 'before_blocker',
        outcome: 'success',
      },
    },
  });
  assert(logBeforeBlocker.data.success === true, 'log before blocker should succeed');

  const blocker = await request('/projects/blockers', {
    method: 'POST',
    body: {
      project_url: projectUrl,
      task_id: taskId,
      error_message: 'regression blocker to validate agent_logs inserts',
      agent_name: agentName,
    },
  });
  assert(blocker.data.success === true, 'report_blocker should succeed');

  const logAfterBlocker = await request(`/tasks/${taskId}/logs`, {
    method: 'POST',
    body: {
      agent_name: agentName,
      branch: 'batch/regression-blocker-log',
      message: 'regression log after blocker',
      technical_details: {
        phase: 'after_blocker',
        outcome: 'success',
      },
    },
  });
  assert(logAfterBlocker.data.success === true, 'log after blocker should succeed');

  const createResumeBacklog = await request('/projects/backlog', {
    method: 'POST',
    body: {
      project_url: projectUrl,
      title: 'Regression: register_task resumes same task',
      description: 'Validates register_task with backlog_item_id resumes stalled task',
      item_type: 'chore',
      status: 'ready',
    },
    expectedStatuses: [201],
  });

  const resumeBacklogId = createResumeBacklog.data.backlog_item?.id;
  assert(resumeBacklogId, 'resume regression backlog item should be created');

  const registerResume1 = await request('/projects/tasks', {
    method: 'POST',
    body: {
      project_url: projectUrl,
      title: 'Regression resume first register',
      agent_name: agentName,
      agent_email: agentEmail,
      backlog_item_id: resumeBacklogId,
    },
  });
  const firstTaskId = registerResume1.data.task_id;
  assert(firstTaskId, 'first register for resume regression should return task_id');

  const blockerForResume = await request('/projects/blockers', {
    method: 'POST',
    body: {
      project_url: projectUrl,
      task_id: firstTaskId,
      error_message: 'regression blocker before resume',
      agent_name: agentName,
    },
  });
  assert(blockerForResume.data.success === true, 'blocker before resume should succeed');

  const registerResume2 = await request('/projects/tasks', {
    method: 'POST',
    body: {
      project_url: projectUrl,
      title: 'Regression resume second register',
      agent_name: agentName,
      agent_email: agentEmail,
      backlog_item_id: resumeBacklogId,
    },
  });

  assert(registerResume2.data.resumed === true, 'second register should resume existing task');
  assert(registerResume2.data.previous_status === 'stalled', 'resumed task previous_status should be stalled');
  assert(registerResume2.data.task_id === firstTaskId, 'second register should return the same task_id');

  const logAfterResume = await request(`/tasks/${registerResume2.data.task_id}/logs`, {
    method: 'POST',
    body: {
      agent_name: agentName,
      branch: 'batch/regression-resume',
      message: 'regression log after resume',
      technical_details: {
        phase: 'after_resume',
        outcome: 'success',
      },
    },
  });
  assert(logAfterResume.data.success === true, 'log after resume should succeed');
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
        description: 'Created from batch smoke test with a detailed description to validate compact response pruning.',
        acceptance_criteria: 'The compact response should keep only summary fields and omit the full description and acceptance criteria payloads.',
        item_type: 'feature',
      },
      {
        project_url: projectUrl,
        title: 'Batch Backlog Item 2',
        description: 'Created from batch smoke test with additional detail to validate compact list responses.',
        acceptance_criteria: 'The second backlog item should also support compact summary output.',
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
        context: 'Detailed task context for compact response validation on task payloads.',
        backlog_item_id: backlogIds[0],
      },
      {
        project_url: projectUrl,
        title: 'Batch Task 2',
        agent_name: agentName,
        agent_email: agentEmail,
        context: 'Second detailed task context for compact response validation.',
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
        technical_details: {
          commands_run: ['node scripts/test_agent_api_batch.js'],
          outcome: 'success',
        },
      },
      {
        task_id: taskIds[1],
        project_url: projectUrl,
        agent_name: agentName,
        branch: 'batch/smoke-2',
        message: 'batch log entry 2',
        technical_details: {
          commands_run: ['node scripts/test_agent_api_batch.js'],
          outcome: 'success',
        },
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

  await runCompactViewRegression({
    projectUrl,
    backlogId: backlogIds[0],
    taskId: taskIds[0],
  });

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

  await runBlockerAndResumeRegression({ projectUrl, agentName, agentEmail });

  console.log('Batch success checks: OK');
  console.log('Strict all-or-nothing rollback check: OK');
  console.log('Blocker/log and resume regressions: OK');
  console.log('--- Batch Smoke Completed ---');
}

runBatchSmoke().catch((error) => {
  console.error('Batch smoke failed:', error.message);
  process.exit(1);
});
