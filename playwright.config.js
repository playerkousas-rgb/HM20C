import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: './test-results/e2e',
  workers: 1,
  use: {
    // entry-gate 白名單（docs/50 SG5）：本機測試直接開 127.0.0.1 會被攔截。
    // 呢個 Referer 模擬「由 SCOUT APP STORE 撳入」，屬本機模擬，唔等於真機驗收。
    extraHTTPHeaders: { referer: 'https://scoutappstore.vercel.app/' },
    baseURL: 'http://127.0.0.1:5175',
    viewport: { width: 393, height: 852 },
    browserName: 'chromium',
    launchOptions: process.env.CHROMIUM_EXECUTABLE_PATH ? {
      executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
      args: ['--no-sandbox', '--no-zygote'],
    } : {},
  },
  webServer: {
    command: 'npm run dev -- --port 5175 --strictPort',
    env: { LEADER_PASSWORD: 'playwright-only-test-secret', ACTIVITY_DEV_MEMORY: '1' },
    url: 'http://127.0.0.1:5175',
    reuseExistingServer: true,
    timeout: 30000,
  },
});
