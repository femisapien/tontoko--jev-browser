import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {JevBrowser} from '../dist/index.js';
import {fixtureBrowser} from './helpers.mjs';
import {orderWorkflowFixture} from './order-workflow-fixture.mjs';
let browser;before(async()=>{browser=await fixtureBrowser();});after(async()=>{await browser?.close();});

const instruction='Find the supplied order reference, edit its status and Save order once.';
function orderEngine(beforeAnswer){let calls=0;return {async decide(request){calls++;await beforeAnswer?.(calls,request);const answers={};for(const [id,q]of Object.entries(request.questions)){
  let choice='__none__';
  if(id.startsWith('bind_')){const field=q.instructions.includes('/orderReference')?'q17':'c82';choice=request.state.page.elements.find(e=>e.fieldName===field)?.id??'__none__';}
  else if(id.startsWith('effect_'))choice=request.state.actions[id.slice(7)]?.target?.name==='Save order'?'commit':'advance';
  else if(id==='action')choice=Object.entries(q.criteria).find(([,a])=>a?.kind==='click'&&(a.target?.name==='Search orders'||a.target?.name==='Save order'||a.target?.name==='Edit'&&a.target.context.includes('[input:/orderReference] Pending')))?.[0]??'__none__';
  else if(id==='completion')choice='complete';
  else if(id.startsWith('read_')){const field=q.instructions.includes('/orderReference')?'/orderReference':'/status';choice=request.state.sources.find(x=>x.text==='[input:'+field+']')?.id??'__none__';}
  answers[id]={choice,confidence:1};
 }return {answers};}};}
// The search response is held until the second decision has started from the still-shown search form,
// then that decision waits for the form to be replaced: event-driven, independent of runner speed.
async function heldSearch(t,page){
 let release;const held=new Promise(resolve=>{release=resolve;});t.after(()=>release());
 await page.route('**/search?**',async route=>{const response=await route.fetch();await held;await route.fulfill({response}).catch(()=>{});});
 return release;
}

test('run observation: a form replaced while deciding is reobserved rather than declared ambiguous',async t=>{
 const app=await orderWorkflowFixture(t),page=await browser.newPage();await page.goto(app.url);
 const release=await heldSearch(t,page);let sawForm=false;
 const engine=orderEngine(async(calls,request)=>{if(calls!==2)return;
  sawForm=request.state.page.elements.some(e=>e.name==='Search orders');release();
  await page.getByRole('heading',{name:'Matching orders'}).waitFor();
 });
 const core=new JevBrowser({page,engine});t.after(async()=>{await core.close();await page.close();});
 const result=await core.run(instruction,{values:{orderReference:app.reference,status:'Shipped'},until:async p=>await p.getByTestId('saved-status').count()===1});
 assert.equal(sawForm,true,'The second decision must start from the search form that is then replaced.');
 assert.equal(result.status,'complete',JSON.stringify(result));assert.deepEqual(app.writes,[{id:app.reference,status:'Shipped'}]);
});

test('run observation: a form replaced after its authority check is reobserved rather than reported as a validation failure',async t=>{
 const app=await orderWorkflowFixture(t),page=await browser.newPage();await page.goto(app.url);
 await heldSearch(t,page);
 // Replace the search form with the result list at the busy probe that follows the authority check,
 // i.e. after the run confirmed the bound input is connected and before it checks the carried input.
 await page.evaluate(records=>{const form=document.querySelector('form'),closest=form.closest;
  form.closest=function(selector){if(window.replaceAtBusyProbe&&selector==='[aria-busy="true"]'){window.replaceAtBusyProbe=false;rows=records;list();}return closest.call(this,selector);};
 },app.records);
 const engine=orderEngine(async calls=>{if(calls===2)await page.evaluate(()=>{window.replaceAtBusyProbe=true;});});
 const core=new JevBrowser({page,engine});t.after(async()=>{await core.close();await page.close();});
 const result=await core.run(instruction,{values:{orderReference:app.reference,status:'Shipped'},until:async p=>await p.getByTestId('saved-status').count()===1});
 assert.equal(await page.evaluate(()=>window.replaceAtBusyProbe),false,'The replacement must have happened at the probe.');
 assert.equal(result.status,'complete',JSON.stringify(result));assert.deepEqual(app.writes,[{id:app.reference,status:'Shipped'}]);
});
