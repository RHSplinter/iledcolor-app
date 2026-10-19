import { defineConfig, devices } from '@playwright/test';

const remoteURL = process.env.PLAYWRIGHT_BASE_URL;
const baseURL = remoteURL ? `${remoteURL.replace(/\/+$/, '')}/` : 'http://localhost:4173/';
const smokeTests = '**/web-navigation.spec.ts';

// Remote runs deliberately exercise only permission-free, hardware-independent web checks.
export default defineConfig({
  testDir: 'e2e',
  testMatch: remoteURL ? smokeTests : undefined,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [['list'], ['html', { open: 'never' }]],
  webServer: remoteURL ? undefined : {
    command: 'npm run build && npx vite preview --port 4173 --strictPort',
    url: baseURL, reuseExistingServer: !process.env.CI, timeout: 120_000,
  },
  use: { baseURL, serviceWorkers: 'allow', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', testMatch: smokeTests, use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', testMatch: smokeTests, use: { ...devices['Desktop Safari'] } },
  ],
});
