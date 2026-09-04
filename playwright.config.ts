import { defineConfig } from '@playwright/test';

const externalBaseUrl = process.env.PLAYWRIGHT_BASE_URL;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: 0,
  reporter: 'line',
  use: {
    baseURL: externalBaseUrl ?? 'http://127.0.0.1:4174',
    trace: 'retain-on-failure',
  },
  webServer: externalBaseUrl ? undefined : {
    command: 'npm run dev -- --port 4174',
    url: 'http://127.0.0.1:4174',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
