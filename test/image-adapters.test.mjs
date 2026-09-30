import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { JevBrowser } from '../dist/index.js';
import { createMcpServer } from '../dist/mcp.js';
import { executeCommand, parseCommand } from '../dist/commands.js';
import { apiResult, httpServer } from './helpers.mjs';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const page = '<title>PRIVATE_TITLE</title><button aria-label="PRIVATE_ARIA" style="position:absolute;left:20px;top:20px;width:160px;height:50px" onclick="this.textContent=\'Saved\'">Save</button><i hidden>PRIVATE_DOM</i>';
const caption = 'A button labelled Save near (100,45). Nothing else is readable.';
const questions = { control: { instructions: 'Which visible control matches the goal?', criteria: { save: 'A control visibly labelled Save', unknown: 'Not identifiable from the description' } } };
const sdkQuestions = { control: { type: 'choice', ...questions.control } };

/** A local OpenAI-compatible Chat Completions stub that records what it receives. */
async function visionServer(t, reply = () => ({ choices: [{ message: { content: caption } }], model: 'stub-vl', usage: { prompt_tokens: 40, completion_tokens: 12 } })) {
  const calls = [];
  const server = await httpServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    calls.push({ path: req.url, authorization: req.headers.authorization, raw, body: JSON.parse(raw) });
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(reply()));
  });
  t.after(() => server.close());
  return { calls, url: `${server.url}/v1` };
}
/** A local System One stub reached through JEV_BASE_URL, answering from the description only. */
async function decisionServer(t) {
  const calls = [];
  const server = await httpServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw);
    calls.push({ authorization: req.headers.authorization, raw, request });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(apiResult(request, () => request.state?.visual?.interpretation?.includes('Save') ? 'save' : 'unknown')));
  });
  t.after(() => server.close());
  return { calls, url: server.url };
}
function assertBoundaries(vision, decision, frameData) {
  assert.equal(vision.calls.length, 1); assert.equal(decision.calls.length, 1);
  const image = vision.calls[0];
  assert.equal(image.path, '/v1/chat/completions');
  assert.equal(image.body.messages[1].content.filter(item => item.type === 'image_url').length, 1);
  if (frameData) assert.equal(image.body.messages[1].content[1].image_url.url, `data:image/png;base64,${frameData}`);
  // The image endpoint gets pixels and geometry only; the decision endpoint gets text only.
  for (const hidden of ['PRIVATE_', 'Which visible control', 'Save the form']) assert.equal(image.raw.includes(hidden), false, hidden);
  assert.equal(decision.calls[0].raw.includes('PRIVATE_'), false);
  assert.equal(decision.calls[0].raw.includes('data:image'), false);
  assert.equal(decision.calls[0].request.state.visual.interpretation, caption);
  assert.equal(decision.calls[0].request.questions.control.type, 'choice');
}

test('SDK screenDecide refuses without a configured image endpoint before capturing', async t => {
  const core = await JevBrowser.launch({ engine: { decide: async () => { throw new Error('must not decide'); } } });
  t.after(() => core.close());
  assert.equal(core.hasVision, false);
  await assert.rejects(core.screenDecide({ questions: sdkQuestions }), { code: 'CONFIG' });
  await assert.rejects(JevBrowser.launch({ vision: { baseURL: 'http://vision.example.test/v1', model: 'm' } }), { code: 'CONFIG' });
});

