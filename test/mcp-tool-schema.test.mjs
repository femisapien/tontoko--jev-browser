import assert from 'node:assert/strict';
import test from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { parseCommand } from '../dist/commands.js';
import { JevBrowser } from '../dist/index.js';
import { createMcpServer } from '../dist/mcp.js';
import { fixtureBrowser } from './helpers.mjs';

async function connect(t, core) {
  const state = { starts: 0 };
  const server = createMcpServer(core ?? (async () => { state.starts++; throw new Error('Unexpected browser startup'); }));
  const client = new Client({ name: 'mcp-tool-schema', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(st); await client.connect(ct);
  return { client, state, tools: (await client.listTools()).tools };
}
function* nodes(schema) {
  if (!schema || typeof schema !== 'object') return;
  yield schema;
  for (const value of Object.values(schema)) yield* Array.isArray(value) ? value.flatMap(item => [...nodes(item)]) : nodes(value);
}

test('MCP tool fields are described and state cross-field rules without top-level combinators', async t => {
  const { tools } = await connect(t);
  const schema = name => tools.find(tool => tool.name === name).inputSchema;
  const undescribed = [];
  // browser_screen is projected from the screen action union and covered by screen-tool-schema.test.mjs.
  for (const tool of tools.filter(tool => tool.name !== 'browser_screen')) {
    assert.equal(tool.inputSchema.type, 'object', tool.name);
    for (const key of ['oneOf', 'anyOf', 'allOf']) assert.equal(tool.inputSchema[key], undefined, `${tool.name} must not use top-level ${key}`);
    for (const [name, field] of Object.entries(tool.inputSchema.properties ?? {})) if (!field.description?.trim()) undescribed.push(`${tool.name}.${name}`);
  }
  assert.deepEqual(undescribed, []);
  for (const name of ['instruction', 'planId']) assert.match(schema('browser_act').properties[name].description, /exactly one of instruction or planId/);
  for (const name of ['fields', 'schema']) assert.match(schema('browser_extract').properties[name].description, /exactly one of fields or schema/);
  assert.equal(schema('browser_act').required, undefined);
  assert.deepEqual(schema('browser_extract').required, ['instruction']);
  const item = schema('browser_fill_form').properties.fields.items.properties;
  for (const name of ['target', 'ref', 'type', 'value']) assert.ok(item[name].description, `fill_form field ${name}`);
});

test('MCP integer fields stay within the timer range and oversized values fail before browser startup', async t => {
  const { client, state, tools } = await connect(t);
  const oversized = tools.flatMap(tool => [...nodes(tool.inputSchema)].filter(node => node.type === 'integer' && !(node.maximum <= 2_147_483_647)).map(() => tool.name));
  assert.deepEqual(oversized, []);
  const run = z.fromJSONSchema(tools.find(tool => tool.name === 'browser_run').inputSchema);
  assert.ok(run.safeParse({ instruction: 'Save', timeoutMs: 2_147_483_647, maxSteps: 1, settleTimeoutMs: 1 }).success);
  assert.equal(run.safeParse({ instruction: 'Save', timeoutMs: 2_147_483_648 }).success, false);
  assert.equal(parseCommand({ command: 'resume', continuationId: 'c', timeoutMs: 2_147_483_647 }).timeoutMs, 2_147_483_647);
  assert.equal(parseCommand({ command: 'click', target: 'button', frame: 0 }).frame, 0);
  for (const input of [{ command: 'resume', continuationId: 'c', timeoutMs: 2 ** 31 }, { command: 'run', instruction: 'Save', maxSteps: 2 ** 53 - 1 }, { command: 'click', target: 'button', frame: 2 ** 31 }, { command: 'tabs', action: 'select', index: 2 ** 31 }])
    assert.throws(() => parseCommand(input), { code: 'INVALID_ARGUMENT' });
  // Node timers overflow above 2^31-1 ms, which previously cancelled the operation after about 1 ms.
  const result = await client.callTool({ name: 'browser_resume', arguments: { continuationId: 'c', timeoutMs: 2 ** 31 } });
  assert.equal(result.isError, true);
  assert.match(result.content.find(item => item.type === 'text').text, /timeoutMs/);
  assert.equal(state.starts, 0);
});

test('browser_select_option describes the value-or-label matching Playwright performs', async t => {
  const browser = await fixtureBrowser(); const context = await browser.newContext(); const page = await context.newPage(); const core = new JevBrowser({ page });
  t.after(async () => { await core.close(); await context.close(); await browser.close(); });
  await page.setContent('<select id=q><option value="2">1</option><option value="1">2</option><option value="b">Banana</option></select>');
  const { client, tools } = await connect(t, core);
  const { properties } = tools.find(tool => tool.name === 'browser_select_option').inputSchema;
  for (const name of ['values', 'by']) assert.match(properties[name].description, /value or label/);
  assert.match(properties.by.description, /label matches labels only/);
  const selected = async args => { const result = await client.callTool({ name: 'browser_select_option', arguments: { target: '#q', ...args } }); assert.notEqual(result.isError, true); return page.$eval('#q', select => select.value); };
  // Raw strings match the first option whose value or label is equal; only by label narrows the match.
  assert.equal(await selected({ values: ['1'], by: 'value' }), '2');
  assert.equal(await selected({ values: ['Banana'] }), 'b');
  assert.equal(await selected({ values: ['1'], by: 'label' }), '2');
  assert.equal(await selected({ values: ['2'], by: 'label' }), '1');
});
