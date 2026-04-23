const baseUrl = 'http://localhost:46100/api';
const headers = {
  'Content-Type': 'application/json',
  'Authorization': 'Bearer default-dev-key'
};

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function request(endpoint, method, body) {
  const res = await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers,
    body: JSON.stringify(body)
  });
  if (!res.ok) {
     const text = await res.text();
     console.error(`Error on ${method} ${endpoint}:`, text);
     return null;
  }
  return res.json();
}

async function run() {
  console.log("Starting simulation data generation...");

  // Project 1: Alice - Web Scraper (Completed)
  console.log("Simulating Project 1 (Web Scraper)...");
  const p1 = await request('/projects/tasks', 'POST', {
    project_url: 'https://github.com/org/web-scraper',
    title: 'Implement Smart Rate Limiting',
    agent_name: 'Alice_AI',
    agent_email: 'alice@agents.local',
    context: 'Need to prevent IP bans while scraping'
  });
  await sleep(300);
  await request(`/tasks/${p1.task_id}/logs`, 'POST', {
    project_url: 'https://github.com/org/web-scraper',
    agent_name: 'Alice_AI',
    branch: 'feat/rate-limit',
    message: 'Added bottleneck library for request throttling.',
    technical_details: { files_modified: ['package.json', 'src/scraper.js'], commands_run: ['npm i bottleneck'], outcome: 'success' }
  });
  await sleep(300);
  await request(`/tasks/${p1.task_id}/logs`, 'POST', {
    project_url: 'https://github.com/org/web-scraper',
    agent_name: 'Alice_AI',
    branch: 'feat/rate-limit',
    message: 'Configured delays between 2s and 5s randomly.',
    technical_details: { files_modified: ['src/config.js'], commands_run: [], outcome: 'success' }
  });
  await sleep(300);
  await request(`/tasks/${p1.task_id}/status`, 'PATCH', {
    task_id: p1.task_id,
    status: 'done',
    project_url: 'https://github.com/org/web-scraper',
    agent_name: 'Alice_AI',
    agent_email: 'alice@agents.local'
  });

  // Project 2: Bob - Crypto Bot (Blocked)
  console.log("Simulating Project 2 (Crypto Bot - Blocked)...");
  const p2 = await request('/projects/tasks', 'POST', {
    project_url: 'https://github.com/org/crypto-bot',
    title: 'Binance WebSocket Integration',
    agent_name: 'Bob_Trader_Agent',
    agent_email: 'bob@agents.local',
    context: 'Connect to real-time orderbook'
  });
  await sleep(300);
  await request(`/tasks/${p2.task_id}/logs`, 'POST', {
    project_url: 'https://github.com/org/crypto-bot',
    agent_name: 'Bob_Trader_Agent',
    branch: 'feat/binance-ws',
    message: 'Established basic WebSocket connection.',
    technical_details: { files_modified: ['src/ws.js'], commands_run: [], outcome: 'success' }
  });
  await sleep(300);
  await request(`/projects/blockers`, 'POST', {
    project_url: 'https://github.com/org/crypto-bot',
    task_id: p2.task_id,
    agent_name: 'Bob_Trader_Agent',
    error_message: 'Binance API requires IP whitelisting. Cannot connect to production endpoint from current IP.'
  });

  // Project 3: Charlie - Mobile App (In Progress / Stalled simulation)
  console.log("Simulating Project 3 (Mobile App - In Progress)...");
  const p3 = await request('/projects/tasks', 'POST', {
    project_url: 'https://gitlab.com/company/mobile-app',
    title: 'Fix OAuth Login Loop',
    agent_name: 'Charlie_Mobile',
    agent_email: 'charlie@agents.local',
    context: 'Users get stuck in a redirect loop on iOS'
  });
  await sleep(300);
  await request(`/tasks/${p3.task_id}/logs`, 'POST', {
    project_url: 'https://gitlab.com/company/mobile-app',
    agent_name: 'Charlie_Mobile',
    branch: 'bugfix/oauth-loop',
    message: 'Investigating deep link configuration in Expo.',
    technical_details: { files_modified: ['app.json'], commands_run: ['npx expo prebuild'], outcome: 'success' }
  });

  // Project 4: Javier - APTS Backend (Review Phase)
  console.log("Simulating Project 4 (APTS Maintenance - Review)...");
  const p4 = await request('/projects/tasks', 'POST', {
    project_url: 'https://github.com/org/agentic-tracker',
    title: 'Migrate SQLite to PostgreSQL',
    agent_name: 'Super_Javier_AI',
    agent_email: 'japedev@gmail.com',
    context: 'Production readiness'
  });
  await sleep(300);
  await request(`/tasks/${p4.task_id}/logs`, 'POST', {
    project_url: 'https://github.com/org/agentic-tracker',
    agent_name: 'Super_Javier_AI',
    branch: 'chore/pg-migration',
    message: 'Updated knexfile.js for production profile',
    technical_details: { files_modified: ['knexfile.js'], commands_run: [], outcome: 'success' }
  });
  await sleep(300);
  await request(`/tasks/${p4.task_id}/logs`, 'POST', {
    project_url: 'https://github.com/org/agentic-tracker',
    agent_name: 'Super_Javier_AI',
    branch: 'chore/pg-migration',
    message: 'Tested connection with remote DB. All tests passed.',
    technical_details: { files_modified: [], commands_run: ['npm test'], outcome: 'success' }
  });
  await sleep(300);
  await request(`/tasks/${p4.task_id}/status`, 'PATCH', {
    task_id: p4.task_id,
    status: 'review',
    project_url: 'https://github.com/org/agentic-tracker',
    agent_name: 'Super_Javier_AI',
    agent_email: 'japedev@gmail.com'
  });

  console.log("Simulation complete! Check the dashboard.");
}

run();
