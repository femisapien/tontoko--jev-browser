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
