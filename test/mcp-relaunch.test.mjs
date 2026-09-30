import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright-core';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { httpServer } from './helpers.mjs';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const browserType = { chromium, firefox, webkit }[process.env.JEV_BROWSER ?? 'chromium'];
const freePort = () => new Promise((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); }); });
// A Playwright browser server stands in for a remote browser that is not up yet, then goes away.
async function remoteBrowser(t) {
  const port = await freePort(), wsPath = `/${randomUUID()}`;
  let server;
  t.after(() => server?.close());
  return {
    endpoint: `ws://127.0.0.1:${port}${wsPath}`,
    async start() { server = await browserType.launchServer({ host: '127.0.0.1', port, wsPath }); },
    async stop() { await server.close(); server = undefined; },
  };
}
async function connect(t, args) {
  const site = await httpServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end('<h1>Reached</h1>'); });
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp', ...args], env: { ...process.env, JEV_API_KEY: '', TYPESAFE_API_KEY: '' }, stderr: 'pipe' });
  const client = new Client({ name: 'mcp-relaunch', version: '1' });
  t.after(async () => { await client.close(); await site.close(); });
  await client.connect(transport);
  return { client, site };
}
const code = result => result.isError ? JSON.parse(result.content.find(item => item.type === 'text').text).error.code : undefined;

test('a failed lazy MCP launch is not cached, so the next tool call can start the browser', async t => {
  const remote = await remoteBrowser(t);
  const { client, site } = await connect(t, ['--ws-endpoint', remote.endpoint]);
  const goto = () => client.callTool({ name: 'browser_goto', arguments: { url: site.url } });
  const refused = await goto();
  assert.equal(refused.isError, true, 'nothing listens at the endpoint yet');
  await remote.start();
  const reached = await goto();
  assert.equal(code(reached), undefined, JSON.stringify(reached.content));
  assert.equal(reached.structuredContent.url, site.url + '/');
});

for (const screenOnly of [false, true]) {
  test(`a disconnected MCP browser ${screenOnly ? 'ends a screen-only session' : 'is replaced by the next tool call'}`, async t => {
    const remote = await remoteBrowser(t);
    await remote.start();
    const { client, site } = await connect(t, ['--ws-endpoint', remote.endpoint, ...(screenOnly ? ['--screen-only'] : [])]);
    const call = () => screenOnly ? client.callTool({ name: 'browser_screen', arguments: { action: 'look' } }) : client.callTool({ name: 'browser_goto', arguments: { url: site.url } });
    const first = await call();
    assert.equal(code(first), undefined, JSON.stringify(first.content));
    // The remote browser goes away and comes back at the same endpoint.
    await remote.stop();
    await remote.start();
    const next = await call();
    if (screenOnly) assert.equal(code(next), 'CLOSED', 'a lost visual journey is not silently replaced');
    else { assert.equal(code(next), undefined, JSON.stringify(next.content)); assert.equal(next.structuredContent.url, site.url + '/'); }
  });
}
