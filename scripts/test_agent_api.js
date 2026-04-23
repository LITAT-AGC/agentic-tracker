

const API_KEY = process.env.APTS_API_KEY || 'default-dev-key';
const BASE_URL = 'http://localhost:46100/api';

const headers = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${API_KEY}`
};

async function runPilot() {
  console.log('--- Iniciando Prueba de Vuelo del Agente ---');
  const projectUrl = 'https://github.com/agentic-org/test-project';
  const agentName = 'Antigravity-AI';
  const agentEmail = 'antigravity@deepmind.com';
  const branch = 'feature/auth-jwt';

  // 0. Backlog: create an item before execution starts
  console.log('\n[Backlog] Creando item gestionado...');
  const backlogRes = await fetch(`${BASE_URL}/projects/backlog`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      project_url: projectUrl,
      title: 'Backlog: Integrate User Auth System',
      description: 'Implement login flow and protect authenticated routes.',
      acceptance_criteria: 'Users can sign in and protected endpoints reject anonymous access.',
      item_type: 'feature',
      priority: 10,
      sort_order: 1,
      source_kind: 'pilot-script',
      source_ref: 'scripts/test_agent_api.js'
    })
  });
  const backlogData = await backlogRes.json();
  console.log('Backlog Item Created:', backlogData);
  const backlogItemId = backlogData.backlog_item?.id;

  if (!backlogItemId) {
    console.error('Fallo al crear backlog_item. Abortando.');
    return;
  }

  // 1. Skill 0: Register Task
  console.log('\n[Skill 0] Registrando nueva tarea...');
  const taskRes = await fetch(`${BASE_URL}/projects/tasks`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      project_url: projectUrl,
      title: 'Integrate User Auth System',
      agent_name: agentName,
      agent_email: agentEmail,
      context: 'User requested a login system using JWT.',
      backlog_item_id: backlogItemId
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
  const ctxRes = await fetch(`${BASE_URL}/projects/context?url=${encodeURIComponent(projectUrl)}`, {
    headers
  });
  const ctxData = await ctxRes.json();
  console.log('Project Tasks Count:', ctxData.tasks?.length);
  console.log('Project Backlog Count:', ctxData.backlog?.length);

  // 3. Skill 3: Log Agent Progress
  console.log('\n[Skill 3] Registrando progreso...');
  const logRes = await fetch(`${BASE_URL}/tasks/${taskId}/logs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      project_url: projectUrl,
      agent_name: agentName,
      branch,
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
      agent_name: agentName,
      project_url: projectUrl
    })
  });
  console.log('Heartbeat Sent:', await hbRes.json());

  // 4b. Skill 2: Update task status to review and validate backlog linkage
  console.log('\n[Skill 2] Actualizando tarea a review...');
  const reviewRes = await fetch(`${BASE_URL}/tasks/${taskId}/status`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      task_id: taskId,
      status: 'review',
      project_url: projectUrl,
      agent_name: agentName,
      agent_email: agentEmail
    })
  });
  console.log('Task Updated:', await reviewRes.json());

  console.log('\n[Backlog] Consultando backlog tras pasar a review...');
  const backlogListRes = await fetch(`${BASE_URL}/projects/backlog?url=${encodeURIComponent(projectUrl)}`, {
    headers
  });
  const backlogListData = await backlogListRes.json();
  const linkedItem = backlogListData.backlog?.find(item => item.id === backlogItemId);
  console.log('Linked Backlog Status:', linkedItem?.status);

  // 5. Skill 4: Report Blocker
  console.log('\n[Skill 4] Reportando un blocker...');
  const blockerRes = await fetch(`${BASE_URL}/projects/blockers`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      project_url: projectUrl,
      task_id: taskId,
      error_message: 'Missing DB connection string for testing environment.',
      agent_name: agentName
    })
  });
  console.log('Blocker Reported:', await blockerRes.json());

  console.log('\n[Backlog] Consultando backlog tras reportar blocker...');
  const blockedBacklogRes = await fetch(`${BASE_URL}/projects/backlog?url=${encodeURIComponent(projectUrl)}&status=blocked`, {
    headers
  });
  const blockedBacklogData = await blockedBacklogRes.json();
  console.log('Blocked Backlog Count:', blockedBacklogData.backlog?.length);

  console.log('\n--- Prueba de Vuelo Completada ---');
}

runPilot().catch(console.error);
