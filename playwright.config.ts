import { defineConfig, devices } from '@playwright/test';

/** Smoke E2E tests of the existing application (e2e/). Subsystem tests use .ai-dlc/tools/playwright.subsystem.config.ts. */
const port = 4320;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `http://localhost:${port}`,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'front-panel',
      use: { ...devices['Desktop Chrome'], viewport: { width: 800, height: 480 }, hasTouch: true },
    },
  ],
  webServer: {
    command: `npx ng serve --port ${port}`,
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env['CI'],
    timeout: 180_000,
  },
});
