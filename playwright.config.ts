import { defineConfig } from '@playwright/test';

// Runs against the production build (service worker only exists there).
export default defineConfig({
  testDir: 'e2e',
  webServer: { command: 'npm run build && npx vite preview --port 4173 --strictPort', url: 'http://localhost:4173', reuseExistingServer: true, timeout: 120_000 },
  use: { baseURL: 'http://localhost:4173', serviceWorkers: 'allow' },
});
