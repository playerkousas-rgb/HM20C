#!/usr/bin/env node
// final_check v1.0 — HM20C Vite/Vitest/Playwright adaptation of the shared
// readme repository's six-angle checklist. Human checks remain explicit.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const json = process.argv.includes('--json');
const checks = [];
function run(label, args) {
  const result = spawnSync('npm', args, { cwd: root, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
    timeout: 12 * 60 * 1000, env: process.env });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
  const passed = result.status === 0;
  const report = { label, status: passed ? 'PASS' : 'FAIL', command: ['npm', ...args].join(' '),
    summary: output.slice(-3500), ...(result.error ? { error: result.error.message } : {}) };
  checks.push(report);
  if (!json) {
    console.log(`\n[${report.status}] ${label}\n${report.summary}`);
    // Keep the failing step visible in the GitHub Checks API even when build
    // logs or Playwright artifacts cannot be downloaded from the runner.
    if (!passed && process.env.GITHUB_ACTIONS === 'true') {
      const detail = `${label}\n${result.error?.message || ''}\n${output.slice(-7000)}`
        .replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
      console.log(`::error title=Final check failed::${detail}`);
    }
  }
  return passed;
}

// Do not hide later results when an earlier step fails. Build before the
// guard and production worker tests; all browsers use synthetic map sources.
run('正式建置', ['run', 'build']);
run('瘦身、秘密、圖標及 Vite 專案守門', ['run', 'guard', '--', '--ci']);
run('單元及 API 測試', ['test', '--', '--reporter=dot']);
run('領袖／成員模擬瀏覽器操作', ['run', 'test:e2e', '--', '--reporter=dot']);
run('正式 Service Worker 離線瀏覽器操作', ['run', 'test:e2e:offline', '--', '--reporter=dot']);
run('正式及開發依賴安全稽核（需網絡）', ['audit', '--audit-level=low']);

const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const manual = [
  'GitHub/Vercel：檢查實際部署、環境變數、正式 Upstash Redis 與兩部裝置同步；腳本未連接正式資料庫。',
  '開發者：用實體 iOS／Android 測鏡頭、加入主畫面、飛航模式、離線中文字及儲存空間不足。',
  '系統架構師：確認政府及第三方圖源 CORS、下載授權、服務可靠度與既有活動鑰匙的保管風險。',
  'AI agent：按需求比對 16 張紙圖角度、圖例、座標換算和未完成項；自動檢查不能代替專家核實。',
  '使用者：攜紙圖及指南針到安全環境實測，驗證路線磁石、方位、三角和整幅離線地圖。',
  '主管：依實際用途、風險及以上未測項決定是否接受，不以腳本通過宣稱完全符合或安全導航。',
];
const passed = checks.every((entry) => entry.status === 'PASS');
const report = { script: 'final_check v1.0', appVersion: version, passed, checks, manual: manual.map((item) => ({status:'NOT VERIFIED', item})) };
if (json) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`\n六角度人手／部署驗收（未由腳本完成）：\n${manual.map((item) => `  - 未驗證：${item}`).join('\n')}`);
  console.log(`\n${passed ? 'AUTOMATED CHECKS PASS' : 'AUTOMATED CHECKS FAIL'} — 真機、正式服務及圖源授權不能由此結論代替。`);
}
if (!passed) process.exitCode = 1;