test('SDK screenDecide captures once, describes pixels only, decides from text only, and leaves the observation current', async t => {
  const vision = await visionServer(t), decided = [];
  const core = await JevBrowser.launch({ contextOptions: { viewport: { width: 320, height: 200 } }, vision: { baseURL: vision.url, model: 'stub-vl', apiKey: 'vision-test-only' },
    engine: { decide: async request => { decided.push(structuredClone(request)); return { answers: { control: { choice: 'save', confidence: 0.7 } }, model: 'fixture' }; } } });
  t.after(() => core.close());
  assert.equal(core.hasVision, true);
  assert.equal(JSON.stringify(core).includes('vision-test-only'), false);
  await core.page.setContent(page);
  const result = await core.screenDecide({ questions: sdkQuestions, state: { goal: 'Save the form' } });
  assert.equal(vision.calls.length, 1); assert.equal(decided.length, 1);
  assert.equal(vision.calls[0].authorization, 'Bearer vision-test-only');
  assert.equal(vision.calls[0].raw.includes('Save the form'), false);
  assert.equal(vision.calls[0].raw.includes('PRIVATE_'), false);
  assert.equal(JSON.stringify(decided).includes('PRIVATE_'), false);
  assert.equal(decided[0].state.context.goal, 'Save the form');
  assert.equal(result.decision.answers.control.choice, 'save');
  assert.deepEqual(result.evidence.viewport, { width: 320, height: 200 });
  assert.deepEqual(result.evidence.usage, { input_tokens: 40, output_tokens: 12 });
  // The capture is the current screen observation: input with it is accepted, and the page is unchanged until then.
  assert.equal(await core.page.locator('button').textContent(), 'Save');
  await core.screen({ action: 'click', observationId: result.evidence.observationId, x: 100, y: 45 });
  assert.equal(await core.page.locator('button').textContent(), 'Saved');
});

test('screen-only cores allow screen_decide; MCP lists it only when an image endpoint is configured', async t => {
  const vision = await visionServer(t);
  const core = await JevBrowser.launch({ screenOnly: true, vision: { baseURL: vision.url, model: 'stub-vl' },
    engine: { decide: async () => ({ answers: { control: { choice: 'save', confidence: 0.9 } } }) } });
  const plain = await JevBrowser.launch({ screenOnly: true });
  t.after(async () => { await core.close(); await plain.close(); });
  await core.page.setContent(page);
  const direct = await executeCommand(core, parseCommand({ command: 'screen_decide', questions }));
  assert.equal(direct.decision.answers.control.choice, 'save');
  await assert.rejects(executeCommand(core, parseCommand({ command: 'snapshot' })), { code: 'SCREEN_ONLY' });
  assert.throws(() => parseCommand({ command: 'screen_decide', questions: {} }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => parseCommand({ command: 'screen_decide', questions: { q: { instructions: 'x', criteria: { only: 'one' } } } }), { code: 'INVALID_ARGUMENT' });
  const tools = async target => {
    const server = createMcpServer(target), client = new Client({ name: 'vision-tools', version: '1' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st); await client.connect(ct);
    t.after(async () => { await client.close(); await server.close(); });
    return client;
  };
  const client = await tools(core);
  const listed = (await client.listTools()).tools;
  assert.deepEqual(listed.map(tool => tool.name).sort(), ['browser_close', 'browser_screen', 'browser_screen_decide']);
  const schema = listed.find(tool => tool.name === 'browser_screen_decide').inputSchema;
  assert.equal(schema.type, 'object'); assert.equal('oneOf' in schema, false); assert.equal('anyOf' in schema, false);
  const result = await client.callTool({ name: 'browser_screen_decide', arguments: { questions } });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(result.content.some(item => item.type === 'image'), false);
  assert.equal(result.structuredContent.evidence.interpretation, caption);
  assert.deepEqual((await (await tools(plain)).listTools()).tools.map(tool => tool.name).sort(), ['browser_close', 'browser_screen']);
  assert.equal((await (await tools(() => Promise.resolve(plain))).listTools()).tools.some(tool => tool.name === 'browser_screen_decide'), false);
});

test('CLI sessions fix the image endpoint at open, send only JEV_VISION_API_KEY to it, and reach Jev with text only', async t => {
  const vision = await visionServer(t), decision = await decisionServer(t);
  const site = await httpServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(page); });
  const directory = await mkdtemp(join(tmpdir(), 'jev-vision-cli-'));
  t.after(async () => { await site.close(); await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 }); });
  const env = { ...process.env, JEV_API_KEY: 'hosted-key-test-only', TYPESAFE_API_KEY: '', JEV_ENDPOINT_API_KEY: '', JEV_BASE_URL: decision.url, JEV_VISION_API_KEY: 'vision-key-test-only', JEV_SESSION_DIR: join(directory, 'sessions') };
  const run = args => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = '', stderr = '';
    child.stdout.on('data', d => stdout += d); child.stderr.on('data', d => stderr += d); child.once('error', reject);
    child.once('close', code => { try { resolve({ code, value: JSON.parse(stdout) }); } catch { reject(new Error(`CLI did not return JSON: ${stdout} ${stderr}`)); } });
  });
  const flags = ['--vision-base-url', vision.url, '--vision-model', 'stub-vl'];
  try {
    const half = await run(['open', site.url, '--session', 'half', '--vision-model', 'stub-vl']);
    assert.equal(half.code, 1); assert.equal(half.value.error.code, 'INVALID_ARGUMENT');
    const insecure = await run(['open', site.url, '--session', 'insecure', '--vision-base-url', 'http://vision.example.test/v1', '--vision-model', 'stub-vl']);
    assert.equal(insecure.code, 1); assert.equal(insecure.value.error.code, 'CONFIG');
    const opened = await run(['open', site.url, '--session', 'visual', ...flags]); assert.equal(opened.code, 0, JSON.stringify(opened.value));
    const result = await run(['screen_decide', '--session', 'visual', '--args', JSON.stringify({ questions, state: { goal: 'Save the form' } })]);
    assert.equal(result.code, 0, JSON.stringify(result.value));
    assert.equal(result.value.result.decision.answers.control.choice, 'save');
    assertBoundaries(vision, decision);
    assert.equal(vision.calls[0].authorization, 'Bearer vision-key-test-only');
    // A custom decision endpoint never receives the hosted key, and neither endpoint receives the other's key.
    assert.equal(decision.calls[0].raw.includes('vision-key-test-only'), false);
    assert.notEqual(decision.calls[0].authorization, 'Bearer vision-key-test-only');
    assert.notEqual(decision.calls[0].authorization, 'Bearer hosted-key-test-only');
    const reused = await run(['open', '--session', 'visual', ...flags]); assert.equal(reused.code, 0); assert.equal(reused.value.result.reused, true);
    const changed = await run(['open', '--session', 'visual']); assert.equal(changed.code, 1); assert.equal(changed.value.error.code, 'SESSION_MODE_MISMATCH');
    const plain = await run(['open', site.url, '--session', 'plain']); assert.equal(plain.code, 0);
    const refused = await run(['screen_decide', '--session', 'plain', '--args', JSON.stringify({ questions })]);
    assert.equal(refused.code, 1); assert.equal(refused.value.error.code, 'CONFIG'); assert.match(refused.value.error.message, /--vision-base-url/);
    assert.equal(vision.calls.length, 1);
  } finally { for (const name of ['visual', 'plain']) await run(['close', '--session', name]); }
});

