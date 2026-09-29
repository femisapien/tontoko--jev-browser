import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {JevBrowser} from '../dist/index.js';
import {fixtureBrowser,engine,httpServer} from './helpers.mjs';

let browser;
before(async()=>{browser=await fixtureBrowser();});
after(async()=>{await browser?.close();});
const forbidden={decide(){throw new Error('This observation must not reach a decision request.');}};

// Schedule a real browser change between two reads of one capture; the browser outcome is not simulated.
function between(page,change,times=1){
  const main=page.mainFrame();let remaining=times;
  const bound=(target,key)=>{const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;};
  const frame=new Proxy(main,{get(target,key){
    if(key!=='evaluateHandle')return bound(target,key);
    return async(...args)=>{const handle=await target.evaluateHandle(...args);if(remaining>0){remaining--;await change();}return handle;};
  }});
  return new Proxy(page,{get(target,key){return key==='frames'?()=>target.frames().map(candidate=>candidate===main?frame:candidate):bound(target,key);}});
}
async function interrupted(t,change,{times=1,decider=forbidden}={}){
  const server=await httpServer((req,res)=>{res.setHeader('Content-Type','text/html');
    res.end(req.url==='/next'?'<h1>Next page</h1><button>Continue</button>':'<h1>First page</h1><button>Start</button><iframe srcdoc="<p>Framed text</p>"></iframe>');});
  const page=await browser.newPage();await page.goto(server.url);
  const core=new JevBrowser({page:between(page,()=>change(page,server.url),times),engine:decider});
  t.after(async()=>{await core.close();await page.close();await server.close();});
  return {core,page};
}
test('a snapshot interrupted by a real navigation is retaken on the new document',async t=>{
  const {core}=await interrupted(t,(page,url)=>page.goto(url+'/next'));
  const snapshot=await core.snapshot();
  assert.equal(new URL(snapshot.url).pathname,'/next');assert.deepEqual(snapshot.elements.map(element=>element.name),['Continue']);
});
test('observe during a navigation grounds its plan on the settled document',async t=>{
  const decider=engine(()=>candidate=>candidate?.kind==='click'),{core}=await interrupted(t,(page,url)=>page.goto(url+'/next'),{decider});
  const plan=await core.observe('Click the button');
  assert.equal(plan.action.target.name,'Continue');assert.equal(decider.requests.length,1);
});
test('a URL change during capture is retaken instead of failing with STALE_SNAPSHOT',async t=>{
  const {core}=await interrupted(t,page=>page.evaluate(()=>history.pushState({},'','/moved')));
  const snapshot=await core.snapshot();
  assert.equal(new URL(snapshot.url).pathname,'/moved');assert.ok(snapshot.texts.some(source=>source.text==='First page'));
});
test('a page that keeps navigating fails with STALE_SNAPSHOT after bounded retries',async t=>{
  let changes=0;
  const {core}=await interrupted(t,page=>page.evaluate(n=>history.pushState({},'','/moved-'+n),++changes),{times:Infinity});
  await assert.rejects(core.snapshot(),{code:'STALE_SNAPSHOT'});
  assert.equal(changes,3);
});
test('a child frame removed during capture is skipped instead of failing the capture',async t=>{
  const {core,page}=await interrupted(t,page=>page.evaluate(()=>document.querySelector('iframe').remove()));assert.equal(page.frames().length,2);
  const snapshot=await core.snapshot();
  assert.ok(snapshot.texts.some(source=>source.text==='First page'));
  assert.equal(snapshot.texts.some(source=>source.text==='Framed text'||source.frame!==0),false);
});
