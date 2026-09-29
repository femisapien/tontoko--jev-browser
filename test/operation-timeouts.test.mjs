import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { JevBrowser } from '../dist/index.js';
import { fixtureBrowser, engine } from './helpers.mjs';

let browser;
before(async()=>{browser=await fixtureBrowser();});
after(async()=>{await browser?.close();});
// Renderer termination when a hung page's context closes is only verified on Chromium.
const hungUnsupported=process.env.JEV_BROWSER && process.env.JEV_BROWSER!=='chromium';
async function fixture(t,html,decider=engine(()=>'__none__'),options={}) {
  const context=await browser.newContext();const page=await context.newPage();await page.setContent(html);
  const core=new JevBrowser({page,engine:decider,...options});
  t.after(async()=>{await core.close();await context.close();});return {page,core};
}
// Report a promise that never settles instead of letting it consume the whole test timeout.
function within(promise,ms) {
  let timer;
  return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`still pending after ${ms} ms`)),ms);})]).finally(()=>clearTimeout(timer));
}
// The page's main thread stays busy, so later evaluations queue behind this one and never answer.
const hang=page=>{page.evaluate(()=>{for(;;){}}).catch(()=>undefined);};
const stuck=()=>{let entered;const inside=new Promise(resolve=>{entered=resolve;});return {inside,decider:{decide:()=>{entered();return new Promise(()=>{});}}};};

test('snapshot on a hung renderer times out promptly and releases the borrowed Page',{skip:hungUnsupported},async t=>{
  const context=await browser.newContext();const page=await context.newPage();await page.setContent('<button>Save</button>');
  const core=new JevBrowser({page,engine:engine(()=>'__none__')});
  t.after(async()=>{await context.close();});
  hang(page);
  await assert.rejects(within(core.snapshot({timeoutMs:500}),15000),{code:'TIMEOUT',retryable:true});
  await assert.rejects(within(core.snapshot({timeoutMs:300}),15000),{code:'TIMEOUT'},'the timed-out snapshot no longer holds the Page as BUSY');
  await within(core.close(),15000);
  assert.equal(page.isClosed(),false,'close never closes a borrowed Page');
});
test('close force-closes an owned browser while an operation is stuck in a hung renderer',{skip:hungUnsupported},async()=>{
  const core=await JevBrowser.launch({headless:true,engine:engine(()=>'__none__')});
  const owned=core.page.context().browser();
  try {
    const page=core.page,title=page.title.bind(page);let entered;const inside=new Promise(resolve=>{entered=resolve;});
    // Observe when capture reaches the renderer; the real call still runs and never answers.
    page.title=()=>{entered();return title();};
    await page.setContent('<button>Save</button>');
    hang(page);
    const pending=assert.rejects(within(core.snapshot(),30000),{code:'CANCELLED',retryable:false});
    await inside;
    await within(core.close(),20000);
    assert.equal(owned.isConnected(),false);
    await pending;
  } finally { if(owned.isConnected())await owned.close(); }
});
test('a decision engine that ignores cancellation cannot hold an operation past its timeout',async t=>{
  const {inside,decider}=stuck();
  const {core}=await fixture(t,'<button>Save</button>',decider);
  const pending=assert.rejects(within(core.observe('Save',{timeoutMs:300}),15000),error=>error.code==='TIMEOUT'&&error.retryable===true&&/300 ms/.test(error.message));
  await inside;
  await pending;
  assert.equal((await core.snapshot()).elements[0].name,'Save','the core accepts the next operation');
});
test('close does not wait indefinitely for work that ignores cancellation on a borrowed Page',async t=>{
  const {inside,decider}=stuck();
  const {core,page}=await fixture(t,'<button>Save</button>',decider);
  const pending=assert.rejects(within(core.observe('Save'),30000),error=>error.code==='CANCELLED'&&/closed/.test(error.message));
  await inside;
  await within(core.close(),15000);
  await pending;
  assert.equal(page.isClosed(),false);
});
test('an action that finishes as its signal aborts is reported instead of becoming a cancellation',async t=>{
  const {core,page}=await fixture(t,'<button onclick="alert(\'Saved\')">Save</button>');
  const controller=new AbortController();
  // Registered after the core's own listener, so the dialog is already recorded when the caller aborts.
  page.on('dialog',()=>controller.abort());
  const result=await core.native({command:'click',target:'button'},{signal:controller.signal});
  assert.equal(result.status,'dialog');assert.equal(result.dialog.message,'Saved');
});
test('an AI action that finished as the caller aborted is reported as executed',async t=>{
  const {core,page}=await fixture(t,'<div style="height:3000px">Tall page</div>',engine(question=>Object.entries(question.criteria).find(([,c])=>c?.kind==='scroll')?.[0]??'__none__'));
  const controller=new AbortController();
  await page.exposeFunction('abortCaller',()=>controller.abort());
  // The scroll call resolves only after the caller's abort ran, so cancellation deterministically arrives mid-action.
  await page.evaluate(()=>{const scroll=window.scrollBy.bind(window);window.scrollBy=async(...args)=>{await window.abortCaller();scroll(...args);};});
  const result=await core.act('Scroll down',{signal:controller.signal});
  assert.equal(result.status,'executed');assert.equal(controller.signal.aborted,true);assert.ok(await page.evaluate(()=>window.scrollY)>0);
});
test('an exhausted budget is TIMEOUT while caller cancellation stays CANCELLED',async t=>{
  const {core}=await fixture(t,'<p>Ready</p>');
  await assert.rejects(core.native({command:'wait_for',text:'Never shown'},{timeoutMs:300}),error=>error.code==='TIMEOUT'&&error.retryable===true&&error.cause instanceof Error);
  const aborted=new AbortController();aborted.abort();
  await assert.rejects(core.native({command:'wait_for',text:'Never shown'},{signal:aborted.signal}),{code:'CANCELLED',retryable:false});
  const running=new AbortController();
  const pending=core.native({command:'wait_for',text:'Never shown'},{signal:running.signal});running.abort();
  await assert.rejects(pending,{code:'CANCELLED',retryable:false});
  await assert.rejects(core.native({command:'click',target:'#missing'},{timeoutMs:300}),error=>error.code==='TIMEOUT'&&error.retryable===false&&/may have changed the page/.test(error.message),'a mutating command is not retryable after its budget expires');
});
