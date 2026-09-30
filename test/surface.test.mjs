import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import * as sdk from '../dist/index.js';
import '../dist/mcp.js';
import '../dist/playwright.js';
test('SDK exposes the shared browser core and Jev decision engine', () => {
  assert.equal(typeof sdk.JevBrowser, 'function');
  assert.equal(typeof sdk.JevDecisionEngine, 'function');
});
test('public entry points never load Playwright Test into the caller process', async () => {
  // Playwright Test marks the process when it loads and refuses a second copy, such as the caller's own runner.
  assert.equal(process.__pw_initiator__, undefined);
  const dist = new URL('../dist/', import.meta.url);
  for (const name of (await readdir(dist)).filter(name => /\.c?js$/.test(name)))
    assert.doesNotMatch(await readFile(new URL(name, dist), 'utf8'), /['"`](?:@playwright\/test|playwright\/test)(?:\/[^'"`]*)?['"`]/, name);
});
