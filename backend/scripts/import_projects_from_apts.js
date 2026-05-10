const path = require('node:path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const knexFactory = require('knex');
const knexConfig = require('../knexfile');

const DEFAULT_SOURCE_BASE_URL = 'https://apts.informaticos.ar/api';
const DEFAULT_TARGET_ENV = 'test';
const DEFAULT_TOP_PROJECTS = 3;
const MAX_PROJECT_LOGS = 100;

const parseArgs = (argv) => {
  const options = {
    projects: [],
    top: null,
    targetEnv: process.env.APTS_IMPORT_TARGET_ENV || DEFAULT_TARGET_ENV,
    sourceBaseUrl: process.env.APTS_IMPORT_BASE_URL || process.env.APTS_BASE_URL || DEFAULT_SOURCE_BASE_URL,
    sourceApiKey: process.env.APTS_IMPORT_API_KEY || process.env.APTS_SOURCE_API_KEY || null,
    replace: true,
    dryRun: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--project') {
      options.projects.push(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg.startsWith('--project=')) {
      options.projects.push(arg.slice('--project='.length));
      continue;
    }

    if (arg === '--top') {
      options.top = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg.startsWith('--top=')) {
      options.top = Number(arg.slice('--top='.length));
      continue;
    }

    if (arg === '--target-env') {
      options.targetEnv = argv[index + 1] || options.targetEnv;
      index += 1;
      continue;
    }

    if (arg.startsWith('--target-env=')) {
      options.targetEnv = arg.slice('--target-env='.length) || options.targetEnv;
      continue;
    }

    if (arg === '--source-base-url') {
      options.sourceBaseUrl = argv[index + 1] || options.sourceBaseUrl;
      index += 1;
      continue;
    }

    if (arg.startsWith('--source-base-url=')) {
      options.sourceBaseUrl = arg.slice('--source-base-url='.length) || options.sourceBaseUrl;
      continue;
    }

    if (arg === '--api-key') {
      options.sourceApiKey = argv[index + 1] || options.sourceApiKey;
      index += 1;
      continue;
    }

    if (arg.startsWith('--api-key=')) {
      options.sourceApiKey = arg.slice('--api-key='.length) || options.sourceApiKey;
      continue;
    }

    if (arg === '--append') {
      options.replace = false;
      continue;
    }

    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
  }

  options.projects = options.projects.filter(Boolean);
  options.top = Number.isInteger(options.top) && options.top > 0 ? options.top : null;
  options.sourceBaseUrl = String(options.sourceBaseUrl || '').replace(/\/+$/, '');

  return options;
};

const pickProjectColumns = (project) => ({
  url: project.url,
  name: project.name,
  description: project.description ?? null,
  status: project.status,
  webhook_url: project.webhook_url ?? null,
  created_at: project.created_at,
  updated_at: project.updated_at
});

const pickTaskColumns = (task) => ({
  id: task.id,
  project_url: task.project_url,
  title: task.title,
  agent_name: task.agent_name ?? null,
  agent_email: task.agent_email ?? null,
  status: task.status,
  context: task.context ?? null,
  last_heartbeat: task.last_heartbeat ?? null,
  created_at: task.created_at,
  updated_at: task.updated_at
});

const pickBacklogColumns = (item) => ({
  id: item.id,
  project_url: item.project_url,
  title: item.title,
  description: item.description ?? null,
  acceptance_criteria: item.acceptance_criteria ?? null,
  item_type: item.item_type,
  status: item.status,
  priority: item.priority,
  sort_order: item.sort_order,
  source_kind: item.source_kind ?? null,
  source_ref: item.source_ref ?? null,
  active_task_id: item.active_task_id ?? null,
  llm_analysis_model: item.llm_analysis_model ?? null,
  llm_analysis_summary: item.llm_analysis_summary ?? null,
  llm_missing_details: Array.isArray(item.llm_missing_details)
    ? JSON.stringify(item.llm_missing_details)
    : null,
  llm_confidence: item.llm_confidence ?? null,
  llm_recommendation_status: item.llm_recommendation_status ?? null,
  llm_last_analyzed_at: item.llm_last_analyzed_at ?? null,
  bug_embedding: null,
  bug_embedding_model: null,
  bug_embedding_norm: null,
  bug_embedding_updated_at: null,
  created_at: item.created_at,
  updated_at: item.updated_at,
  deleted_at: item.deleted_at ?? null
});

const pickLogColumns = (log) => ({
  id: log.id,
  task_id: log.task_id ?? null,
  action_type: log.action_type ?? null,
  agent_name: log.agent_name ?? null,
  branch: log.branch ?? null,
  message: log.message,
  technical_details: log.technical_details ?? null,
  created_at: log.created_at,
  updated_at: log.updated_at
});

const fetchJson = async (url, headers) => {
  const response = await fetch(url, { headers });
  const text = await response.text();

  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (_error) {
    body = text;
  }

  if (!response.ok) {
    const message = typeof body === 'string'
      ? body
      : body?.error || `HTTP ${response.status}`;
    throw new Error(`${response.status} ${message}`);
  }

  return body;
};

const chunk = (items, size) => {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
};

const syncAgentLogsSequence = async (connection) => {
  if (connection.client.config.client !== 'pg') {
    return;
  }

  await connection.raw(`
    SELECT setval(
      pg_get_serial_sequence('agent_logs', 'id'),
      COALESCE((SELECT MAX(id) FROM agent_logs), 0) + 1,
      false
    )
  `);
};

const importProject = async (connection, projectBundle, { replace }) => {
  const { project, tasks, backlog, logs } = projectBundle;

  if (replace) {
    await connection('agent_logs')
      .whereIn('task_id', connection('tasks').where({ project_url: project.url }).select('id'))
      .del();
    await connection('backlog_items').where({ project_url: project.url }).del();
    await connection('tasks').where({ project_url: project.url }).del();
    await connection('projects').where({ url: project.url }).del();
  }

  await connection('projects')
    .insert(pickProjectColumns(project))
    .onConflict('url')
    .merge();

  for (const taskGroup of chunk(tasks.map(pickTaskColumns), 100)) {
    if (!taskGroup.length) continue;
    await connection('tasks')
      .insert(taskGroup)
      .onConflict('id')
      .merge();
  }

  for (const backlogGroup of chunk(backlog.map(pickBacklogColumns), 100)) {
    if (!backlogGroup.length) continue;
    await connection('backlog_items')
      .insert(backlogGroup)
      .onConflict('id')
      .merge();
  }

  for (const logGroup of chunk(logs.map(pickLogColumns), 100)) {
    if (!logGroup.length) continue;
    await connection('agent_logs')
      .insert(logGroup)
      .onConflict('id')
      .merge();
  }
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));

  if (!options.sourceApiKey) {
    throw new Error('Missing source API key. Pass --api-key or set APTS_IMPORT_API_KEY.');
  }

  const targetConfig = knexConfig[options.targetEnv];
  if (!targetConfig) {
    throw new Error(`Unknown target env '${options.targetEnv}'. Expected one of: ${Object.keys(knexConfig).join(', ')}`);
  }

  const headers = {
    Authorization: `Bearer ${options.sourceApiKey}`,
    Accept: 'application/json'
  };

  const targetDb = knexFactory(targetConfig);

  try {
    const projectsResponse = await fetchJson(`${options.sourceBaseUrl}/projects`, headers);
    const allProjects = Array.isArray(projectsResponse.projects) ? projectsResponse.projects : [];

    const selectedProjects = options.projects.length > 0
      ? options.projects.map((projectUrl) => {
        const project = allProjects.find((candidate) => candidate.url === projectUrl);
        if (!project) {
          throw new Error(`Project not found in source APTS: ${projectUrl}`);
        }
        return project;
      })
      : allProjects.slice(0, options.top || DEFAULT_TOP_PROJECTS);

    if (!selectedProjects.length) {
      throw new Error('No projects selected for import.');
    }

    const bundles = [];

    for (const project of selectedProjects) {
      const [contextPayload, backlogPayload] = await Promise.all([
        fetchJson(
          `${options.sourceBaseUrl}/projects/context?url=${encodeURIComponent(project.url)}&view=full&include=tasks,logs&limit=${MAX_PROJECT_LOGS}`,
          headers
        ),
        fetchJson(
          `${options.sourceBaseUrl}/projects/backlog?url=${encodeURIComponent(project.url)}&view=full&include_deleted=true`,
          headers
        )
      ]);

      bundles.push({
        project,
        tasks: Array.isArray(contextPayload.tasks) ? contextPayload.tasks : [],
        backlog: Array.isArray(backlogPayload.backlog) ? backlogPayload.backlog : [],
        logs: Array.isArray(contextPayload.logs) ? contextPayload.logs : []
      });
    }

    const summary = bundles.map((bundle) => ({
      project_url: bundle.project.url,
      tasks: bundle.tasks.length,
      backlog: bundle.backlog.length,
      logs: bundle.logs.length
    }));

    if (options.dryRun) {
      console.log(JSON.stringify({
        dry_run: true,
        target_env: options.targetEnv,
        replace: options.replace,
        imported_projects: summary,
        note: `bug_embedding is intentionally reset to null on import; regenerate embeddings locally for strategy tests. Logs are capped to the most recent ${MAX_PROJECT_LOGS} entries per project.`
      }, null, 2));
      return;
    }

    await targetDb.transaction(async (transaction) => {
      for (const bundle of bundles) {
        await importProject(transaction, bundle, { replace: options.replace });
      }

      await syncAgentLogsSequence(transaction);
    });

    console.log(JSON.stringify({
      imported: summary,
      target_env: options.targetEnv,
      replace: options.replace,
      note: `bug_embedding is intentionally reset to null on import; regenerate embeddings locally for strategy tests. Logs are capped to the most recent ${MAX_PROJECT_LOGS} entries per project.`
    }, null, 2));
  } finally {
    await targetDb.destroy();
  }
};

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});