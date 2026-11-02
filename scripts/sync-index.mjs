#!/usr/bin/env node
// Vite/PWA requires index.html at a stable URL. Generate it from the one
// versioned source and the package version instead of editing two copies.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
if (!/^\d+\.\d+(?:\.\d+)?$/.test(version)) throw new Error('Invalid package version.');
const name = `index_v${version}.html`;
const candidates = readdirSync(root).filter((entry) => /^index_v\d+\.\d+(?:\.\d+)?\.html$/.test(entry));
if (candidates.length !== 1 || candidates[0] !== name) throw new Error(`Keep only the versioned HTML source ${name}.`);
const source = readFileSync(path.join(root, name), 'utf8');
if (!source.includes(`v${version}`) || !source.includes('v%APP_VERSION%')) throw new Error('HTML source version/metadata mismatch.');
const generated = source.replace('<!doctype html>', `<!doctype html>\n<!-- GENERATED from ${name} (v${version}); edit the versioned source. -->`);
const output = path.join(root, 'index.html');
if (process.argv.includes('--check')) {
  if (readFileSync(output, 'utf8') !== generated) { console.error('index.html is stale; run npm run sync:index.'); process.exit(1); }
} else writeFileSync(output, generated);
console.log(`Vite index.html generated from ${name}.`);
