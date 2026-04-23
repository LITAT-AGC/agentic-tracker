

const API_KEY = process.env.APTS_API_KEY || 'default-dev-key';
const BASE_URL = 'http://localhost:46100/api';

const headers = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${API_KEY}`
};

async function runPilot() {
  console.log('--- Iniciando Prueba de Vuelo del Agente ---');
  
  // 1. Skill 0: Register Task
  console.log('\n[Skill 0] Registrando nueva tarea...');
  const taskRes = await fetch(`${BASE_URL}/projects/tasks`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      project_url: 'https://github.com/agentic-org/test-project',
      title: 'Integrate User Auth System',
      agent_name: 'Antigravity-AI',
      agent_email: 'antigravity@deepmind.com',
      context: 'User requested a login system using JWT.'
    })
  });
  const taskData = await taskRes.json();
  console.log('Task Registered:', taskData);
  const taskId = taskData.task_id;

  if (!taskId) {
    console.error('Fallo al obtener task_id. Abortando.');
    return;
  }

  // 2. Skill 1: Read Project Context
  console.log('\n[Skill 1] Leyendo contexto del proyecto...');
  const ctxRes = await fetch(`${BASE_URL}/projects/context?url=https://github.com/agentic-org/test-project`, {
    headers
  });
  const ctxData = await ctxRes.json();
  console.log('Project Tasks Count:', ctxData.tasks?.length);

  // 3. Skill 3: Log Agent Progress
  console.log('\n[Skill 3] Registrando progreso...');
  const logRes = await fetch(`${BASE_URL}/tasks/${taskId}/logs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      project_url: 'https://github.com/agentic-org/test-project',
      agent_name: 'Antigravity-AI',
      branch: 'feature/auth-jwt',
      message: 'Implemented JWT token generation and validation middlewares.',
      technical_details: {
        files_modified: ['src/auth/jwt.js', 'src/middleware/auth.js'],
        commands_run: ['npm install jsonwebtoken'],
        outcome: 'success'
      }
    })
  });
  console.log('Progress Logged:', await logRes.json());

  // 4. Skill 5: Heartbeat
  console.log('\n[Skill 5] Enviando heartbeat...');
  const hbRes = await fetch(`${BASE_URL}/tasks/${taskId}/heartbeat`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      task_id: taskId,
      agent_name: 'Antigravity-AI',
      project_url: 'https://github.com/agentic-org/test-project'
    })
  });
  console.log('Heartbeat Sent:', await hbRes.json());

  // 5. Skill 4: Report Blocker
  console.log('\n[Skill 4] Reportando un blocker...');
  const blockerRes = await fetch(`${BASE_URL}/projects/blockers`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      project_url: 'https://github.com/agentic-org/test-project',
      task_id: taskId,
      error_message: 'Missing DB connection string for testing environment.',
      agent_name: 'Antigravity-AI'
    })
  });
  console.log('Blocker Reported:', await blockerRes.json());

  console.log('\n--- Prueba de Vuelo Completada ---');
}

runPilot().catch(console.error);
