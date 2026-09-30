import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as turn } from 'node:timers/promises';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createMcpServer } from '../dist/mcp.js';
import { JevBrowser } from '../dist/index.js';
import { fixtureBrowser } from './helpers.mjs';

let browser;
before(async () => { browser = await fixtureBrowser(); });
after(async () => { await browser?.close(); });

// Each decision waits until the test releases it, so an operation can be held inside the core.
function heldEngine() {
  const calls = []; let arrived = () => {};
  return {
    calls, arrival: () => new Promise(resolve => { arrived = resolve; }),
    async decide(request, { signal } = {}) {
      let release; const released = new Promise(resolve => { release = resolve; });
      calls.push({ request, release }); arrived();
      await new Promise((resolve, reject) => { released.then(resolve); signal?.addEventListener('abort', () => reject(signal.reason), { once: true }); });
      return { answers: Object.fromEntries(Object.keys(request.questions).map(name => [name, { choice: '__none__', confidence: 0.95 }])), model: 'held-test-engine', elapsedMs: 0 };
    },
  };
}
async function connect(t, engine) {
  const context = await browser.newContext(); const page = await context.newPage();
  await page.setContent('<h1>Ready</h1><button>Go</button>');
  const core = new JevBrowser({ page, engine });
  const server = createMcpServer(core); const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'mcp-queue', version: '1' });
  t.after(async () => { await client.close(); await server.close(); await core.close(); await context.close(); });
  await server.connect(st); await client.connect(ct);
  return { client, core };
}
const error = result => JSON.parse(result.content.find(item => item.type === 'text').text).error;
const settled = promise => { const state = { done: false }; promise.then(() => { state.done = true; }, () => { state.done = true; }); return state; };

test('parallel MCP tool calls run one at a time in arrival order instead of returning BUSY', async t => {
  const engine = heldEngine(); const { client } = await connect(t, engine);
  const order = [], arrival = engine.arrival();
  const observe = client.callTool({ name: 'browser_observe', arguments: { instruction: 'Click Go' } }).then(result => { order.push('observe'); return result; });
  await arrival;
  const snapshot = client.callTool({ name: 'browser_snapshot', arguments: {} }).then(result => { order.push('snapshot'); return result; });
  const tabs = client.callTool({ name: 'browser_tabs', arguments: { action: 'list' } }).then(result => { order.push('tabs'); return result; });
  const waiting = [settled(snapshot), settled(tabs)];
  // The in-memory transport delivers synchronously; one macrotask lets both requests reach the adapter.
  await turn();
  assert.deepEqual(waiting.map(state => state.done), [false, false], 'later calls wait for the running call');
  engine.calls[0].release();
  const results = await Promise.all([observe, snapshot, tabs]);
  for (const result of results) assert.notEqual(result.isError, true, JSON.stringify(result.content));
  assert.deepEqual(order, ['observe', 'snapshot', 'tabs']);
  assert.ok(results[1].structuredContent.texts.some(text => text.text === 'Ready'));
});

test('an explicit MCP timeoutMs includes time spent waiting behind an earlier call', async t => {
  const engine = heldEngine(); const { client } = await connect(t, engine);
  const arrival = engine.arrival();
  const observe = client.callTool({ name: 'browser_observe', arguments: { instruction: 'Click Go' } });
  await arrival;
  const queued = await client.callTool({ name: 'browser_resume', arguments: { continuationId: 'never-started', timeoutMs: 100 } });
  assert.equal(queued.isError, true);
  assert.equal(error(queued).code, 'TIMEOUT', 'the call timed out while waiting, without running');
  assert.equal(engine.calls.length, 1);
  engine.calls[0].release();
  assert.notEqual((await observe).isError, true);
});

test('a cancelled queued MCP call does not delay the calls behind it', async t => {
  const engine = heldEngine(); const { client } = await connect(t, engine);
  const arrival = engine.arrival();
  const observe = client.callTool({ name: 'browser_observe', arguments: { instruction: 'Click Go' } });
  await arrival;
  const abort = new AbortController();
  const cancelled = client.callTool({ name: 'browser_observe', arguments: { instruction: 'Never decided' } }, { signal: abort.signal });
  const snapshot = client.callTool({ name: 'browser_snapshot', arguments: {} });
  await turn(); abort.abort(); await assert.rejects(cancelled);
  engine.calls[0].release();
  assert.notEqual((await observe).isError, true); assert.notEqual((await snapshot).isError, true);
  assert.equal(engine.calls.length, 1, 'the cancelled call never reached the decision engine');
});

test('browser_close is not queued behind a running MCP call', async t => {
  const engine = heldEngine(); const { client, core } = await connect(t, engine);
  const arrival = engine.arrival();
  const observe = client.callTool({ name: 'browser_observe', arguments: { instruction: 'Click Go' } });
  await arrival;
  const closed = await client.callTool({ name: 'browser_close', arguments: {} });
  assert.equal(closed.structuredContent.status, 'closed');
  assert.equal(core.isClosed, true);
  assert.equal((await observe).isError, true, 'closing cancels the running operation');
});
