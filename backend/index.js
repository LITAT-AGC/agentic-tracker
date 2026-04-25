require('dotenv').config();
const fs = require('node:fs/promises');
const path = require('node:path');
const express = require('express');
const cors = require('cors');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const pino = require('pino');
const pinoHttp = require('pino-http');
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
  : ['http://localhost:5173', 'http://localhost:46101'];

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
const BACKLOG_STATUSES = ['draft', 'ready', 'in_progress', 'review', 'blocked', 'done', 'archived'];

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

const ensureProjectExists = async (url) => {
  await db('projects').insert({ url, name: url.split('/').pop() })
    .onConflict('url').merge();
};

const listBacklogItems = async (projectUrl, status) => {
  const query = db('backlog_items')
    .where({ project_url: projectUrl })
    .orderBy([
      { column: 'priority', order: 'asc' },
      { column: 'sort_order', order: 'asc' },
      { column: 'created_at', order: 'asc' }
    ]);

  if (status) {
    query.andWhere({ status });
  }

  return query.select('*');
};

const getBacklogPayload = (body, { partial = false } = {}) => {
  const payload = {};

  if (!partial || Object.prototype.hasOwnProperty.call(body, 'title')) {
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!partial && !title) {
      return { error: 'Title is required' };
    }
    if (title) {
      payload.title = title;
    } else if (!partial && !title) {
      return { error: 'Title is required' };
    }
  }

  if (Object.prototype.hasOwnProperty.call(body, 'description')) {
    payload.description = body.description || null;
  }

  if (Object.prototype.hasOwnProperty.call(body, 'acceptance_criteria')) {
    payload.acceptance_criteria = body.acceptance_criteria || null;
  }

  if (Object.prototype.hasOwnProperty.call(body, 'item_type')) {
    if (!BACKLOG_ITEM_TYPES.includes(body.item_type)) {
      return { error: 'Invalid backlog item type' };
    }
    payload.item_type = body.item_type;
  }

  if (Object.prototype.hasOwnProperty.call(body, 'status')) {
    if (!BACKLOG_STATUSES.includes(body.status)) {
      return { error: 'Invalid backlog status' };
    }
    payload.status = body.status;
  }

  if (Object.prototype.hasOwnProperty.call(body, 'priority')) {
    const priority = Number.parseInt(body.priority, 10);
    if (Number.isNaN(priority)) {
      return { error: 'Priority must be an integer' };
    }
    payload.priority = priority;
  }

  if (Object.prototype.hasOwnProperty.call(body, 'sort_order')) {
    const sortOrder = Number.parseInt(body.sort_order, 10);
    if (Number.isNaN(sortOrder)) {
      return { error: 'Sort order must be an integer' };
    }
    payload.sort_order = sortOrder;
  }

  if (Object.prototype.hasOwnProperty.call(body, 'source_kind')) {
    payload.source_kind = body.source_kind || null;
  }

  if (Object.prototype.hasOwnProperty.call(body, 'source_ref')) {
    payload.source_ref = body.source_ref || null;
  }

  if (Object.prototype.hasOwnProperty.call(body, 'active_task_id')) {
    payload.active_task_id = body.active_task_id || null;
  }

  return { payload };
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
const integrationManifestSchemaVersion = '1.6.0';
const publicIntegrationBasePath = '/api/public/integrar';
const integrationManifestReleaseNotes = [
  {
    version: '1.6.0',
    date: '2026-04-25',
    changes: [
      'La plantilla de Orquestador ahora se publica como orquestador.agent.md para compatibilidad con deteccion de custom agents en VS Code.',
      'Se mantiene una ruta legacy para descargas antiguas de orquestador-agent.md.'
    ]
  },
  {
    version: '1.5.0',
    date: '2026-04-25',
    changes: [
      'El manifiesto ahora publica clientes HTTP separados para CommonJS y ESM.',
      'Cada artefacto declara cuando usarlo segun la configuracion de modulos del proyecto Node.js.'
    ]
  },
  {
    version: '1.4.0',
    date: '2026-04-25',
    changes: [
      'Se agrega bootstrap.manifest_updates para publicar novedades por version del manifiesto.',
      'La version actual del manifiesto queda referenciada en bootstrap.manifest_updates.current_version.'
    ]
  },
  {
    version: '1.3.0',
    date: '2026-04-25',
    changes: [
      'Se incorpora guidance de bitacora local append-only de resiliencia y su politica de no ser fuente de verdad.',
      'Se amplian reglas de bootstrap para migracion desde tracking local y manejo de APTS_API_KEY.'
    ]
  }
];
const integrationArtifacts = {
  skills_json: {
    route: `${publicIntegrationBasePath}/skills.json`,
    filePath: path.join(integrationRoot, 'paquete-apts', 'apts_skills.json'),
    fileName: 'apts_skills.json',
    contentType: 'application/json; charset=utf-8',
    kind: 'skills_contract',
    recommended: true,
    description: 'Machine-readable tool contract for APTS integration.'
  },
  skill_markdown: {
    route: `${publicIntegrationBasePath}/skill.md`,
    filePath: path.join(integrationRoot, 'paquete-apts', 'SKILL.md'),
    fileName: 'SKILL.md',
    contentType: 'text/markdown; charset=utf-8',
    kind: 'skill_package',
    recommended: false,
    description: 'Copilot skill packaging guide for APTS integration.'
  },
  agent_guidelines: {
    route: `${publicIntegrationBasePath}/agent-guidelines.md`,
    filePath: path.join(integrationRoot, 'paquete-apts', 'apts-agent-guidelines.md'),
    fileName: 'apts-agent-guidelines.md',
    contentType: 'text/markdown; charset=utf-8',
    kind: 'agent_guidelines',
    recommended: true,
    description: 'Base operating rules for any agent that reports work to APTS.'
  },
  executor_agent: {
    route: `${publicIntegrationBasePath}/agentes/ejecutor-dev-test-commit.agent.md`,
    filePath: path.join(integrationRoot, 'plantillas-agentes', 'ejecutor-dev-test-commit.agent.md'),
    fileName: 'ejecutor-dev-test-commit.agent.md',
    contentType: 'text/markdown; charset=utf-8',
    kind: 'agent_template',
    recommended: false,
    description: 'Worker agent template for one backlog item end-to-end.'
  },
  orchestrator_agent: {
    route: `${publicIntegrationBasePath}/agentes/orquestador.agent.md`,
    filePath: path.join(integrationRoot, 'plantillas-agentes', 'orquestador.agent.md'),
    fileName: 'orquestador.agent.md',
    contentType: 'text/markdown; charset=utf-8',
    kind: 'agent_template',
    recommended: false,
    description: 'Orchestrator agent template that pulls ready backlog items from APTS.'
  },
  js_client_commonjs: {
    route: `${publicIntegrationBasePath}/apts-client.js`,
    filePath: path.join(integrationRoot, 'paquete-apts', 'apts-client.js'),
    fileName: 'apts-client.js',
    contentType: 'application/javascript; charset=utf-8',
    kind: 'reference_client',
    recommended: false,
    optional: true,
    module_system: 'commonjs',
    selection_rule: 'Use this file when the client project runs Node.js in CommonJS mode, typically with require(...) and without type=module in package.json.',
    description: 'Optional JavaScript HTTP client for CommonJS runtimes.'
  },
  js_client_esm: {
    route: `${publicIntegrationBasePath}/apts-client.mjs`,
    filePath: path.join(integrationRoot, 'paquete-apts', 'apts-client.mjs'),
    fileName: 'apts-client.mjs',
    contentType: 'application/javascript; charset=utf-8',
    kind: 'reference_client',
    recommended: false,
    optional: true,
    module_system: 'esm',
    selection_rule: 'Use this file when the client project runs Node.js in ESM mode, typically with import/export or type=module in package.json.',
    description: 'Optional JavaScript HTTP client for ESM runtimes.'
  }
};

