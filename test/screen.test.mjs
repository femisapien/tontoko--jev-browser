import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {JevBrowser} from '../dist/index.js';
import {parseCommand,executeCommand} from '../dist/commands.js';
import {fixtureBrowser,httpServer} from './helpers.mjs';
let browser,server,root;
before(async()=>{
 browser=await fixtureBrowser();root=await mkdtemp(join(tmpdir(),'jev-screen-'));
 server=await httpServer((req,res)=>{res.setHeader('content-type','text/html');res.end('<p>Visible page</p><input aria-label="HIDDEN_ARIA_SECRET"><script>document.title="HIDDEN_TITLE_SECRET"</script>');});
});
after(async()=>{await server?.close();await browser?.close();await rm(root,{recursive:true,force:true});});
async function fixture(t,options={}){
 const context=await browser.newContext({viewport:{width:420,height:320},deviceScaleFactor:2});
 const page=await context.newPage();
 await page.setContent('<style>input{position:absolute;left:20px;top:20px;width:180px;height:32px}button{position:absolute;left:20px;top:80px;width:150px;height:40px}h1{position:absolute;top:140px}</style><title>HIDDEN_TITLE_SECRET</title><input aria-label="HIDDEN_ARIA_SECRET"><button onclick="document.querySelector(\'h1\').textContent=document.querySelector(\'input\').value">Save</button><h1>Pending</h1><i hidden>HIDDEN_DOM_SECRET</i>');
 const core=new JevBrowser({page,...options});
 t.after(async()=>{await core.close();await context.close();});
 return {core,page,context};
}
test('screen uses visible pixels and focused coordinate input without model or DOM metadata',async t=>{
 const {core,page}=await fixture(t,{engine:{decide(){throw new Error('Screen must not call a model');}}});
 assert.equal(typeof core.screen,'function','screen API must exist');
 let r=await core.screen({action:'look'});
 assert.deepEqual(r.viewport,{width:420,height:320});
 const png=Buffer.from(r.frames[0].data,'base64');assert.equal(png.readUInt32BE(16),420);assert.equal(png.readUInt32BE(20),320);
 assert.equal(JSON.stringify(r).includes('HIDDEN_'),false);
 r=await core.screen({action:'click',x:60,y:40,observationId:r.observationId});
 r=await core.screen({action:'type',text:'Visible result',observationId:r.observationId});
 r=await core.screen({action:'click',x:70,y:100,observationId:r.observationId});
 assert.equal(await page.locator('h1').textContent(),'Visible result');
 assert.equal(r.action.outcome,'executed');assert.equal(r.frames.length,1);
 assert.ok(r.action.durationMs>=0);assert.ok(Date.parse(r.frames[0].capturedAt)>=Date.parse(r.action.startedAt));
 assert.equal(JSON.stringify(r).includes('HIDDEN_'),false);
 await core.close();assert.equal(page.isClosed(),false);
});
test('old screenshots, navigation and resized viewports cannot authorize a later input',async t=>{
 const {core,page}=await fixture(t);assert.equal(typeof core.screen,'function');
 const first=await core.screen({action:'look'});await core.screen({action:'look'});
 await assert.rejects(core.screen({action:'click',x:70,y:100,observationId:first.observationId}),{code:'STALE_SCREEN'});
 const beforeNav=await core.screen({action:'look'});await page.goto(server.url);
 await assert.rejects(core.screen({action:'type',text:'wrong',observationId:beforeNav.observationId}),{code:'STALE_SCREEN'});
 const beforeResize=await core.screen({action:'look'});await page.setViewportSize({width:400,height:300});
 await assert.rejects(core.screen({action:'click',x:1,y:1,observationId:beforeResize.observationId}),{code:'STALE_SCREEN'});
 assert.equal(await page.locator('input').inputValue(),'');
});
test('screen checks the existing command policy and rechecks freshness after authorization',async t=>{
 let core,page,release;
 const f=await fixture(t,{allowCommand:async command=>{if(command.command==='screen'&&command.request.action==='click'){await new Promise(r=>release=r);}return true;}});core=f.core;page=f.page;
 assert.equal(typeof core.screen,'function');const seen=await core.screen({action:'look'});
 const pending=core.screen({action:'click',x:70,y:100,observationId:seen.observationId});
 while(!release)await new Promise(r=>setTimeout(r,1));
 await page.goto(server.url);release();
 await assert.rejects(pending,{code:'STALE_SCREEN'});
 const denied=await fixture(t,{allowCommand:command=>command.command!=='screen'});
 await assert.rejects(denied.core.screen({action:'look'}),{code:'ACTION_DENIED'});
});
test('only a main-frame navigation invalidates the viewport observation',async t=>{
 const {core,page}=await fixture(t);
 await page.setContent('<iframe src="'+server.url+'"></iframe><button style="position:absolute;left:20px;top:20px;width:100px;height:40px" onclick="this.textContent=\'Clicked\'">Unchanged</button>');
 let seen=await core.screen({action:'look'});
 // Subframe content changes like other page content; it does not replace the observed document.
 await page.frames().find(frame=>frame!==page.mainFrame()).goto(server.url+'/changed');
 seen=await core.screen({action:'click',x:50,y:35,observationId:seen.observationId});
 assert.equal(await page.locator('button').textContent(),'Clicked');assert.equal(seen.navigated,false);
 await page.evaluate(()=>{location.hash='same-document';});
 await assert.rejects(core.screen({action:'move',x:5,y:5,observationId:seen.observationId}),{code:'STALE_SCREEN'});
});
async function site(t,handler){const s=await httpServer(handler);t.after(()=>s.close());return s;}
const button=label=>'<button style="position:absolute;left:20px;top:20px;width:150px;height:40px" onclick="this.textContent=\'Clicked\'">'+label+'</button>';
test('a navigation started by an input settles into a fresh image instead of a stale capture',async t=>{
 const {core,page}=await fixture(t);
 const s=await site(t,(req,res)=>{res.setHeader('content-type','text/html');
  if(req.url==='/next'){setTimeout(()=>res.end(button('Next page')),50);return;}
  res.end('<a href="/next" style="position:absolute;left:20px;top:20px;width:150px;height:40px;display:block">Go next</a>');});
 await page.goto(s.url);
 let seen=await core.screen({action:'look'});
 seen=await core.screen({action:'click',x:60,y:40,observationId:seen.observationId});
 assert.equal(seen.navigated,true);assert.equal(seen.action.outcome,'executed');assert.equal(new URL(page.url()).pathname,'/next');
 await core.screen({action:'click',x:60,y:40,observationId:seen.observationId});
 assert.equal(await page.locator('button').textContent(),'Clicked');
});
test('a navigation body reported before its commit still settles into the new document',async t=>{
 const {core,page}=await fixture(t);
 const s=await site(t,(req,res)=>{res.setHeader('content-type','text/html');
  if(req.url==='/next'){setTimeout(()=>res.end(button('Next page')),50);return;}
  res.end('<a href="/next" style="position:absolute;left:20px;top:20px;width:150px;height:40px;display:block">Go next</a>');});
 // Firefox can report requestfinished before the main-frame commit; delaying framenavigated reproduces that order on every engine.
 const on=page.on.bind(page);page.on=(event,listener)=>on(event,event==='framenavigated'?frame=>setTimeout(()=>listener(frame),150):listener);
 await page.goto(s.url);
 let seen=await core.screen({action:'look'});
 seen=await core.screen({action:'click',x:60,y:40,observationId:seen.observationId});
 assert.equal(seen.navigated,true);assert.equal(new URL(page.url()).pathname,'/next');
 await core.screen({action:'click',x:60,y:40,observationId:seen.observationId});
 assert.equal(await page.locator('button').textContent(),'Clicked');
});
test('look waits for a pending main-frame navigation and observes the new document',async t=>{
 const {core,page}=await fixture(t);let requested,respond;const navigation=new Promise(resolve=>{requested=resolve;});
 const s=await site(t,(req,res)=>{res.setHeader('content-type','text/html');
  if(req.url==='/next'){respond=()=>res.end(button('Next page'));requested();return;}
  res.end('<p>Start</p>');});
 await page.goto(s.url);await core.screen({action:'look'});
 await page.evaluate(()=>{location.href='/next';});await navigation;
 const pending=core.screen({action:'look'});respond();
 const seen=await pending;assert.equal(seen.navigated,true);
 await core.screen({action:'click',x:60,y:40,observationId:seen.observationId});
 assert.equal(await page.locator('button').textContent(),'Clicked');
});
test('navigations that keep interrupting the retake return STALE_SCREEN, not a capture failure',async t=>{
 const {core,page}=await fixture(t);let interrupts=0;const screenshot=page.screenshot.bind(page);
 // Each hooked screenshot starts after a real main-frame same-document navigation; engines throttle unbounded History API streams.
 page.screenshot=async(...args)=>{if(interrupts>0){interrupts--;await Promise.all([page.waitForEvent('framenavigated'),page.evaluate(()=>{location.hash='n'+Math.random();})]);}return screenshot(...args);};
 await page.setContent(button('Start'));
 let seen=await core.screen({action:'look'});interrupts=2;
 await assert.rejects(core.screen({action:'click',x:60,y:40,observationId:seen.observationId}),error=>{assert.equal(error.code,'STALE_SCREEN');return true;});
 assert.equal(await page.locator('button').textContent(),'Clicked');assert.equal(interrupts,0);
 interrupts=2;await assert.rejects(core.screen({action:'look'}),error=>{assert.equal(error.code,'STALE_SCREEN');return true;});
 seen=await core.screen({action:'look'});assert.equal(seen.navigated,false);assert.equal(seen.frames.length,1);
});
test('an input navigation that ends without a document does not hold the capture',async t=>{
 const {core,page}=await fixture(t);
 const s=await site(t,(req,res)=>{if(req.url==='/empty'){setTimeout(()=>{res.statusCode=204;res.end();},100);return;}
  res.setHeader('content-type','text/html');res.end('<a href="/empty" style="position:absolute;left:20px;top:20px;width:150px;height:40px;display:block">Nothing</a>');});
 await page.goto(s.url);
 const seen=await core.screen({action:'look'}),started=performance.now();
 const r=await core.screen({action:'click',x:60,y:40,observationId:seen.observationId});
 assert.equal(r.navigated,false);assert.equal(new URL(page.url()).pathname,'/');assert.ok(performance.now()-started<3000,'a 204 navigation must not wait for the settle budget');
});
test('failed captures report a reason, and history actions recover without an observationId only then',async t=>{
 const {core,page}=await fixture(t);let fontRequested;const font=new Promise(resolve=>{fontRequested=resolve;});
 const s=await site(t,(req,res)=>{if(req.url==='/held.woff2'){fontRequested();return;}res.setHeader('content-type','text/html');res.end(button('Ready'));});
 await page.goto(s.url);
 let seen=await core.screen({action:'look'});
 await assert.rejects(core.screen({action:'reload'}),error=>error.code==='INVALID_ARGUMENT'&&error.details.issues[0].path==='observationId'&&error.details.observationId===seen.observationId);
 // Playwright screenshots wait for fonts, so a held font makes the capture fail for a known reason.
 await page.evaluate(url=>{const face=new FontFace('held',`url("${url}/held.woff2")`);document.fonts.add(face);document.body.style.fontFamily='held';void face.load().catch(()=>{});},s.url);
 await font;
 await assert.rejects(core.screen({action:'look'},{timeoutMs:1000}),error=>{
  assert.equal(error.code,'SCREEN_FAILED');assert.deepEqual(error.details,{reason:'timeout'});assert.match(error.message,/timeout/);return true;
 });
 await assert.rejects(core.screen({action:'reload',observationId:seen.observationId}),error=>error.code==='STALE_SCREEN'&&/omit observationId/.test(error.message));
 seen=await core.screen({action:'reload'});
 assert.equal(seen.action.outcome,'executed');assert.equal(seen.navigated,true);
 await core.screen({action:'click',x:60,y:40,observationId:seen.observationId});
 assert.equal(await page.locator('button').textContent(),'Clicked');
 await page.close();
 await assert.rejects(core.screen({action:'look'}),error=>error.code==='SCREEN_FAILED'&&error.details.reason==='page-closed');
});
test('a crashed page is reported as the capture failure reason without suggesting history recovery',{skip:(process.env.JEV_BROWSER??'chromium')!=='chromium'},async t=>{
 const {core,page}=await fixture(t);await core.screen({action:'look'});
 const crashed=page.waitForEvent('crash');const cdp=await page.context().newCDPSession(page);cdp.send('Page.crash').catch(()=>{});await crashed;
 await assert.rejects(core.screen({action:'look'}),error=>{
  assert.equal(error.code,'SCREEN_FAILED');assert.deepEqual(error.details,{reason:'page-crashed'});assert.equal(/reload/.test(error.message),false);return true;
 });
});
for(const screenOnly of [false,true])test('a native dialog that interrupts a capture is reported as its reason'+(screenOnly?', then dismissed in screen-only sessions':''),async t=>{
 const {core,page}=await fixture(t,{screenOnly});let fontRequested;const font=new Promise(resolve=>{fontRequested=resolve;});
 const s=await site(t,(req,res)=>{if(req.url==='/held.woff2'){fontRequested(res);return;}res.setHeader('content-type','text/html');res.end('<p>Visible</p>');});
 await page.goto(s.url);
 await page.evaluate(url=>{const face=new FontFace('held',`url("${url}/held.woff2")`);document.fonts.add(face);document.body.style.fontFamily='held';void face.load().catch(()=>{});},s.url);
 const held=await font;
 const pending=core.screen({action:'look'},{timeoutMs:1000}).catch(error=>error);
 await page.evaluate(()=>{setTimeout(()=>alert('PRIVATE_DIALOG'));});
 const error=await pending;
 assert.equal(error.code,'SCREEN_FAILED');assert.deepEqual(error.details,{reason:'dialog'});assert.equal(error.message.includes('PRIVATE_'),false);
 if(screenOnly){held.statusCode=404;held.end();assert.equal((await core.screen({action:'look'})).frames.length,1);}
});
test('screen mode rejects ordinary dispatcher commands and does not change normal mode',async t=>{
 const {core}=await fixture(t,{screenOnly:true});
 assert.equal(core.screenOnly,true);
 for(const request of [{command:'snapshot'},{command:'goto',url:server.url},{command:'network_requests'},{command:'evaluate',function:'()=>document.title'},{command:'take_screenshot',fullPage:true}]){
  await assert.rejects(executeCommand(core,parseCommand(request)),{code:'SCREEN_ONLY'});
 }
 assert.throws(()=>{core.screenOnly=false;},TypeError);
 const normal=await fixture(t);assert.equal(normal.core.screenOnly,false);
 assert.ok((await executeCommand(normal.core,parseCommand({command:'snapshot'}))).elements.length>0);
});
test('cancellation during typing stops dispatching remaining characters without replay',async t=>{
 const {core,page}=await fixture(t);const abort=new AbortController();
 await page.exposeFunction('interruptScreenTyping',()=>abort.abort());
 await page.locator('input').evaluate(input=>input.addEventListener('input',()=>{void window.interruptScreenTyping();},{once:true}));
 let seen=await core.screen({action:'look'});seen=await core.screen({action:'click',x:50,y:35,observationId:seen.observationId});
 await assert.rejects(core.screen({action:'type',text:'x'.repeat(300),observationId:seen.observationId},{signal:abort.signal}),{code:'SCREEN_INTERRUPTED'});
 const actual=await page.locator('input').inputValue();assert.ok(actual.length>0&&actual.length<300);
});
test('native dialogs and popup tabs are explicit tool limitations without hidden metadata',async t=>{
 // Firefox's open alert can block input in another context. End each fixture before starting the next case.
 for(const [name,script,code] of [
  ['native dialog','alert("PRIVATE_NATIVE_DIALOG")','SCREEN_DIALOG_UNSUPPORTED'],
  ['popup tab','window.open("'+server.url+'")','SCREEN_POPUP_UNSUPPORTED'],
 ])await t.test(name,async t=>{
  const {core,page}=await fixture(t);await page.locator('button').evaluate((button,script)=>button.setAttribute('onclick',script),script);
  const seen=await core.screen({action:'look'});
  await assert.rejects(core.screen({action:'click',x:70,y:100,observationId:seen.observationId}),error=>{
   assert.equal(error.code,code);
   assert.equal(error.message.includes('PRIVATE_'),false);return true;
  });
 });
});
test('screen-only sessions report a native dialog or popup tab once, then recover on the same page',async t=>{
 const cases=[
  ['dialog from input','alert("PRIVATE_NATIVE_DIALOG");confirm("PRIVATE_SECOND_DIALOG");document.querySelector("h1").textContent="Resumed"','SCREEN_DIALOG_UNSUPPORTED',true],
  ['popup from input','window.open("'+server.url+'")','SCREEN_POPUP_UNSUPPORTED',true],
  ['dialog between operations','setTimeout(()=>alert("PRIVATE_LATE_DIALOG"),50)','SCREEN_DIALOG_UNSUPPORTED',false],
  ['popup between operations','setTimeout(()=>window.open("'+server.url+'"),50)','SCREEN_POPUP_UNSUPPORTED',false],
 ];
 for(const [name,script,code,immediate] of cases)await t.test(name,async t=>{
  const {core,page,context}=await fixture(t,{screenOnly:true,captureDialogs:true});
  await page.locator('button').evaluate((button,script)=>button.setAttribute('onclick',script),script);
  let seen=await core.screen({action:'look'});
  const check=error=>{assert.equal(error.code,code);assert.equal(error.message.includes('PRIVATE_'),false);return true;};
  if(immediate)await assert.rejects(core.screen({action:'click',x:70,y:100,observationId:seen.observationId}),check);
  else{
   seen=await core.screen({action:'click',x:70,y:100,observationId:seen.observationId});
   if(code==='SCREEN_POPUP_UNSUPPORTED')await context.waitForEvent('page');else await delay(300);
   await assert.rejects(core.screen({action:'look'}),check);
  }
  // Reported once: later observations continue on the same selected page with no pending dialog or extra tab.
  seen=await core.screen({action:'look'});seen=await core.screen({action:'look'});
  assert.equal(context.pages().length,1);assert.equal(core.page,page);assert.equal(page.isClosed(),false);
  if(name==='dialog from input')assert.equal(await page.locator('h1').textContent(),'Resumed');
  seen=await core.screen({action:'click',x:60,y:35,observationId:seen.observationId});
  seen=await core.screen({action:'type',text:'Still usable',observationId:seen.observationId});
  assert.equal(await page.locator('input').inputValue(),'Still usable');
 });
});
test('sessions with ordinary tools keep dialogs and popup tabs for those tools',async t=>{
 const {core,page,context}=await fixture(t,{captureDialogs:true});
 await page.locator('button').evaluate(button=>button.setAttribute('onclick','window.open("'+location.href+'")'));
 const seen=await core.screen({action:'look'});
 await assert.rejects(core.screen({action:'click',x:70,y:100,observationId:seen.observationId}),{code:'SCREEN_POPUP_UNSUPPORTED'});
 assert.equal(context.pages().length,2);
 await assert.rejects(core.screen({action:'look'}),{code:'SCREEN_POPUP_UNSUPPORTED'});
 await context.pages()[1].close();
 await page.evaluate(()=>{setTimeout(()=>alert('PRIVATE_DIALOG'),0);});await delay(200);
 await assert.rejects(core.screen({action:'look'}),{code:'DIALOG_PENDING'});
 await executeCommand(core,parseCommand({command:'handle_dialog',accept:false}));
 await core.screen({action:'look'});
});
test('invalid screen commands cannot inject selectors or privileged keyboard chords',async t=>{
 const {core,page}=await fixture(t);assert.equal(typeof core.screen,'function');
 for(const request of [
  {action:'look',scope:'body'},{action:'look',fullPage:true},{action:'look',capture:{frames:11,intervalMs:20}},
  {action:'press',key:'F12'},{action:'press',key:'Control+l'},{action:'press',key:'Meta+v'},
  {action:'press',key:'Control+Shift+I'},{action:'press',key:'Control+u'},{action:'press',key:'Control+c'},
  {action:'type',text:'wrong',target:'input'},
 ]){
  const seen=await core.screen({action:'look'});
  await assert.rejects(core.screen({...request,...(request.action==='look'?{}:{observationId:seen.observationId})}),{code:'INVALID_ARGUMENT'});
 }
 const seen=await core.screen({action:'look'});
 await assert.rejects(core.screen({action:'click',x:421,y:20,observationId:seen.observationId}),{code:'SCREEN_COORDINATES'});
 assert.equal(await page.locator('input').inputValue(),'');
});
test('rejected screen requests send nothing and keep the latest observation usable',async t=>{
 const {core,page}=await fixture(t,{screenOnly:true,allowCommand:command=>!(command.command==='screen'&&command.request.action==='press')});
 const seen=await core.screen({action:'look'});
 for(const [request,code] of [
  [{action:'click',x:60,y:40},'INVALID_ARGUMENT'],
  [{action:'scroll',deltaX:0,deltaY:40,x:5,observationId:seen.observationId},'INVALID_ARGUMENT'],
  [{action:'click',x:421,y:20,observationId:seen.observationId},'SCREEN_COORDINATES'],
  [{action:'press',key:'Tab',observationId:seen.observationId},'ACTION_DENIED'],
  [{action:'click',x:60,y:40,observationId:'an-older-observation'},'STALE_SCREEN'],
 ])await assert.rejects(core.screen(request),{code});
 await assert.rejects(executeCommand(core,parseCommand({command:'snapshot'})),{code:'SCREEN_ONLY'});
 assert.equal(await page.evaluate(()=>document.activeElement===document.body),true);
 const next=await core.screen({action:'click',x:60,y:40,observationId:seen.observationId});
 assert.equal(next.action.outcome,'executed');assert.equal(await page.evaluate(()=>document.activeElement?.tagName),'INPUT');
});
test('screen validation names the action and field and returns the current observationId',async t=>{
 const {core}=await fixture(t);
 let seen=await core.screen({action:'look'});
 await assert.rejects(core.screen({action:'click',x:60,y:40}),error=>{
  assert.equal(error.code,'INVALID_ARGUMENT');assert.match(error.message,/click/);assert.match(error.message,/observationId/);
  assert.deepEqual(error.details,{action:'click',issues:[{path:'observationId',message:error.details.issues[0].message}],observationId:seen.observationId});
  return true;
 });
 await assert.rejects(core.screen({action:'capture',capture:{frames:2,intervalMs:20}}),error=>{
  assert.match(error.message,/action: Expected one of look, click/);assert.equal(error.details.action,undefined);return true;
 });
 await assert.rejects(core.screen({action:'scroll',observationId:seen.observationId}),error=>error.details.issues[0].path==='deltaY');
 // An omitted wheel delta is 0. wait sends no input, so it observes without an observationId.
 seen=await core.screen({action:'scroll',deltaY:40,observationId:seen.observationId});assert.equal(seen.action.outcome,'executed');
 seen=await core.screen({action:'wait',milliseconds:0});assert.equal(seen.action.outcome,'observed');
 await assert.rejects(core.screen({action:'wait'}),error=>error.details.issues[0].path==='milliseconds'&&error.details.observationId===seen.observationId);
});
test('screen emits timestamped transient frames and writes evidence without duplicating typed text',async t=>{
 const outputDir=await mkdtemp(join(root,'evidence-'));const {core,page}=await fixture(t,{outputDir});assert.equal(typeof core.screen,'function');
 let r=await core.screen({action:'look'});r=await core.screen({action:'click',x:50,y:35,observationId:r.observationId});
 r=await core.screen({action:'type',text:'PRIVATE_TYPED_VALUE',observationId:r.observationId});
 await page.evaluate(()=>document.body.animate([{background:'rgb(255,255,255)'},{background:'rgb(0,0,0)'}],{duration:1000,iterations:Infinity,direction:'alternate'}));
 r=await core.screen({action:'look',capture:{frames:4,intervalMs:40}});
 assert.equal(r.frames.length,4);assert.ok(r.frames[3].elapsedMs>=100);assert.ok(new Set(r.frames.map(f=>f.data)).size>1);
 for(const f of r.frames){assert.equal((await readFile(f.path)).subarray(1,4).toString(),'PNG');}
 await assert.rejects(core.screen({action:'press',key:'F12',observationId:r.observationId}),{code:'INVALID_ARGUMENT'});
 const logs=(await readdir(outputDir)).filter(n=>n.endsWith('.jsonl'));assert.equal(logs.length,1);
 const text=await readFile(join(outputDir,logs[0]),'utf8');assert.equal(text.includes('PRIVATE_TYPED_VALUE'),false);assert.equal(text.includes('HIDDEN_'),false);
 const rows=text.trim().split('\n').map(JSON.parse);assert.ok(rows.some(row=>row.action.kind==='type'&&row.input.textLength===19));
 assert.ok(rows.some(row=>row.action.outcome==='denied'));
});
test('the screen journal records its environment and verifiable frame digests',async t=>{
 const outputDir=await mkdtemp(join(root,'journal-'));const {core}=await fixture(t,{outputDir});
 const r=await core.screen({action:'look',capture:{frames:2,intervalMs:20}});
 const [log,...others]=(await readdir(outputDir)).filter(n=>n.endsWith('.jsonl'));assert.equal(others.length,0);
 const [header,row]=(await readFile(join(outputDir,log),'utf8')).trim().split('\n').map(JSON.parse);
 const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
 assert.equal(header.action.kind,'header');assert.deepEqual(header.frames,[]);
 assert.equal(header.header.jevBrowser,pkg.version);assert.match(header.header.playwright,/^\d+\.\d+\.\d+/);
 assert.equal(header.header.browser.name,process.env.JEV_BROWSER??'chromium');assert.ok(header.header.browser.version);
 assert.deepEqual(header.header.viewport,{width:420,height:320});assert.equal(header.header.launch,undefined);
 assert.equal(row.frames.length,2);
 for(const [i,frame] of row.frames.entries()){
  const png=await readFile(frame.path);assert.ok(png.equals(Buffer.from(r.frames[i].data,'base64')));
  assert.equal(frame.sha256,createHash('sha256').update(png).digest('hex'));assert.deepEqual([frame.width,frame.height],[420,320]);
 }
 assert.equal('sha256' in r.frames[0],false);
});
test('journal launch evidence keeps display settings and redacts credentials, headers and paths',async t=>{
 const outputDir=await mkdtemp(join(root,'launch-'));
 const core=await JevBrowser.launch({outputDir,launchOptions:{env:{...process.env,PRIVATE_ENV:'PRIVATE_ENV_VALUE'}},storageState:{cookies:[],origins:[]},
  contextOptions:{viewport:{width:360,height:240},locale:'en-US',httpCredentials:{username:'user',password:'PRIVATE_PASSWORD'},extraHTTPHeaders:{authorization:'PRIVATE_TOKEN'}}});
 t.after(()=>core.close());
 await core.screen({action:'look'});
 const log=(await readdir(outputDir)).find(n=>n.endsWith('.jsonl'));const text=await readFile(join(outputDir,log),'utf8');
 assert.equal(text.includes('PRIVATE_'),false);
 const {launch}=JSON.parse(text.split('\n')[0]).header;
 assert.deepEqual(launch.contextOptions,{viewport:{width:360,height:240},locale:'en-US',httpCredentials:'[redacted]',extraHTTPHeaders:'[redacted]'});
 assert.deepEqual(launch.launchOptions,{env:'[redacted]'});assert.equal(launch.storageState,'[redacted]');
});
test('the journal header records when the session started, before its first action',async t=>{
 const outputDir=await mkdtemp(join(root,'started-'));const {core}=await fixture(t,{outputDir});
 const created=Date.now();
 // The header is written with the first journal row; its timestamp still reports session start.
 await new Promise(resolve=>setTimeout(resolve,30));
 await core.screen({action:'look'});
 const log=(await readdir(outputDir)).find(n=>n.endsWith('.jsonl'));
 const [header,row]=(await readFile(join(outputDir,log),'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(header.action.kind,'header');
 assert.ok(Date.parse(header.action.startedAt)<=Date.parse(row.action.startedAt),'header starts no later than the first action');
 assert.ok(Date.parse(header.action.startedAt)<=created,'header reports session creation');
});
const scrollBlocks='<style>html,body{margin:0}div{height:320px;font:40px sans-serif}</style>'+
 Array.from({length:12},(_,i)=>'<div style="background:hsl('+i*37+',70%,60%)" onclick="document.title=\'clicked-'+i+'\'">Block '+i+'</div>').join('');
test('a scroll is captured after the wheel settles and its observation authorizes the next click',async t=>{
 const {core,page}=await fixture(t);
 // A page-driven smooth scroller, as many sites use: each wheel animates the window across several frames.
 await page.setContent(scrollBlocks+'<script>let target=0;addEventListener("wheel",e=>{e.preventDefault();target=Math.min(target+Math.sign(e.deltaY)*640,document.documentElement.scrollHeight-innerHeight);'+
  'const from=scrollY,start=performance.now();const step=now=>{const p=Math.min(1,(now-start)/250);scrollTo(0,from+(target-from)*p);if(p<1)requestAnimationFrame(step);};requestAnimationFrame(step);},{passive:false});</script>');
 let seen=await core.screen({action:'look'});
 seen=await core.screen({action:'scroll',x:100,y:100,deltaY:120,observationId:seen.observationId});
 assert.equal(await page.evaluate(()=>scrollY),640,'the returned image was taken after the scroll finished');
 const settled=await page.screenshot({type:'png',scale:'css'});
 assert.ok(settled.equals(Buffer.from(seen.frames[0].data,'base64')),'the frame shows the scrolled position');
 seen=await core.screen({action:'click',x:100,y:100,observationId:seen.observationId});
 assert.equal(await page.title(),'clicked-2');assert.equal(seen.action.outcome,'executed');
});
test('native wheel scrolling returns the scrolled image and a usable observation',async t=>{
 const {core,page}=await fixture(t);await page.setContent(scrollBlocks);
 let seen=await core.screen({action:'look'});
 seen=await core.screen({action:'scroll',x:100,y:100,deltaY:640,observationId:seen.observationId});
 const y=await page.evaluate(()=>scrollY);assert.ok(y>0);
 const settled=await page.screenshot({type:'png',scale:'css'});
 assert.ok(settled.equals(Buffer.from(seen.frames[0].data,'base64')),'the frame shows the scrolled position');
 await core.screen({action:'click',x:100,y:100,observationId:seen.observationId});
 assert.equal(await page.title(),'clicked-'+Math.floor((y+100)/320));
});
test('a scroll that moves nothing still returns promptly',async t=>{
 const {core}=await fixture(t);
 let seen=await core.screen({action:'look'});
 const started=performance.now();
 seen=await core.screen({action:'scroll',deltaY:-200,observationId:seen.observationId});
 assert.ok(performance.now()-started<2_000);assert.equal(seen.action.outcome,'executed');
});
// Some frameworks call history.replaceState or pushState with the current URL on scroll: here on every scroll event and once more after it settles.
const historyOnScroll=method=>scrollBlocks+'<script>let idle;const update=()=>history.'+method+'(history.state,"",location.href);'+
 'addEventListener("scroll",()=>{update();clearTimeout(idle);idle=setTimeout(update,150);});</script>';
for(const method of ['replaceState','pushState'])test('a same-URL history.'+method+' on scroll keeps the scroll observation usable',async t=>{
 const {core,page}=await fixture(t);
 const s=await site(t,(req,res)=>{res.setHeader('content-type','text/html');res.end(historyOnScroll(method));});
 await page.goto(s.url);
 let seen=await core.screen({action:'look'});
 seen=await core.screen({action:'scroll',x:100,y:100,deltaY:640,observationId:seen.observationId});
 const y=await page.evaluate(()=>scrollY);assert.ok(y>0);const nav=seen.navigated;
 await new Promise(resolve=>setTimeout(resolve,300));
 const settled=await page.screenshot({type:'png',scale:'css'});
 assert.ok(settled.equals(Buffer.from(seen.frames[0].data,'base64')),'the frame shows the scrolled position');
 seen=await core.screen({action:'click',x:100,y:100,observationId:seen.observationId});
 assert.equal(await page.title(),'clicked-'+Math.floor((y+100)/320));assert.equal(seen.action.outcome,'executed');assert.equal(nav,false);
 // A same-URL history update between actions does not invalidate the observation either.
 await page.evaluate(m=>history[m](history.state,'',location.href),method);
 seen=await core.screen({action:'move',x:5,y:5,observationId:seen.observationId});assert.equal(seen.action.outcome,'executed');
});
test('a same-URL history update during capture neither retakes nor stales the returned observation',async t=>{
 const {core,page}=await fixture(t);let updates=0;const screenshot=page.screenshot.bind(page);
 const s=await site(t,(req,res)=>{res.setHeader('content-type','text/html');res.end(button('Start'));});
 await page.goto(s.url);
 page.screenshot=async(...args)=>{updates++;await Promise.all([page.waitForEvent('framenavigated'),page.evaluate(()=>history.replaceState(history.state,'',location.href))]);return screenshot(...args);};
 let seen=await core.screen({action:'look'});
 seen=await core.screen({action:'click',x:60,y:40,observationId:seen.observationId,capture:{frames:2,intervalMs:20}});
 assert.equal(seen.navigated,false);assert.equal(seen.frames.length,2);assert.equal(updates,3,'no capture was retaken');
 await core.screen({action:'move',x:5,y:5,observationId:seen.observationId});
 assert.equal(await page.locator('button').textContent(),'Clicked');
});
test('history updates that change the URL and cross-document reloads still invalidate the observation',async t=>{
 const {core,page}=await fixture(t);
 const s=await site(t,(req,res)=>{res.setHeader('content-type','text/html');res.end(scrollBlocks);});
 await page.goto(s.url);
 let seen=await core.screen({action:'look'});
 await page.evaluate(()=>history.pushState(null,'','/other'));
 await assert.rejects(core.screen({action:'move',x:5,y:5,observationId:seen.observationId}),{code:'STALE_SCREEN'});
 seen=await core.screen({action:'look'});
 await page.evaluate(()=>history.replaceState(null,'','/third'));
 await assert.rejects(core.screen({action:'move',x:5,y:5,observationId:seen.observationId}),{code:'STALE_SCREEN'});
 // A reload keeps the URL but replaces the document.
 seen=await core.screen({action:'look'});await page.reload();
 await assert.rejects(core.screen({action:'move',x:5,y:5,observationId:seen.observationId}),{code:'STALE_SCREEN'});
 seen=await core.screen({action:'look'});await page.goto(new URL('/fourth',s.url).href);
 await assert.rejects(core.screen({action:'move',x:5,y:5,observationId:seen.observationId}),{code:'STALE_SCREEN'});
});
