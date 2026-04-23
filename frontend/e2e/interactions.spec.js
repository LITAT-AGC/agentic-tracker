import { test, expect } from '@playwright/test';

test.describe('Dashboard Interactive Elements', () => {
  test('User can open Code Audit drawer and Resolve Blocker modal', async ({ page }) => {
    // Intercept the dashboard overview API to provide controlled test data
    await page.route('**/api/dashboard/overview', async route => {
      const json = {
        projects: [
          { url: 'https://github.com/test/repo', name: 'Test Repo', status: 'blocked' }
        ],
        tasks: [
          {
            id: 'mock-task-123',
            project_url: 'https://github.com/test/repo',
            title: 'Implement feature X',
            status: 'stalled',
            agent_name: 'AI Agent',
            created_at: new Date().toISOString()
          }
        ],
        feed: [
          {
            id: 1,
            agent_name: 'AI Agent',
            message: 'Encountered a dependency error while building.',
            action_type: 'error',
            technical_details: JSON.stringify({
              outcome: 'failure',
              files_modified: ['package.json'],
              commands_run: ['npm install']
            }),
            task_title: 'Implement feature X',
            created_at: new Date().toISOString()
          }
        ]
      };
      await route.fulfill({ json });
    });

    // Mock the resolve endpoint
    let resolveCalled = false;
    await page.route('**/api/tasks/mock-task-123/resolve', async route => {
      const postData = JSON.parse(route.request().postData() || '{}');
      expect(postData.instruction).toBe('Try using npm ci instead');
      resolveCalled = true;
      await route.fulfill({ json: { success: true } });
    });

    // Login flow
    await page.goto('/login');
    await page.getByLabel('Password').fill('admin');
    await page.getByRole('button', { name: 'Access Dashboard' }).click();
    await page.waitForURL('**/dashboard/overview');

    // TEST 1: Code Audit Drawer
    // Wait for the "Code" button to appear in the Live Feed and click it
    const codeBtn = page.locator('button', { hasText: 'Code' });
    await expect(codeBtn).toBeVisible();
    await codeBtn.click();

    // Verify the drawer opens and shows technical details
    const drawerHeader = page.locator('h3', { hasText: 'Code Audit' });
    await expect(drawerHeader).toBeVisible();
    await expect(page.locator('text=Execution Outcome:')).toBeVisible();
    await expect(page.locator('text=failure')).toBeVisible();
    await expect(page.locator('text=package.json')).toBeVisible();
    await expect(page.locator('text=npm install')).toBeVisible();

    // Close the drawer
    await page.locator('.fixed.inset-0.z-50 button').click();

    // TEST 2: Resolve Blocker Modal
    // The task is stalled and project is blocked, so the "Resolve" button should be visible on the task card
    const resolveBtn = page.locator('button', { hasText: 'Resolve' });
    await expect(resolveBtn).toBeVisible();
    await resolveBtn.click();

    // Verify modal opens
    const modalHeader = page.locator('h3', { hasText: 'Resolve Blocker' });
    await expect(modalHeader).toBeVisible();

    // Fill instruction and submit
    const textarea = page.locator('textarea[placeholder="Enter detailed instructions for the agent to proceed..."]');
    await textarea.fill('Try using npm ci instead');
    
    const unblockBtn = page.locator('button', { hasText: 'Unblock Agent' });
    await unblockBtn.click();

    // Wait for modal to close
    await expect(modalHeader).not.toBeVisible();
    expect(resolveCalled).toBe(true);

    // Capture screenshot of the interaction for documentation
    await page.screenshot({ path: 'e2e/screenshots/interactions_tested.png' });
  });
});
