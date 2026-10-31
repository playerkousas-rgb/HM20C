import { defineConfig } from '@playwright/test';

// Offline tests must exercise the generated production worker, not Vite dev.
export default defineConfig({
  testDir: './tests/offline-e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:5177',
    viewport: { width: 393, height: 852 },
    browserName: 'chromium',
    launchOptions: process.env.CHROMIUM_EXECUTABLE_PATH ? {
      executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
      args: ['--no-sandbox', '--no-zygote'],
    } : {},
  },
  webServer: {
    command: 'npm run preview -- --port 5177 --strictPort',
    env: { LEADER_PASSWORD: 'playwright-only-test-secret' },
    url: 'http://127.0.0.1:5177',
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
