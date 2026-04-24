require('dotenv').config();
const express = require('express');
const cors = require('cors');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const knexConfig = require('./knexfile');
const db = require('knex')(knexConfig[process.env.NODE_ENV || 'development']);

const app = express();
app.set('trust proxy', 1);

app.use(express.json());
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
    maxAge: 1000 * 60 * 60 * 24
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
  console.log(`Backend running on port ${PORT}`);
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
      console.log(`[Job] Marked ${updated} tasks as stalled.`);
    }
  } catch (error) {
    console.error('[Job Error]', error);
  }
}, 60 * 1000); // Check every minute

