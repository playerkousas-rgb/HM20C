import { defineConfig } from '@playwright/test';

// 本 App 有 entry-gate 白名單（docs/50 SG5）：直接開 127.0.0.1 會被攔，
// 呢個係正確行為。測試唔偽造 Referer（Chromium 對偽造 top-level Referer 會回
// net::ERR_BLOCKED_BY_CLIENT，連 page.reload() 都會死），改用真實機制：
// 喺頁面 script 開始前寫入 entry-gate 自己嘅 session 通行證（sessionStorage），
// 等同「呢個分頁已經由指定入口撳入過」。
// ⚠️ 純本機模擬，唔等於真機由 APP STORE 撳入嘅驗收。
const storePass = "try { sessionStorage.setItem('hm20c.store_pass', '1'); } catch {}";

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: './test-results/e2e',
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:5175',
    viewport: { width: 393, height: 852 },
    browserName: 'chromium',
    extraHTTPHeaders: {},
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
