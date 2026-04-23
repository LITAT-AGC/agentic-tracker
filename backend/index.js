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

// Skill 0: register_task
app.post('/api/projects/tasks', apiLimiter, authenticateAgent, async (req, res) => {
  const { project_url, title, agent_name, agent_email, context } = req.body;
  const url = normalizeUrl(project_url);
  
  try {
    // Upsert project
    await db('projects').insert({ url, name: url.split('/').pop() })
      .onConflict('url').merge();
      
    const [task] = await db('tasks').insert({
      project_url: url,
      title,
      agent_name,
      agent_email,
      context,
      status: 'in_progress'
    }).returning('*');
    
    res.json({ task_id: task.id, status: task.status });
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
    const logs = await db('agent_logs')
      .join('tasks', 'agent_logs.task_id', 'tasks.id')
      .where('tasks.project_url', url)
      .orderBy('agent_logs.created_at', 'desc')
      .limit(limit)
      .select('agent_logs.*');
      
    res.json({ tasks, logs });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Skill 2: update_task_status
app.patch('/api/tasks/:id/status', apiLimiter, authenticateAgent, async (req, res) => {
  const { status, project_url, agent_name, agent_email } = req.body;
  try {
    await db('tasks').where({ id: req.params.id }).update({ status });
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
    const logs = await db('agent_logs')
      .join('tasks', 'agent_logs.task_id', 'tasks.id')
      .where('tasks.project_url', url)
      .orderBy('agent_logs.created_at', 'desc')
      .select('agent_logs.*', 'tasks.title as task_title');

    res.json({ project, tasks, logs });
  } catch (error) {
    res.status(500).json({ error: error.message });
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

