import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {JevBrowser,JevDecisionEngine} from '../dist/index.js';
import {fixtureBrowser,engine,httpServer,apiResult} from './helpers.mjs';

let browser,server,root;
before(async()=>{
 browser=await fixtureBrowser();root=await mkdtemp(join(tmpdir(),'jev-core-followups-'));
 server=await httpServer((req,res)=>{
  if(req.url.startsWith('/dl/')){res.setHeader('Content-Type','application/octet-stream');res.setHeader('Content-Disposition',`attachment; filename="${req.url.slice(4)}.txt"`);res.end(req.url);return;}
  res.setHeader('Content-Type','text/html');res.end('<p>'+req.url+'</p><input type=file id=f>');
 });
});
after(async()=>{await server?.close();await browser?.close();await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:125});});
async function fixture(t,options={}){
 const context=await browser.newContext({acceptDownloads:true});const page=await context.newPage();
 const core=new JevBrowser({page,fileRoots:[root],outputDir:root,...options});
 t.after(async()=>{await core.close();await context.close();});
 return {core,page,context};
}
const downloaded=async(page,name)=>{const event=page.waitForEvent('download');await page.evaluate(name=>{const a=document.createElement('a');a.href='/dl/'+name;document.body.append(a);a.click();a.remove();},name);await event;};

test('an empty or blank model setting is unset, like the other decision settings',async()=>{
 const request={state:{screen:'synthetic'},questions:{action:{type:'choice',instructions:'Choose',criteria:{a:'A',__none__:'None'}}}};
 const saved=process.env.JEV_MODEL;
 const models=[];const fetch=async(_url,init)=>{const body=JSON.parse(init.body);models.push(body.model);return Response.json(apiResult(body));};
 try{
  delete process.env.JEV_MODEL;
  await new JevDecisionEngine({apiKey:'test-only',fetch}).decide(request);
  process.env.JEV_MODEL='env-model';
  await new JevDecisionEngine({apiKey:'test-only',model:'',fetch}).decide(request);
  await new JevDecisionEngine({apiKey:'test-only',model:'  ',fetch}).decide(request);
  process.env.JEV_MODEL='';
  await new JevDecisionEngine({apiKey:'test-only',fetch}).decide(request);
  process.env.JEV_MODEL=' pinned ';
  await new JevDecisionEngine({apiKey:'test-only',fetch}).decide(request);
 }finally{if(saved===undefined)delete process.env.JEV_MODEL;else process.env.JEV_MODEL=saved;}
 // Unset falls back to the SDK default, never an empty model name.
 const [fallback,...rest]=models;assert.ok(fallback);
 assert.deepEqual(rest,['env-model','env-model',fallback,'pinned']);
});

test('run rejects invalid scope syntax as INVALID_SELECTOR before observing or asking a model',async t=>{
 const decider=engine(()=>'__none__');
 const {core,page}=await fixture(t,{engine:decider});await page.setContent('<button>Save</button>');
 const error=await core.run('Click Save',{scope:'div['}).then(()=>assert.fail('run resolved'),error=>error);
 assert.equal(error.code,'INVALID_SELECTOR');assert.equal(error.partial,undefined);assert.equal(decider.requests.length,0);
});

