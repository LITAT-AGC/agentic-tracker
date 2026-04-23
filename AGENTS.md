# Agent Guidelines for APTS

This document contains operational instructions for autonomous AI agents contributing to the Agentic Project Tracking Service (APTS).

## 🧪 Testing Guidelines

When executing end-to-end (E2E) frontend tests using Playwright, you MUST follow these specific steps to ensure our development data remains intact and isolated:

### 1. Database & Backend Preparation
The frontend E2E tests require a live backend. However, it must **never** be run against the `development` or `production` databases.

You must run the backend in `test` mode, which points to a temporary testing database (`apts_test.db`):

```bash
# Terminal 1: Setup test database and run backend
cd backend
set NODE_ENV=test
npx knex migrate:latest
node index.js
```
*(Note: If using PowerShell, use `$env:NODE_ENV="test"` instead of `set NODE_ENV=test`)*

### 2. Running the E2E Tests
**Important Playwright Rules:**
- **No Browser Downloads:** Playwright must be installed without its bundled browsers. It is configured to use the local Windows Google Chrome installation via `channel: 'chrome'`. Do not run `npx playwright install`.
- **No Video Evidence:** Do not configure Playwright to capture video recordings of the test execution. Screenshots are allowed for verifying static state, but videos are strictly prohibited.

With the backend running in test mode on port 46100, you can now run the frontend tests. Playwright is configured to automatically launch the Vite dev server on port 46101 during the test run.

```bash
# Terminal 2: Run Playwright tests
cd frontend
npx playwright test
```

### 3. Cleanup (Optional but recommended)
After testing is completed, you can delete the `apts_test.db` to ensure a clean state for the next test run.

---

## 🛠️ General Rules
- Always prioritize using the most specific tool for the task at hand.
- Before modifying database schemas, always create a new migration. Do not modify existing applied migrations.
- When creating UI components, utilize the existing Tailwind CSS setup and prioritize the dark, premium aesthetic.
