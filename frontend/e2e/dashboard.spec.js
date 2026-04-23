import { test, expect } from '@playwright/test';

test.describe('Dashboard E2E Flow', () => {
  test('User can login and view the dashboard overview', async ({ page }) => {
    // Navigate to the login page explicitly
    await page.goto('/login');
    
    // Check we are on login page
    await expect(page.locator('h2')).toContainText('APTS Portal');
    
    // Fill in the password (default from env/backend)
    await page.getByLabel('Password').fill('admin');
    
    // Submit login form
    await page.getByRole('button', { name: 'Access Dashboard' }).click();
    
    // Wait for navigation to dashboard
    await page.waitForURL('**/dashboard/overview');
    
    // Verify Dashboard Title
    await expect(page.locator('h2')).toContainText('System Overview');
    
    // Verify KPI Cards are present
    await expect(page.locator('text=Active Projects')).toBeVisible();
    await expect(page.locator('text=Blocked Projects')).toBeVisible();
    await expect(page.locator('text=Stalled Agents')).toBeVisible();
    
    // Verify Task Kanban is present
    await expect(page.locator('text=Active Task Board')).toBeVisible();
    
    // Verify Live Feed is present
    await expect(page.locator('text=Live Agent Feed')).toBeVisible();

    // Take a screenshot to capture the beautiful dark theme state
    await page.screenshot({ path: 'e2e/screenshots/dashboard_overview.png' });
  });
});
