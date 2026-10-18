import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(HERE, '../dashboard/index.html'), 'utf8');

test('dashboard loads no third-party resources (no CDN, fonts or analytics)', () => {
  const urls = [...html.matchAll(/\b(?:src|href)\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
  const external = urls.filter((u) => /^(https?:)?\/\//.test(u) && !u.startsWith('https://github.com/dongjushin-ai/agent-control-tower'));
  assert.deepEqual(external, []);
  assert.match(html, /<script src="tower-core\.js"><\/script>/);
});

test('dashboard has dark mode for both the system setting and the toggle', () => {
  assert.match(html, /@media \(prefers-color-scheme: dark\)/);
  assert.match(html, /:root\[data-theme="dark"\]/);
  assert.match(html, /:root:not\(\[data-theme="light"\]\)/);
});

test('every English UI string has a Korean translation', () => {
  const script = html.slice(html.indexOf('var UI = {'), html.indexOf('var KIND_LABEL'));
  const ctx = {};
  vm.runInNewContext(script.replace('var UI =', 'this.UI ='), ctx);
  const en = Object.keys(ctx.UI.en).sort();
  const ko = Object.keys(ctx.UI.ko).sort();
  assert.deepEqual(ko, en);
});

test('the browser build of the core attaches window.TowerCore', () => {
  const ctx = { self: {} };
  ctx.self = ctx;
  vm.runInNewContext(readFileSync(join(HERE, '../dashboard/tower-core.js'), 'utf8'), ctx);
  assert.equal(typeof ctx.TowerCore.computeOverview, 'function');
  assert.equal(typeof ctx.TowerCore.demoData, 'function');
});
