import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, beforeEach, vi } from 'vitest';

// These tests run the *real* gate file (copied unmodified from the shared
// readme repo) inside jsdom, so the entry-gate decisions are checked locally.
// This is a browser simulation, not a real-device test.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const gateSource = readFileSync(path.join(process.cwd(), 'public/store_gate_v1.0.js'), 'utf8');
const styles = readFileSync(path.join(process.cwd(), 'src/styles.css'), 'utf8');

const OPTIONS = {
  appKey: 'hm20c',
  mode: 'entry-gate',
  portalIds: ['appstore'],
  silentPortalIds: ['library'],
  allowStandalone: true,
  autoRedirectSeconds: 0,
};

function loadGate() {
  window.eval(gateSource);
  return window.ScoutStoreGate;
}

function run(options, { referrer = '', standalone = false, freshTab = true } = {}) {
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-store-gated');
  document.getElementById('scoutStoreGateStyle')?.remove();
  document.getElementById('scoutStoreGate')?.remove();
  if (freshTab) window.sessionStorage.clear();
  Object.defineProperty(document, 'referrer', { configurable: true, value: referrer });
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches: standalone && query.includes('standalone'),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
  return window.initStoreGate(options, window);
}

describe('store gate (entry-gate) — SG19 button source split', () => {
  beforeEach(() => { loadGate(); });

  it('exposes the SG18 helper and builds the app-store deep link without hardcoding a URL', () => {
    expect(window.ScoutStoreGate.getAppStoreUrl('hm20c')).toBe('https://scoutappstore.vercel.app/?app=hm20c');
  });

  it('blocks a direct open and shows exactly one APP STORE button (library stays silent)', () => {
    const decision = run(OPTIONS);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('missing-whitelist-entry');
    const cta = document.querySelectorAll('#scoutStoreGate .sg-cta');
    expect(cta).toHaveLength(1);
    expect(cta[0].href).toBe('https://scoutappstore.vercel.app/');
    expect(cta[0].textContent).toBe('前往 APP STORE'); // SG19: no "1. " prefix on a single button
    expect(document.getElementById('scoutStoreGate').textContent).not.toContain('圖書館');
    expect(document.getElementById('scoutStoreGate').getAttribute('role')).toBe('dialog');
    expect(document.body.style.display).not.toBe('none');
  });

  it('lets the APP STORE referral through and reports matchedPortalId', () => {
    const decision = run(OPTIONS, { referrer: 'https://scoutappstore.vercel.app/' });
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('referrer-whitelist');
    expect(decision.matchedPortalId).toBe('appstore');
    expect(window.sessionStorage.getItem('hm20c.store_pass')).toBe('1');
    expect(document.getElementById('scoutStoreGate')).toBeNull();
  });

  it('lets the library referral through quietly (silentPortalIds)', () => {
    const decision = run(OPTIONS, { referrer: 'https://scout-circulars.vercel.app/' });
    expect(decision.allowed).toBe(true);
    expect(decision.matchedPortalId).toBe('library');
  });

  it('lets an installed home-screen app through (allowStandalone)', () => {
    const decision = run(OPTIONS, { standalone: true });
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('standalone-pwa');
  });

  it('keeps the session pass after a reload in the same tab', () => {
    run(OPTIONS, { referrer: 'https://scoutappstore.vercel.app/' });
    const decision = run(OPTIONS, { freshTab: false });   // same tab, no referrer on reload
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('session-pass');
  });

  it('rejects a look-alike origin (no prefix spoofing)', () => {
    const decision = run(OPTIONS, { referrer: 'https://scoutappstore.vercel.app.evil.example/' });
    expect(decision.allowed).toBe(false);
    expect(document.querySelectorAll('#scoutStoreGate .sg-cta')).toHaveLength(1);
  });

  it('never auto-redirects when autoRedirectSeconds is 0', () => {
    const calls = [];
    const original = window.setTimeout;
    window.setTimeout = (fn, delay, ...rest) => { calls.push(delay); return original(fn, delay, ...rest); };
    try {
      run(OPTIONS);
    } finally {
      window.setTimeout = original;
    }
    expect(calls.filter((delay) => delay > 0)).toHaveLength(0);
  });
});