const buildAbsoluteUrl = (req, route) => `${req.protocol}://${req.get('host')}${route}`;

const buildIntegrationManifest = (req) => ({
  service: 'APTS',
  version: rootPackage.version,
  schema_version: integrationManifestSchemaVersion,
  integration_mode: 'agent',
  bootstrap: {
    manifest_updates: {
      current_version: integrationManifestSchemaVersion,
      notes: integrationManifestReleaseNotes
    },
    summary: 'APTS centraliza el tracking operativo de proyectos ejecutados por agentes y debe convertirse en la fuente de verdad del backlog y de la ejecucion.',
    service_purpose: 'Usa APTS para registrar backlog, tareas en ejecucion, bloqueos, heartbeats y logs tecnicos en una API REST orientada a automatizacion.',
    source_of_truth: 'Una vez iniciada la integracion, backlog_items y tasks en APTS deben reemplazar mirrors o checklists locales como tracking operativo principal.',
    migration_goal: 'Si el proyecto todavia gestiona backlog o tracking en archivos locales, leelos primero y migra o sincroniza esos items hacia APTS antes de continuar el trabajo normal.',
    local_tracking_inputs: [
      'archivos markdown de backlog',
      'planes de proyecto o roadmaps locales',
      'todo lists o mirrors historicos del tracking',
      'documentos de alcance o criterios de aceptacion existentes'
    ],
    access_model: {
      bootstrap: 'public',
      agent_api: 'bearer_token_required'
    },
    credential_bootstrap: {
      required_secret: 'APTS_API_KEY',
      how_to_obtain: 'Si APTS_API_KEY no esta disponible en el entorno del proyecto, solicitala explicitamente al operador humano o responsable de la integracion antes de intentar llamadas protegidas.',
      missing_secret_behavior: 'No intentes register_task, read_project_context ni ninguna otra llamada protegida hasta recibir APTS_API_KEY.',
      storage_recommendation: 'Aloja APTS_API_KEY como variable de entorno o en el sistema de secretos del proyecto cliente. No la hardcodees en codigo, prompts versionados, archivos JSON ni documentos de backlog.',
      companion_env: 'Configura tambien APTS_BASE_URL con la URL base publicada por este manifiesto.'
    },
    client_download_guidance: {
      decision_input: 'Revisa la configuracion de modulos del proyecto Node.js cliente antes de descargar el cliente HTTP.',
      choose_commonjs_when: [
        'el proyecto usa require(...)',
        'package.json no declara type=module',
        'el runtime espera archivos .js tratados como CommonJS'
      ],
      choose_esm_when: [
        'el proyecto usa import/export',
        'package.json declara type=module',
        'el runtime espera archivos .mjs o modulos ESM'
      ],
      default_rule: 'Si hay duda, inspecciona package.json y el codigo del proyecto cliente antes de elegir el artefacto.'
    },
    local_resilience_log: {
      required: true,
      source_of_truth: false,
      purpose: 'Mantener una bitacora local append-only de resiliencia por si APTS queda inaccesible o perdiera historial, sin reemplazar a APTS como tracking operativo principal.',
      recommended_path: '.apts/agent-resilience-log.jsonl',
      format: 'jsonl',
      write_on: [
        'inicio de ejecucion',
        'hitos importantes',
        'bloqueos',
        'fallos de sincronizacion con APTS',
        'cierre de tarea'
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
      replay_policy: 'Si APTS no esta disponible, conserva la bitacora local y sincroniza luego los hitos relevantes cuando el servicio vuelva. No uses la bitacora para repriorizar ni como estado operativo oficial.',
      forbidden_content: ['APTS_API_KEY', 'otros secretos', 'tokens', 'credenciales']
    },
    recommended_first_steps: [
      'Resuelve la identidad del proyecto y del agente desde Git local.',
      'Si APTS_API_KEY no existe todavia en el entorno, solicitala al operador y alojala como secreto antes de usar la API protegida.',
      'Prepara una bitacora local append-only de resiliencia, por ejemplo en .apts/agent-resilience-log.jsonl, sin tratarla como fuente de verdad.',
      'Inspecciona los archivos locales que hoy contengan backlog, plan o tracking operativo.',
      'Crea o actualiza backlog_items en APTS para reflejar ese estado inicial.',
      'A partir de ese momento usa APTS como sistema principal de seguimiento y no inventes trabajo fuera de APTS.'
    ],
    operator_prompt_template: 'Lee este manifiesto publico, entiende que APTS es la fuente de verdad del tracking, solicita APTS_API_KEY al operador si no esta disponible, alojala como secreto del proyecto cliente, prepara una bitacora local append-only de resiliencia y despues revisa los archivos locales de backlog para migrar o sincronizar esos items hacia APTS antes de continuar la ejecucion normal.'
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
      recommended_locations: ['environment_variables', 'project_secret_store'],
      avoid: ['hardcoded_source_files', 'tracked_prompt_files', 'versioned_json_contracts', 'backlog_documents']
    }
  },
  instructions: [
    'Read the bootstrap section first to understand the service purpose and the migration goal from local tracking to APTS.',
    'If APTS_API_KEY is missing, request it from the operator before any protected API call and store it as an environment secret.',
    'Maintain the local resilience log described in the bootstrap section; it is append-only and must not replace APTS as the source of truth.',
    'Download and install the skills contract first.',
    'Read the base agent guidelines before the first APTS API call.',
    'Choose the reference client that matches the client project module system: apts-client.js for CommonJS or apts-client.mjs for ESM.',
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
    description: artifact.description,
    recommended: artifact.recommended,
    optional: artifact.optional || false,
    module_system: artifact.module_system || null,
    selection_rule: artifact.selection_rule || null,
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
app.get(`${publicIntegrationBasePath}/agentes/ejecutor-dev-test-commit.agent.md`, async (req, res) => sendIntegrationArtifact(req, res, 'executor_agent'));
app.get(`${publicIntegrationBasePath}/agentes/orquestador.agent.md`, async (req, res) => sendIntegrationArtifact(req, res, 'orchestrator_agent'));
app.get(`${publicIntegrationBasePath}/agentes/orquestador-agent.md`, async (req, res) => sendIntegrationArtifact(req, res, 'orchestrator_agent'));
app.get(`${publicIntegrationBasePath}/apts-client.js`, async (req, res) => sendIntegrationArtifact(req, res, 'js_client_commonjs'));
app.get(`${publicIntegrationBasePath}/apts-client.mjs`, async (req, res) => sendIntegrationArtifact(req, res, 'js_client_esm'));

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
  const { project_url, title, agent_name, agent_email, context, backlog_item_id } = req.body;
  const url = normalizeUrl(project_url);

  try {
    await ensureProjectExists(url);

    const [task] = await db('tasks').insert({
      project_url: url,
      title,
      agent_name,
      agent_email,
      context,
      status: 'in_progress'
    }).returning('*');

    if (backlog_item_id) {
      await db('backlog_items')
        .where({ id: backlog_item_id, project_url: url })
        .update({
          status: 'in_progress',
          active_task_id: task.id,
          updated_at: db.fn.now()
        });
    }

    res.json({ task_id: task.id, status: task.status, backlog_item_id: backlog_item_id || null });
  } catch (error) {
    res.status(500).json({ error: error.message });
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

  if (!url) {
    return res.status(400).json({ error: 'Project url is required' });
  }

  if (status && !BACKLOG_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'Invalid backlog status' });
  }

  try {
    const backlog = await listBacklogItems(url, status);
    res.json({ backlog });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Skill 1c: create_backlog_item
app.post('/api/projects/backlog', apiLimiter, authenticateAgent, async (req, res) => {
  const { project_url } = req.body;
  const url = normalizeUrl(project_url);
  const { payload, error } = getBacklogPayload(req.body);

  if (!url) {
    return res.status(400).json({ error: 'Project url is required' });
  }

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

    res.status(201).json({ backlog_item: backlogItem });
  } catch (routeError) {
    res.status(500).json({ error: routeError.message });
  }
});

// Skill 1d: update_backlog_item
app.patch('/api/backlog/:id', apiLimiter, authenticateAgent, async (req, res) => {
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
      .update({
        ...payload,
        updated_at: db.fn.now()
      })
      .returning('*');

    if (!backlogItem) {
      return res.status(404).json({ error: 'Backlog item not found' });
    }

    res.json({ backlog_item: backlogItem });
  } catch (routeError) {
    res.status(500).json({ error: routeError.message });
  }
});

// Skill 2: update_task_status
app.patch('/api/tasks/:id/status', apiLimiter, authenticateAgent, async (req, res) => {
  const { status, project_url, agent_name, agent_email } = req.body;
  try {
    await db('tasks').where({ id: req.params.id }).update({ status });

    const linkedBacklogStatus = mapTaskStatusToBacklogStatus(status);
    if (linkedBacklogStatus) {
      const backlogUpdate = {
        status: linkedBacklogStatus,
        updated_at: db.fn.now()
      };

      if (status === 'done') {
        backlogUpdate.active_task_id = null;
      }

      await db('backlog_items')
        .where({ active_task_id: req.params.id })
        .update(backlogUpdate);
    }

    await notifyWebhook(project_url, {
      event: 'task_status_updated',
      task_id: req.params.id,
      status,
      agent_name
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Skill 3: log_agent_progress
app.post('/api/tasks/:id/logs', apiLimiter, authenticateAgent, async (req, res) => {
  const { project_url, agent_name, branch, message, technical_details } = req.body;
  try {
    const [log] = await db('agent_logs').insert({
      task_id: req.params.id,
      agent_name,
      branch,
      message,
      technical_details: technical_details ? JSON.stringify(technical_details) : null
    }).returning('*');
    res.json({ success: true, log });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Skill 4: report_blocker
app.post('/api/projects/blockers', apiLimiter, authenticateAgent, async (req, res) => {
  const { project_url, task_id, error_message, agent_name } = req.body;
  const url = normalizeUrl(project_url);
  try {
    await db('projects').where({ url }).update({ status: 'blocked' });
    await db('backlog_items')
      .where({ active_task_id: task_id })
      .update({ status: 'blocked', updated_at: db.fn.now() });
    await db('agent_logs').insert({
      task_id,
      agent_name,
      message: 'BLOCKER REPORTED: ' + error_message,
      action_type: 'error'
    });
    await notifyWebhook(url, {
      event: 'project_blocked',
      task_id,
      error_message,
      agent_name
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Skill 5: heartbeat
app.post('/api/tasks/:id/heartbeat', apiLimiter, authenticateAgent, async (req, res) => {
  try {
    await db('tasks').where({ id: req.params.id }).update({ last_heartbeat: db.fn.now() });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
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
    const projects = await db('projects').select('*').orderBy('updated_at', 'desc');
    res.json({ projects });
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
    const backlog = await listBacklogItems(url);
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
    const backlog = await listBacklogItems(url, req.query.status);
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

    res.status(201).json({ backlog_item: backlogItem });
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
      .update({
        ...payload,
        updated_at: db.fn.now()
      })
      .returning('*');

    if (!backlogItem) {
      return res.status(404).json({ error: 'Backlog item not found' });
    }

    res.json({ backlog_item: backlogItem });
  } catch (routeError) {
    res.status(500).json({ error: routeError.message });
  }
});

app.post('/api/tasks/:id/resolve', requireAuth, async (req, res) => {
  const { instruction } = req.body;
  try {
    const task = await db('tasks').where({ id: req.params.id }).first();
    if (!task) return res.status(404).json({ error: 'Task not found' });

    // Append the instruction to the context
    const newContext = task.context ? `${task.context}\n\n[Human Unblock]: ${instruction}` : `[Human Unblock]: ${instruction}`;

    await db('tasks').where({ id: req.params.id }).update({
      status: 'todo',
      context: newContext
    });

    await db('backlog_items')
      .where({ active_task_id: req.params.id })
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

const PORT = process.env.PORT || 46100;
app.listen(PORT, () => {
  logger.info({ port: PORT }, 'Backend running');
});

// Internal Job: Detect stalled tasks
setInterval(async () => {
  try {
    const fifteenMinsAgo = new Date(Date.now() - 15 * 60 * 1000);
    const updated = await db('tasks')
      .where('status', 'in_progress')
      .andWhere('last_heartbeat', '<', fifteenMinsAgo)
      .update({ status: 'stalled' });

    if (updated > 0) {
      logger.warn({ updated }, 'Job marked tasks as stalled');
    }
  } catch (error) {
    logger.error({ err: error }, 'Job Error');
  }
}, 60 * 1000); // Check every minute

