const path = require('node:path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const knexFactory = require('knex');
const knexConfig = require('../knexfile');
const {
  createContentHash,
  normalizeTextField,
  requestEmbedding,
  buildBugEmbeddingText
} = require('./lib/semantic_embeddings');
const {
  buildBacklogCoverageDocument,
  inferCoverageState
} = require('./lib/semantic_documents');

const DEFAULT_TARGET_ENV = process.env.APTS_SEMANTIC_TARGET_ENV || 'test';
const DEFAULT_TASK_LOG_LIMIT = 5;
const SUPPORTED_STRATEGIES = new Set(['bug_dedup', 'backlog_functional_coverage', 'task_log_evidence']);

const parseArgs = (argv) => {
  const options = {
    targetEnv: DEFAULT_TARGET_ENV,
    strategy: 'backlog_functional_coverage',
    projects: [],
    limit: null,
    dryRun: false,
    documentsOnly: false,
    force: false,
    taskLogLimit: DEFAULT_TASK_LOG_LIMIT
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--strategy') {
      options.strategy = argv[index + 1] || options.strategy;
      index += 1;
      continue;
    }

    if (arg.startsWith('--strategy=')) {
      options.strategy = arg.slice('--strategy='.length) || options.strategy;
      continue;
    }

    if (arg === '--project') {
      options.projects.push(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg.startsWith('--project=')) {
      options.projects.push(arg.slice('--project='.length));
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

    if (arg === '--limit') {
      options.limit = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg.startsWith('--limit=')) {
      options.limit = Number(arg.slice('--limit='.length));
      continue;
    }

    if (arg === '--task-log-limit') {
      options.taskLogLimit = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg.startsWith('--task-log-limit=')) {
      options.taskLogLimit = Number(arg.slice('--task-log-limit='.length));
      continue;
    }

    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }

    if (arg === '--documents-only') {
      options.documentsOnly = true;
      continue;
    }

    if (arg === '--force') {
      options.force = true;
      continue;
    }
  }

  options.projects = options.projects.filter(Boolean);
  options.limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : null;
  options.taskLogLimit = Number.isInteger(options.taskLogLimit) && options.taskLogLimit > 0
    ? options.taskLogLimit
    : DEFAULT_TASK_LOG_LIMIT;

  return options;
};

const compactJson = (value) => JSON.stringify(value);

const buildBugDedupDocument = (item) => {
  const title = normalizeTextField(item.title);
  const content = buildBugEmbeddingText(item);
  const metadata = {
    backlog_item_id: item.id,
    item_type: item.item_type,
    operational_status: item.status,
    source_kind: normalizeTextField(item.source_kind) || null,
    source_ref: normalizeTextField(item.source_ref) || null
  };

  return {
    project_url: item.project_url,
    strategy_key: 'bug_dedup',
    scope_key: `backlog_item:${item.id}`,
    source_type: 'backlog_item',
    source_id: item.id,
    title,
    content,
    document_metadata: metadata,
    content_hash: createContentHash(compactJson({ title, content, metadata }))
  };
};

const buildTaskLogEvidenceDocument = (task, logs) => {
  const title = normalizeTextField(task.title);
  const context = normalizeTextField(task.context);
  const linkedBacklogTitle = normalizeTextField(task.linked_backlog_title);
  const formattedLogs = logs
    .map((log) => {
      const message = normalizeTextField(log.message);
      const details = log.technical_details ? compactJson(log.technical_details) : '';
      return [
        log.action_type ? `accion=${log.action_type}` : '',
        log.agent_name ? `agente=${log.agent_name}` : '',
        message ? `mensaje=${message}` : '',
        details ? `detalles=${details}` : ''
      ].filter(Boolean).join(' | ');
    })
    .filter(Boolean);

  const metadata = {
    task_id: task.id,
    operational_status: task.status,
    linked_backlog_item_id: task.linked_backlog_item_id || null,
    linked_backlog_title: linkedBacklogTitle || null,
    log_count: logs.length
  };

  const content = truncateText([
    'estrategia: task_log_evidence',
    title ? `titulo_tarea: ${title}` : '',
    `estado_operativo: ${task.status}`,
    task.agent_name ? `agente: ${task.agent_name}` : '',
    context ? `contexto: ${context}` : '',
    linkedBacklogTitle ? `backlog_relacionado: ${linkedBacklogTitle}` : '',
    formattedLogs.length ? `evidencia_logs:\n${formattedLogs.join('\n')}` : ''
  ].filter(Boolean).join('\n\n'));

  return {
    project_url: task.project_url,
    strategy_key: 'task_log_evidence',
    scope_key: `task:${task.id}`,
    source_type: 'task',
    source_id: task.id,
    title,
    content,
    document_metadata: metadata,
    content_hash: createContentHash(compactJson({ title, content, metadata }))
  };
};

const buildBacklogBaseQuery = (connection, options) => {
  const query = connection('backlog_items as bi')
    .leftJoin('tasks as t', 't.id', 'bi.active_task_id')
    .select(
      'bi.id',
      'bi.project_url',
      'bi.title',
      'bi.description',
      'bi.acceptance_criteria',
      'bi.item_type',
      'bi.status',
      'bi.priority',
      'bi.source_kind',
      'bi.source_ref',
      'bi.active_task_id',
      't.title as active_task_title',
      't.context as active_task_context',
      't.status as active_task_status'
    )
    .whereNull('bi.deleted_at')
    .orderBy('bi.updated_at', 'desc');

  if (options.projects.length) {
    query.whereIn('bi.project_url', options.projects);
  }

  if (options.limit) {
    query.limit(options.limit);
  }

  return query;
};

const loadBugDedupDocuments = async (connection, options) => {
  const rows = await buildBacklogBaseQuery(connection, options)
    .where({ 'bi.item_type': 'bug' });

  return rows
    .map(buildBugDedupDocument)
    .filter((document) => Boolean(document.content));
};

const loadBacklogCoverageDocuments = async (connection, options) => {
  const rows = await buildBacklogBaseQuery(connection, options);

  return rows
    .map(buildBacklogCoverageDocument)
    .filter((document) => Boolean(document.content));
};

const loadTaskLogEvidenceDocuments = async (connection, options) => {
  const taskQuery = connection('tasks as t')
    .leftJoin('backlog_items as bi', 'bi.active_task_id', 't.id')
    .select(
      't.id',
      't.project_url',
      't.title',
      't.agent_name',
      't.status',
      't.context',
      'bi.id as linked_backlog_item_id',
      'bi.title as linked_backlog_title'
    )
    .orderBy('t.updated_at', 'desc');

  if (options.projects.length) {
    taskQuery.whereIn('t.project_url', options.projects);
  }

  if (options.limit) {
    taskQuery.limit(options.limit);
  }

  const tasks = await taskQuery;
  const taskIds = tasks.map((task) => task.id);
  const logsByTaskId = new Map();

  if (taskIds.length) {
    const logs = await connection('agent_logs')
      .whereIn('task_id', taskIds)
      .orderBy('created_at', 'desc')
      .select('id', 'task_id', 'action_type', 'agent_name', 'message', 'technical_details', 'created_at');

    for (const log of logs) {
      const existing = logsByTaskId.get(log.task_id) || [];
      if (existing.length < options.taskLogLimit) {
        existing.push(log);
        logsByTaskId.set(log.task_id, existing);
      }
    }
  }

  return tasks
    .map((task) => buildTaskLogEvidenceDocument(task, logsByTaskId.get(task.id) || []))
    .filter((document) => Boolean(document.content));
};

const loadDocumentsForStrategy = async (connection, options) => {
  switch (options.strategy) {
    case 'bug_dedup':
      return loadBugDedupDocuments(connection, options);
    case 'backlog_functional_coverage':
      return loadBacklogCoverageDocuments(connection, options);
    case 'task_log_evidence':
      return loadTaskLogEvidenceDocuments(connection, options);
    default:
      throw new Error(`Unsupported strategy '${options.strategy}'`);
  }
};

const upsertDocument = async (connection, document) => {
  const [savedDocument] = await connection('semantic_documents')
    .insert({
      ...document,
      created_at: connection.fn.now(),
      updated_at: connection.fn.now()
    })
    .onConflict(['project_url', 'strategy_key', 'scope_key'])
    .merge({
      source_type: document.source_type,
      source_id: document.source_id,
      title: document.title,
      content: document.content,
      document_metadata: document.document_metadata,
      content_hash: document.content_hash,
      updated_at: connection.fn.now()
    })
    .returning(['id', 'content_hash']);

  return savedDocument;
};

const shouldSkipEmbedding = (existingEmbedding, document, options) => {
  if (!existingEmbedding) {
    return false;
  }

  if (options.force) {
    return false;
  }

  return existingEmbedding.generated_from_hash === document.content_hash;
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  if (!SUPPORTED_STRATEGIES.has(options.strategy)) {
    throw new Error(`Unsupported strategy '${options.strategy}'. Expected one of: ${[...SUPPORTED_STRATEGIES].join(', ')}`);
  }

  const targetConfig = knexConfig[options.targetEnv];
  if (!targetConfig) {
    throw new Error(`Unknown target env '${options.targetEnv}'. Expected one of: ${Object.keys(knexConfig).join(', ')}`);
  }

  const db = knexFactory(targetConfig);

  try {
    const documents = await loadDocumentsForStrategy(db, options);

    if (options.dryRun) {
      console.log(JSON.stringify({
        dry_run: true,
        target_env: options.targetEnv,
        strategy: options.strategy,
        selected: documents.length,
        projects: options.projects,
        limit: options.limit,
        documents_only: options.documentsOnly,
        sample: documents.slice(0, 5).map((document) => ({
          project_url: document.project_url,
          scope_key: document.scope_key,
          title: document.title,
          content_excerpt: document.content.slice(0, 240),
          metadata: document.document_metadata
        }))
      }, null, 2));
      return;
    }

    let upsertedDocuments = 0;
    let embeddedDocuments = 0;
    let skippedEmbeddings = 0;

    for (const document of documents) {
      const savedDocument = await upsertDocument(db, document);
      upsertedDocuments += 1;

      if (options.documentsOnly) {
        continue;
      }

      const existingEmbedding = await db('semantic_document_embeddings')
        .where({ semantic_document_id: savedDocument.id, strategy_key: document.strategy_key })
        .orderBy('updated_at', 'desc')
        .first('id', 'embedding_model', 'generated_from_hash');

      if (shouldSkipEmbedding(existingEmbedding, document, options)) {
        skippedEmbeddings += 1;
        continue;
      }

      const embeddingResult = await requestEmbedding(db, document.strategy_key, document.content, {
        usageType: `semantic_document:${document.strategy_key}`,
        projectUrl: document.project_url,
        backlogItemId: document.source_type === 'backlog_item' ? document.source_id : null
      });

      await db('semantic_document_embeddings')
        .insert({
          semantic_document_id: savedDocument.id,
          strategy_key: document.strategy_key,
          embedding_model: embeddingResult.model,
          embedding: JSON.stringify(embeddingResult.embedding),
          embedding_norm: embeddingResult.norm,
          generated_from_hash: document.content_hash,
          embedded_at: db.fn.now(),
          created_at: db.fn.now(),
          updated_at: db.fn.now()
        })
        .onConflict(['semantic_document_id', 'embedding_model'])
        .merge({
          strategy_key: document.strategy_key,
          embedding: JSON.stringify(embeddingResult.embedding),
          embedding_norm: embeddingResult.norm,
          generated_from_hash: document.content_hash,
          embedded_at: db.fn.now(),
          updated_at: db.fn.now()
        });

      embeddedDocuments += 1;
    }

    console.log(JSON.stringify({
      target_env: options.targetEnv,
      strategy: options.strategy,
      processed_documents: documents.length,
      upserted_documents: upsertedDocuments,
      embedded_documents: embeddedDocuments,
      skipped_embeddings: skippedEmbeddings,
      projects: options.projects,
      limit: options.limit,
      documents_only: options.documentsOnly,
      force: options.force
    }, null, 2));
  } finally {
    await db.destroy();
  }
};

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});