describe('SG18 support button', () => {
  it('has an explicit [hidden] rule so the button cannot show without a URL', () => {
    expect(styles).toMatch(/\.support-btn\[hidden\][^{]*\{[^}]*display:\s*none/);
  });

  it('meets the 40px touch target and hides in print', () => {
    expect(styles).toMatch(/\.support-btn\s*\{[^}]*min-height:\s*40px/);
    expect(styles).toMatch(/@media print\s*\{[^}]*\.support-btn\s*\{\s*display:\s*none\s*!important/);
  });

  it('uses only ScoutStoreGate.getAppStoreUrl with the verified slug hm20c', () => {
    const source = readFileSync(path.join(process.cwd(), 'src/components/StoreSupportLink.jsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');   // ignore comments
    expect(source).toContain("const APP_SLUG = 'hm20c'");
    expect(source).toContain('getAppStoreUrl(APP_SLUG)');
    expect(source).not.toMatch(/scoutappstore\.vercel\.app/);   // zero hardcoded store URLs
    expect(source).not.toMatch(/supabase|anon|bump_hearts|bump_stars/i);
  });
});

describe('SG18 support button rendering', () => {
  it('stays hidden until ScoutStoreGate is present, then links to the app-store deep link', async () => {
    const { default: StoreSupportLink } = await import('../src/components/StoreSupportLink.jsx');
    delete window.ScoutStoreGate;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => { root.render(React.createElement(StoreSupportLink)); });
    expect(host.querySelector('#storeSupportTop').hidden).toBe(true);
    expect(host.querySelector('#storeSupportTop').getAttribute('href')).toBeNull();

    loadGate();
    act(() => { root.unmount(); });
    const host2 = document.createElement('div');
    document.body.appendChild(host2);
    const root2 = createRoot(host2);
    await act(async () => { root2.render(React.createElement(StoreSupportLink)); });
    const link = host2.querySelector('#storeSupportTop');
    expect(link.hidden).toBe(false);
    expect(link.getAttribute('href')).toBe('https://scoutappstore.vercel.app/?app=hm20c');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener');
    act(() => { root2.unmount(); });
  });
});

describe('production config matches the shared A-group instruction verbatim', () => {
  const html = readFileSync(path.join(process.cwd(), 'index_v1.3.0.html'), 'utf8');

  it('uses exactly appKey/mode/portalIds/silentPortalIds/allowStandalone/autoRedirectSeconds', () => {
    for (const line of [
      "appKey: 'hm20c'",
      "mode: 'entry-gate'",
      "portalIds: ['appstore']",
      "silentPortalIds: ['library']",
      'allowStandalone: true',
      'autoRedirectSeconds: 0',
    ]) expect(html).toContain(line);
    expect(html).not.toContain('allowedOrigins');
    expect(html).not.toContain('allowLocalhost');
    expect(html).not.toContain('supportNudge');
  });

  it('loads the gate file before the viewport meta and never uses iframe-only or closed', () => {
    expect(html.indexOf('/store_gate_v1.0.js')).toBeLessThan(html.indexOf('name="viewport"'));
    expect(html).not.toContain("mode: 'iframe-only'");
    expect(html).not.toContain("mode: 'closed'");
  });
});

describe('dev/preview only test pass', () => {
  it('injects the pass in Vite serve mode only, never into the production build', () => {
    const vite = readFileSync(path.join(process.cwd(), 'vite.config.js'), 'utf8');
    expect(vite).toContain("apply: 'serve'");
    expect(vite).toContain("sessionStorage.setItem('hm20c.store_pass', '1')");
    const dist = path.join(process.cwd(), 'dist/index.html');
    if (existsSync(dist)) {
      const built = readFileSync(dist, 'utf8');
      expect(built).not.toContain('store_pass');   // 生成本機通行證唔准入生產版本
    }
  });
});
