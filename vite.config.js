import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { defineConfig, loadEnv } from 'vite';
import leaderHandler from './api/leader.js';
import activityHandler from './api/activity.js';
import { createMemoryActivityStore } from './server/activity-store.js';

const appVersion = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
function appMetadata() {
  return { name: 'app-metadata', transformIndexHtml: (html) => html.replaceAll('%APP_VERSION%', appVersion) };
}

// Cache the exact production shell (including self-hosted font subsets), not a
// stale hand-maintained list of hashed files. Map data has its own caches.
function offlineWorker() {
  return {
    name: 'scout-offline-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const built = Object.keys(bundle).filter((name) => /\.(js|css|woff2|wasm)$/.test(name)).map((name) => `/${name}`);
      const assets = [...new Set([
        '/', '/index.html', '/manifest.webmanifest', '/favicon.svg',
        '/apple-touch-icon.png', '/icon-192.png', '/icon-512.png',
        '/icons/v1/favicon.ico', '/icons/v1/favicon-16.png', '/icons/v1/favicon-32.png', '/icons/v1/apple-touch-icon.png',
        '/icons/v1/icon-192.png', '/icons/v1/icon-512.png', '/icons/v1/icon-maskable-192.png', '/icons/v1/icon-maskable-512.png', '/icons/v1/og-image.png',
        '/landsd-logo.svg', '/third-party-licenses.txt', ...built,
      ])].sort();
      // Hashed bundles identify themselves by filename; unhashed public files,
      // HTML metadata and package version also need to invalidate the worker.
      const hash = createHash('sha256').update(assets.join('\n')).update(appVersion)
        .update(readFileSync(new URL('./index.html', import.meta.url)));
      for (const asset of assets.filter((name) => name !== '/' && name !== '/index.html' && !name.startsWith('/assets/'))) {
        hash.update(asset).update(readFileSync(new URL(`./public${asset}`, import.meta.url)));
      }
      const version = hash.digest('hex').slice(0, 12);
      const manifest = JSON.stringify({ appCache: `scout-offline-app-${version}`, assets });
      const template = readFileSync(new URL('./src/offline/sw-template.js', import.meta.url), 'utf8');
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: template.replace('__SCOUT_OFFLINE_MANIFEST__', manifest) });
    },
  };
}

// The same Node handler runs locally and as /api/leader on Vercel. Browser
// code always uses a relative URL, including in Arena's HTTPS preview proxy.
function localLeaderApi() {
  const memoryStore = createMemoryActivityStore();
  const middleware = (server) => {
    const prefixes = ['LEADER_', 'UPSTASH_', 'KV_', 'ACTIVITY_'];
    // Only server middleware reads these values; none are passed to the client.
    const localEnv = { ...Object.assign({}, ...prefixes.map((prefix) => loadEnv(server.config.mode, server.config.root, prefix))), ...process.env };
    const options = { password: localEnv.LEADER_PASSWORD, env: localEnv, store: localEnv.ACTIVITY_DEV_MEMORY === '1' ? memoryStore : null };
    function safely(handler, req, res) {
      void handler(req, res, options).catch(() => {
        if (!res.headersSent) { res.statusCode = 500; res.setHeader('Cache-Control', 'no-store'); }
        res.end();
      });
    }
    server.middlewares.use('/api/leader', (req, res) => safely(leaderHandler, req, res));
    server.middlewares.use('/api/activity', (req, res) => safely(activityHandler, req, res));
  };
  return { name: 'local-leader-api', configureServer: middleware, configurePreviewServer: middleware };
}

export default defineConfig({
  plugins: [appMetadata(), offlineWorker(), localLeaderApi()],
  build: { rollupOptions: { output: { manualChunks(id) {
    if (/\/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react-core';
    if (id.includes('/node_modules/leaflet/') || id.includes('/node_modules/@tomickigrzegorz/leaflet-rotate/')) return 'map-core';
  } } } },
  server: { host: '0.0.0.0', allowedHosts: true },
  preview: { host: '0.0.0.0', allowedHosts: true },
  test: { environment: 'jsdom', include: ['tests/**/*.test.js'] },
});