function resumeEngine(){
 return engine((question,request,name)=>{
  if(name.startsWith('bind_')){
   const input=request.state.inputs.find(input=>question.instructions.includes(JSON.stringify(input.path)));
   return request.state.page.elements.find(element=>element.fieldName===input?.path)?.id??'__none__';
  }
  if(name.startsWith('effect_'))return request.state.actions?.[name.slice('effect_'.length)]?.target?.name?.startsWith('Save ')?'commit':'advance';
  if(name==='completion')return 'continue';
  if(name.startsWith('read_')){
   const input=request.state.inputs.find(input=>question.instructions.includes(JSON.stringify(input.path)));
   return request.state.sources.find(source=>source.text===`[input:${input?.path}]`)?.id??'__none__';
  }
  if(name==='action')return candidate=>candidate?.kind==='click'&&candidate.target?.name==='Save account';
  return '__none__';
 });
}
async function resumable(t,context){
 const service=await httpServer(async(req,res)=>{
  if(req.url==='/account'){for await(const _ of req);res.setHeader('Content-Type','application/json');res.end('{}');return;}
  res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<main><div id="editor"><form><label>Reference<input name="/reference" required></label><button type="button">Save account</button></form></div><section id="results"></section></main><script>
   const editor=document.querySelector('#editor'),results=document.querySelector('#results');
   editor.querySelector('button').onclick=async()=>{const reference=editor.querySelector('input').value;await fetch('/account',{method:'POST',body:JSON.stringify({reference})});const a=document.createElement('article');a.innerHTML='<h2>Account created</h2><dl><dt>reference</dt><dd></dd></dl>';a.querySelector('dd').textContent=reference;results.append(a);editor.innerHTML='<form><label>Membership code<input name="/membershipCode" required></label><button type="button">Save membership</button></form>';};
  </script>`);
 });
 t.after(()=>service.close());
 const page=await context.newPage();await page.goto(service.url);
 return {page,url:service.url};
}
const stop='Save the account, then save its membership. Do not finish before both exist.';

test('continuations are bounded LRU entries; an evicted one is CONTINUATION_NOT_FOUND',async t=>{
 const context=await browser.newContext();t.after(()=>context.close());
 const {page}=await resumable(t,context);const core=new JevBrowser({page,engine:resumeEngine()});t.after(()=>core.close());
 const first=await core.run(stop,{values:{reference:'ref'}});assert.ok(first.continuation);
 const id=first.continuation.id,state=core.continuations.get(id);
 // Fill the store with copies of a real paused state; a real run per entry is needlessly slow.
 for(let i=0;i<31;i++)core.storeContinuation('filler-'+i,{...state});
 assert.equal(core.continuations.size,32);
 // Resuming uses the oldest entry, so the next insertion evicts the oldest filler instead.
 const resumed=await core.resume(id);assert.equal(resumed.continuation?.id,id);
 core.storeContinuation('filler-31',{...state});
 assert.equal(core.continuations.size,32);assert.equal(core.continuations.has(id),true);
 await assert.rejects(core.resume('filler-0'),{code:'CONTINUATION_NOT_FOUND'});
 for(let i=0;i<32;i++)core.storeContinuation('later-'+i,{...state});
 await assert.rejects(core.resume(id),{code:'CONTINUATION_NOT_FOUND'});
});

test('closing the continuation Page drops its continuations',async t=>{
 const context=await browser.newContext();t.after(()=>context.close());
 const {page}=await resumable(t,context);const core=new JevBrowser({page,engine:resumeEngine()});t.after(()=>core.close());
 const result=await core.run(stop,{values:{reference:'ref'}});assert.ok(result.continuation);
 await page.close();
 assert.equal(core.continuations.size,0);
 await assert.rejects(core.resume(result.continuation.id),{code:'CONTINUATION_NOT_FOUND'});
});

test('a closed selected tab is TAB_CLOSED until another tab is selected; Jev does not switch by itself',async t=>{
 const {core,page}=await fixture(t);await core.goto(server.url+'/a');
 await core.native({command:'tabs',action:'new',url:server.url+'/b'});
 const closed=core.page;await closed.close();
 const error=await core.snapshot().then(()=>assert.fail('snapshot resolved'),error=>error);
 assert.equal(error.code,'TAB_CLOSED');assert.match(error.message,/tabs.*select/);
 await assert.rejects(core.native({command:'click',target:'p'}),{code:'TAB_CLOSED'});
 assert.equal(core.page,closed);
 const tabs=(await core.native({command:'tabs',action:'list'})).tabs;
 assert.equal(tabs.length,1);assert.equal(tabs.some(tab=>tab.selected),false);
 await core.native({command:'tabs',action:'select',index:0});
 assert.equal(core.page,page);assert.match((await core.snapshot()).url,/\/a$/);
});
