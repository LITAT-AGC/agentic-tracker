import { test, expect } from '@playwright/test';

test.describe('Dashboard E2E Flow', () => {
  test('User can login and view the dashboard overview', async ({ page }) => {
    // Navigate to the login page explicitly
    await page.goto('/login');

    // Check we are on login page
    await expect(page.locator('h2')).toContainText('Portal APTS');

    // Fill in the password (default from env/backend)
    await page.locator('#password').fill('admin');

    // Submit login form
    await page.getByRole('button', { name: 'Acceder al Panel' }).click();

    // Wait for navigation to dashboard
    await page.waitForURL('**/dashboard/overview');

    // Verify Dashboard Title
    await expect(page.locator('h2')).toContainText('Resumen del Sistema');

    // Verify KPI Cards are present
    await expect(page.locator('text=Proyectos Activos')).toBeVisible();
    await expect(page.locator('text=Proyectos Bloqueados')).toBeVisible();
    await expect(page.locator('text=Agentes Estancados')).toBeVisible();

    // Verify Task Kanban is present
    await expect(page.locator('text=Tablero de Tareas Activas')).toBeVisible();

    // Verify Live Feed is present
    await expect(page.locator('text=Actividad en Vivo de Agentes')).toBeVisible();

  });
});