test('MCP stdio exposes browser_screen_decide only with --vision-base-url and --vision-model', async t => {
  const vision = await visionServer(t), decision = await decisionServer(t);
  const site = await httpServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(page); });
  t.after(() => site.close());
  const env = { ...process.env, JEV_API_KEY: '', TYPESAFE_API_KEY: '', JEV_BASE_URL: decision.url, JEV_VISION_API_KEY: '' };
  const connect = async args => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp', '--url', site.url, ...args], env, stderr: 'pipe' });
    const client = new Client({ name: 'vision-stdio', version: '1' });
    await client.connect(transport);
    t.after(async () => { const closed = transport._process ? once(transport._process, 'close') : undefined; await client.close(); await closed; });
    return client;
  };
  const plain = await connect([]);
  assert.equal((await plain.listTools()).tools.some(tool => tool.name === 'browser_screen_decide'), false);
  const client = await connect(['--screen-only', '--vision-base-url', vision.url, '--vision-model', 'stub-vl']);
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), ['browser_close', 'browser_screen', 'browser_screen_decide']);
  const result = await client.callTool({ name: 'browser_screen_decide', arguments: { questions, state: { goal: 'Save the form' } } });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assertBoundaries(vision, decision);
  assert.equal(vision.calls[0].authorization, undefined);
  const observationId = result.structuredContent.evidence.observationId;
  const click = await client.callTool({ name: 'browser_screen', arguments: { action: 'click', observationId, x: 100, y: 45 } });
  assert.notEqual(click.isError, true, JSON.stringify(click));
});
