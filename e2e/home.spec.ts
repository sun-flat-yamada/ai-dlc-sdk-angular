import { expect, test } from '@playwright/test';

test.describe('existing front panel (smoke)', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/v1/status', (route) =>
      route.fulfill({
        json: { deviceName: 'Panel-01', firmwareVersion: '3.2.0', state: 'ready', alerts: ['E-101'] },
      }),
    );
  });

  test('home shows the device status and the menu', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('[data-ui-id="device-state"]')).toHaveText('待機中');
    await expect(page.locator('[data-ui-id="alert-count"]')).toContainText('1');
    await expect(page.locator('[data-ui-id="firmware-version"]')).toContainText('3.2.0');
  });

  test('menu opens the legacy network screen', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-ui-id="menu-network"]').click();
    await expect(page).toHaveURL(/network-legacy$/);
    await expect(page.locator('[data-ui-id="legacy-network-page"]')).toBeVisible();
  });
});
