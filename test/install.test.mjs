import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const cli = new URL('../dist/cli.js', import.meta.url);
const run = (...args) => spawnSync(process.execPath, [cli.pathname, ...args], { encoding: 'utf8' });

test('install --dry-run plans the browser of the bundled Playwright without downloading', () => {
  const result = run('install', 'chromium', '--dry-run');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Install location:/);
  assert.equal(result.stdout, '');
});

test('install honours --browser and rejects unknown names', () => {
  assert.equal(run('install', '--browser', 'firefox', '--dry-run').status, 0);
  const bad = run('install', 'netscape', '--dry-run');
  assert.notEqual(bad.status, 0);
});
