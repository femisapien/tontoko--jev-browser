import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { apiResult, httpServer } from '../test/helpers.mjs';

/** Installed opt-in image understanding: SDK screenDecide, CLI screen_decide and MCP browser_screen_decide against local stubs. */
export async function checkInstalledVision(pkg, directory, baseEnv) {
  const page = '<title>PRIVATE_TITLE</title><button aria-label="PRIVATE_ARIA" style="position:absolute;left:20px;top:20px;width:160px;height:50px">Save</button>';
  const site = await httpServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(page); });
  const images = [], decisions = [];
  const vision = await httpServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    images.push({ raw, authorization: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: 'A button labelled Save near (100,45).' } }], model: 'stub-vl', usage: { prompt_tokens: 30, completion_tokens: 9 } }));
  });
  const provider = await httpServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw); decisions.push(raw);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(apiResult(request, () => request.state?.visual?.interpretation?.includes('Save') ? 'save' : 'unknown')));
  });
  const env = { ...baseEnv, JEV_API_KEY: '', TYPESAFE_API_KEY: '', JEV_BASE_URL: provider.url, JEV_VISION_API_KEY: 'installed-vision-key' };
  const questions = { control: { instructions: 'Which visible control saves?', criteria: { save: 'A control labelled Save', unknown: 'Not identifiable' } } };
  const flags = ['--vision-base-url', `${vision.url}/v1`, '--vision-model', 'stub-vl'];
  const run = args => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', v => stdout += v); child.stderr.on('data', v => stderr += v);
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Installed vision process timed out.')); }, 60000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); try { resolve({ code, ...JSON.parse(stdout) }); } catch { reject(new Error(`Installed vision process did not return JSON: ${stdout} ${stderr}`)); } });
  });
  const cli = args => run([join(pkg, 'dist', 'cli.js'), ...args]);
  const textOnly = () => {
    assert.ok(images.length > 0 && decisions.length === images.length);
    assert.ok(images.every(call => call.raw.includes('data:image/png;base64,') && !call.raw.includes('PRIVATE_') && !call.raw.includes('Which visible control')));
    assert.ok(decisions.every(raw => !raw.includes('data:image') && !raw.includes('PRIVATE_') && !raw.includes('installed-vision-key')));
  };
  let client;
  try {
    const sdk = await run(['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { JevBrowser, ChatCompletionsImageUnderstanding, decideFromScreen } from '@tontoko/jev-browser';
      assert.equal(typeof decideFromScreen, 'function');
      const [site, base, questions] = JSON.parse(process.argv[1]);
      const core = await JevBrowser.launch({ vision: new ChatCompletionsImageUnderstanding({ baseURL: base, model: 'stub-vl' }) });
      try {
        await core.page.goto(site);
        const control = { type: 'choice', ...questions.control };
        const result = await core.screenDecide({ questions: { control } });
        assert.equal(result.decision.answers.control.choice, 'save');
        await core.screen({ action: 'move', observationId: result.evidence.observationId, x: 100, y: 45 });
        console.log(JSON.stringify({ installedVisionSDK: true }));
      } finally { await core.close(); }
    `, JSON.stringify([site.url, `${vision.url}/v1`, questions])]);
    assert.equal(sdk.code, 0); assert.equal(sdk.installedVisionSDK, true);
    assert.equal(images.at(-1).authorization, undefined);
    try {
      const opened = await cli(['open', site.url, '--session', 'installed-vision', '--screen-only', ...flags]); assert.equal(opened.code, 0);
      const decided = await cli(['screen_decide', '--session', 'installed-vision', '--args', JSON.stringify({ questions })]);
      assert.equal(decided.code, 0, JSON.stringify(decided)); assert.equal(decided.result.decision.answers.control.choice, 'save');
      assert.equal(images.at(-1).authorization, 'Bearer installed-vision-key');
      const mismatch = await cli(['open', '--session', 'installed-vision', '--screen-only']); assert.equal(mismatch.error.code, 'SESSION_MODE_MISMATCH');
    } finally { await cli(['close', '--session', 'installed-vision']); }
    client = new Client({ name: 'installed-vision-proof', version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(pkg, 'dist', 'mcp-stdio.js'), '--url', site.url, ...flags], cwd: directory, env, stderr: 'pipe' }));
    assert.ok((await client.listTools()).tools.some(tool => tool.name === 'browser_screen_decide'));
    const result = await client.callTool({ name: 'browser_screen_decide', arguments: { questions } });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.equal(result.structuredContent.decision.answers.control.choice, 'save');
    textOnly();
    return { installedVisionSDK: true, installedVisionCLI: true, installedVisionMCP: true };
  } finally {
    await client?.close();
    for (const server of [site, vision, provider]) await server.close();
  }
}
