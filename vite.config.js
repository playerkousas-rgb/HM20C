import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { defineConfig, loadEnv } from 'vite';
import leaderHandler from './api/leader.js';

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
        '/landsd-logo.svg', '/third-party-licenses.txt', ...built,
      ])].sort();
      const version = createHash('sha256').update(assets.join('\n')).digest('hex').slice(0, 12);
      const manifest = JSON.stringify({ appCache: `scout-offline-app-${version}`, assets });
      const template = readFileSync(new URL('./src/offline/sw-template.js', import.meta.url), 'utf8');
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: template.replace('__SCOUT_OFFLINE_MANIFEST__', manifest) });
    },
  };
}

// The same Node handler runs locally and as /api/leader on Vercel. Browser
// code always uses a relative URL, including in Arena's HTTPS preview proxy.
function localLeaderApi() {
  const middleware = (server) => {
    server.middlewares.use('/api/leader', (req, res) => {
      const localEnv = loadEnv(server.config.mode, server.config.root, 'LEADER_PASSWORD');
      void leaderHandler(req, res, { password: process.env.LEADER_PASSWORD ?? localEnv.LEADER_PASSWORD }).catch(() => {
        if (!res.headersSent) { res.statusCode = 500; res.setHeader('Cache-Control', 'no-store'); }
        res.end();
      });
    });
  };
  return { name: 'local-leader-api', configureServer: middleware, configurePreviewServer: middleware };
}

export default defineConfig({
  plugins: [offlineWorker(), localLeaderApi()],
  server: { host: '0.0.0.0', allowedHosts: true },
  preview: { host: '0.0.0.0', allowedHosts: true },
  test: { environment: 'jsdom', include: ['tests/**/*.test.js'] },
});
