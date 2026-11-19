import { test as base, expect } from '@playwright/test';

// offline e2e 用 `vite preview` 直接serve 生產版 dist，唔會經 dev server 嘅
// transformIndexHtml，所以冇本機測試通行證。entry-gate（docs/50 SG5）會照規矩
// 攔直接開網址，測試就會全部 timeout。
// 呢度用 entry-gate 自己嘅機制（sessionStorage 通行證）模擬「由指定入口撳入」，
// 唔偽造 Referer（Chromium 會回 net::ERR_BLOCKED_BY_CLIENT）。
// ⚠️ 純本機模擬，唔等於真機由 APP STORE 撳入嘅驗收。
const STORE_PASS = "try { sessionStorage.setItem('hm20c.store_pass', '1'); } catch {}";

export const test = base.extend({
  page: async ({ page }, use) => {
    await page.addInitScript(STORE_PASS);
    await use(page);
  },
});

export { expect };
