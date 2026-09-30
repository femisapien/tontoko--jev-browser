import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { JevBrowser, BrowserError } from '../dist/index.js';
import { publicError } from '../dist/errors.js';
import { createMcpServer } from '../dist/mcp.js';
import { fixtureBrowser, engine, select, httpServer } from './helpers.mjs';

let browser;
before(async()=>{browser=await fixtureBrowser();});
after(async()=>{await browser?.close();});
async function fixture(t,html,decider=engine(()=>'__none__'),options={}) {
  const context=await browser.newContext();const page=await context.newPage();await page.setContent(html);
  const core=new JevBrowser({page,engine:decider,...options});
  t.after(async()=>{await core.close();await context.close();});return {page,core};
}
const overlay='<button onclick="document.body.dataset.hit=1">Save</button><div style="position:fixed;inset:0;background:rgba(0,0,0,.3)">Cookie banner PRIVATE-PAGE-TEXT</div>';
const cliFile=fileURLToPath(new URL('../dist/cli.js',import.meta.url));
function cli(args,cwd,env) {
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[cliFile,...args],{cwd,env:{...process.env,JEV_API_KEY:'',TYPESAFE_API_KEY:'',...env},stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('CLI command timed out'));},30000);
    child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr});});
  });
}

test('a click under a covering element is TARGET_OBSCURED, not an interrupted action',async t=>{
  const {core,page}=await fixture(t,overlay,select(c=>c.kind==='click'),{timeoutMs:1500});
  const error=await core.act('Click Save').then(()=>assert.fail('covered click resolved'),error=>error);
  assert.equal(error.code,'TARGET_OBSCURED');assert.equal(error.retryable,false);assert.match(error.cause.message,/intercepts pointer events/);
  assert.equal(await page.locator('body').getAttribute('data-hit'),null);
  const wire=JSON.stringify(publicError(error));
  assert.equal(wire.includes('PRIVATE-PAGE-TEXT'),false);assert.equal(wire.includes('<div'),false);
  await assert.rejects(core.native({command:'click',target:'button'},{timeoutMs:1500}),{code:'TARGET_OBSCURED'});
  assert.equal(await page.locator('body').getAttribute('data-hit'),null);
});
test('selector and navigation failures keep distinct codes, local causes and sanitized details',async t=>{
  const closed=await httpServer((req,res)=>res.end());const port=new URL(closed.url).port;await closed.close();
  const {core,page}=await fixture(t,'<p>First PRIVATE-PAGE-TEXT</p><p>Second</p><button onclick="document.body.dataset.hit=1">Save</button>');
  const ambiguous=await core.native({command:'click',target:'p'}).then(()=>assert.fail('ambiguous click resolved'),error=>error);
  assert.ok(ambiguous instanceof BrowserError);assert.equal(ambiguous.code,'AMBIGUOUS_TARGET');assert.match(ambiguous.message,/matched 2 elements/);
  assert.match(ambiguous.cause.message,/strict mode violation/);assert.equal(publicError(ambiguous).message.includes('PRIVATE-PAGE-TEXT'),false);
  assert.equal(await page.locator('body').getAttribute('data-hit'),null);
  await assert.rejects(core.snapshot({scope:'div['}),error=>error.code==='INVALID_SELECTOR'&&/div\[/.test(error.message));
  await assert.rejects(core.native({command:'click',target:'div['}),{code:'INVALID_SELECTOR',retryable:false});
  const navigation=await core.goto(`http://127.0.0.1:${port}/account?token=PRIVATE-QUERY#PRIVATE-FRAGMENT`).then(()=>assert.fail('navigation resolved'),error=>error);
  assert.equal(navigation.code,'NAVIGATION_FAILED');assert.equal(/PRIVATE/.test(navigation.message),false);assert.ok(navigation.cause instanceof Error);
  // Chromium names the failed URL in the first line; the query and fragment are removed from it.
  if(!process.env.JEV_BROWSER||process.env.JEV_BROWSER==='chromium')assert.match(navigation.message,new RegExp(`127\\.0\\.0\\.1:${port}/account`));
  const wire=publicError(navigation);assert.equal('cause' in wire,false);assert.equal(JSON.stringify(navigation).includes('PRIVATE'),false);
});
test('unexpected errors stay sanitized while timeouts and aborts are told apart',()=>{
  const evaluation=publicError(new Error('page.evaluate: Error: PRIVATE-PAGE-TEXT\n    at eval'));
  assert.equal(evaluation.code,'OPERATION_FAILED');assert.equal(evaluation.retryable,false);assert.equal(evaluation.message.includes('PRIVATE'),false);
  assert.deepEqual([publicError(new DOMException('late','TimeoutError')).code,publicError(new DOMException('stop','AbortError')).code],['TIMEOUT','CANCELLED']);
  const original=new Error('local diagnostic'),error=new BrowserError('PROVIDER_ERROR','Jev request failed; no browser action was retried.',{cause:original,retryable:true});
  assert.equal(error.cause,original);assert.equal(JSON.stringify(error).includes('local diagnostic'),false);
  assert.deepEqual(publicError(error),{code:'PROVIDER_ERROR',message:'Jev request failed; no browser action was retried.',retryable:true});
  assert.equal(publicError(new BrowserError('STALE_TARGET','Observe again.')).retryable,false);
});
test('MCP errors add retryable while keeping stable codes and messages',async t=>{
  const {core}=await fixture(t,'<p>First</p><p>Second</p>',undefined,{timeoutMs:300});
  const server=createMcpServer(core),client=new Client({name:'error-causes',version:'1'});
  const [ct,st]=InMemoryTransport.createLinkedPair();
  t.after(async()=>{await client.close();await server.close();});
  await server.connect(st);await client.connect(ct);
  const call=async(name,args)=>{const result=await client.callTool({name,arguments:args});assert.equal(result.isError,true);return JSON.parse(result.content[0].text).error;};
  const waited=await call('browser_wait_for',{text:'Never shown'});
  assert.equal(waited.code,'TIMEOUT');assert.equal(waited.retryable,true);assert.match(waited.message,/300 ms/);
  const clicked=await call('browser_click',{target:'p'});
  assert.deepEqual(Object.keys(clicked).sort(),['code','message','retryable']);assert.equal(clicked.code,'AMBIGUOUS_TARGET');assert.equal(clicked.retryable,false);
});
test('a missing browser build reports BROWSER_LAUNCH_FAILED with the install command',async t=>{
  const empty=await mkdtemp(join(tmpdir(),'jev-no-browsers-'));
  t.after(()=>rm(empty,{recursive:true,force:true,maxRetries:8,retryDelay:125}));
  const result=await cli(['snapshot'],empty,{PLAYWRIGHT_BROWSERS_PATH:empty,JEV_SESSION_DIR:join(empty,'sessions')});
  assert.equal(result.code,1,result.stdout+result.stderr);
  const {error}=JSON.parse(result.stdout);
  assert.equal(error.code,'BROWSER_LAUNCH_FAILED');assert.match(error.message,/jev-browser install (chromium|firefox|webkit)/);assert.equal(error.message.includes(empty),false);
});
