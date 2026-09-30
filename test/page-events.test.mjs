import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Client,InMemoryTransport} from '@modelcontextprotocol/client';
import {JevBrowser} from '../dist/index.js';
import {createMcpServer} from '../dist/mcp.js';
import {parseCommand} from '../dist/commands.js';
import {fixtureBrowser,httpServer} from './helpers.mjs';
let browser,server,root;
const confirmButton='<button onclick="document.title=String(confirm(\'Delete?\'))">Delete</button>';
before(async()=>{
 browser=await fixtureBrowser();root=await mkdtemp(join(tmpdir(),'jev-page-events-'));
 server=await httpServer((req,res)=>{
  if(req.url.startsWith('/dl/')){res.setHeader('Content-Type','application/octet-stream');res.setHeader('Content-Disposition',`attachment; filename="${req.url.slice(4)}.txt"`);res.end(req.url);return;}
  res.setHeader('Content-Type','text/html');res.end('<p>'+req.url+'</p><input type=file id=f>');
 });
});
after(async()=>{await server?.close();await browser?.close();await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:125});});
async function fixture(t,html,options={}){
 const context=await browser.newContext({acceptDownloads:true});const page=await context.newPage();
 const core=new JevBrowser({page,fileRoots:[root],outputDir:root,...options});
 t.after(async()=>{await core.close();await context.close();});
 if(html!==undefined)await page.setContent(html);return {core,page,context};
}
const opened=async(page,selector)=>{const chooser=page.waitForEvent('filechooser');await page.click(selector);await chooser;};
// Browsers may log their own warnings, such as Firefox's quirks-mode notice.
const logged=(messages,prefix)=>messages.filter(m=>m.text.startsWith(prefix));
const downloaded=async(page,name)=>{const event=page.waitForEvent('download');await page.evaluate(name=>{const a=document.createElement('a');a.href='/dl/'+name;document.body.append(a);a.click();a.remove();},name);await event;};

test('a borrowed Page keeps Playwright dialog dismissal outside Jev operations',async t=>{
 const {core,page}=await fixture(t,confirmButton);
 // Outside a Jev operation, Playwright still dismisses the confirm and the caller's click returns.
 await page.click('button',{timeout:5000});assert.equal(await page.title(),'false');
 assert.equal((await core.snapshot()).title,'false');
 const result=await core.native({command:'click',target:'button'});assert.equal(result.status,'dialog');assert.equal(result.dialog.type,'confirm');
 await core.native({command:'handle_dialog',accept:true});assert.equal(await page.title(),'true');
 assert.equal(page.listenerCount('dialog'),0);
});
test('launched cores and captureDialogs hold caller-opened dialogs for handle_dialog',async t=>{
 const launched=await JevBrowser.launch();t.after(()=>launched.close());
 const {core:opted}=await fixture(t,undefined,{captureDialogs:true});
 for(const core of [launched,opted]){
  await core.page.setContent(confirmButton);
  const dialog=core.page.waitForEvent('dialog');const clicked=core.page.click('button');await dialog;
  await assert.rejects(core.snapshot(),{code:'DIALOG_PENDING'});
  assert.equal((await core.native({command:'handle_dialog',accept:true})).status,'executed');
  await clicked;assert.equal(await core.page.title(),'true');
 }
});
test('console and network entries are scoped to the selected tab unless allTabs is requested',async t=>{
 const {core,page}=await fixture(t);await core.goto(server.url+'/a');await page.evaluate(()=>console.log('from tab A'));
 await core.native({command:'tabs',action:'new',url:server.url+'/b'});await core.page.evaluate(()=>console.log('from tab B'));
 const selected=(await core.native({command:'console_messages'})).messages;assert.deepEqual(logged(selected,'from tab').map(m=>m.text),['from tab B']);
 const [a,b]=(await core.native({command:'tabs',action:'list'})).tabs.map(tab=>tab.pageId);assert.notEqual(a,b);assert.ok(selected.every(m=>m.pageId===b));
 assert.deepEqual(logged((await core.native({command:'console_messages',allTabs:true})).messages,'from tab').map(m=>[m.text,m.pageId]),[['from tab A',a],['from tab B',b]]);
 const requests=(await core.native({command:'network_requests'})).requests;
 assert.ok(requests.some(r=>r.url.endsWith('/b')));assert.ok(requests.every(r=>r.pageId===b));
 assert.ok((await core.native({command:'network_requests',allTabs:true})).requests.some(r=>r.pageId===a&&r.url.endsWith('/a')));
 // Clearing the selected tab keeps another tab's history.
 await core.native({command:'console_messages',clear:true});
 assert.deepEqual(logged((await core.native({command:'console_messages',allTabs:true})).messages,'from tab').map(m=>m.text),['from tab A']);
});
test('two cores on one Page each record that Page\'s telemetry in their own buffer',async t=>{
 const {core:first,page}=await fixture(t,'<button onclick="console.log(\'clicked by second core\')">Log</button>');
 await page.evaluate(()=>console.log('before second core'));
 const second=new JevBrowser({page});t.after(()=>second.close());
 const ours=async core=>(await core.native({command:'console_messages'})).messages.map(m=>m.text).filter(text=>['before second core','clicked by second core','from the page'].includes(text));
 await second.native({command:'click',target:'button'});await page.evaluate(()=>console.log('from the page'));
 // Events belong to the Page, not to the core that caused them; a core records only what happened after it attached.
 assert.deepEqual(await ours(first),['before second core','clicked by second core','from the page']);
 assert.deepEqual(await ours(second),['clicked by second core','from the page']);
 // Buffers and clear are per core: clearing one core is a cursor for that core only.
 await first.native({command:'console_messages',clear:true});
 assert.equal(logged((await first.native({command:'console_messages'})).messages,'from the page').length,0);
 assert.equal(logged((await second.native({command:'console_messages'})).messages,'from the page').length,1);
});
test('file_upload without a target uses only a chooser from the selected tab and document',async t=>{
 // captureDialogs holds choosers the caller opens between Jev operations.
 const {core,page}=await fixture(t,undefined,{captureDialogs:true});const path=join(root,'chooser.txt');await writeFile(path,'chosen');
 await core.goto(server.url+'/a');await opened(page,'#f');
 await core.native({command:'tabs',action:'new',url:server.url+'/b'});
 await assert.rejects(core.native({command:'file_upload',paths:[path]}),{code:'NO_FILE_CHOOSER'});
 assert.equal(await page.locator('#f').evaluate(e=>e.files.length),0);
 await core.native({command:'tabs',action:'select',index:0});
 assert.equal((await core.native({command:'file_upload',paths:[path]})).count,1);
 assert.equal(await page.locator('#f').evaluate(e=>e.files[0]?.name),'chooser.txt');
 await opened(page,'#f');await core.goto(server.url+'/c');
 await assert.rejects(core.native({command:'file_upload',paths:[path]}),{code:'NO_FILE_CHOOSER'});
});
test('downloads keep stable ids and indexes address the selected tab',async t=>{
 const {core,page}=await fixture(t);await core.goto(server.url);
 await downloaded(page,'first');await downloaded(page,'second');
 const [first,second]=(await core.native({command:'downloads',action:'list'})).downloads;assert.notEqual(first.id,second.id);
 // The bounded list drops the oldest entry, so index 0 moves to another download. Ids never do.
 for(let i=0;i<99;i++)await downloaded(page,'later'+i);
 assert.equal((await core.native({command:'downloads',action:'list'})).downloads[0].id,second.id);
 const saved=await core.native({command:'downloads',action:'save',id:second.id,filename:'second.txt'});assert.equal(await readFile(saved.path,'utf8'),'/dl/second');
 await assert.rejects(core.native({command:'downloads',action:'save',id:first.id,filename:'first.txt'}),{code:'INVALID_ARGUMENT'});
 await core.native({command:'tabs',action:'new',url:server.url});await downloaded(core.page,'other-tab');
 const listed=(await core.native({command:'downloads',action:'list'})).downloads;assert.deepEqual(listed.map(d=>[d.index,d.filename]),[[0,'other-tab.txt']]);
 const selected=await core.native({command:'downloads',action:'save',index:0,filename:'selected.txt'});assert.equal(await readFile(selected.path,'utf8'),'/dl/other-tab');
 const all=(await core.native({command:'downloads',action:'list',allTabs:true})).downloads;
 assert.equal(all.length,100);assert.equal(all.some(d=>'index' in d),false);assert.equal(new Set(all.map(d=>d.pageId)).size,2);
});
test('tab-scoped event fields are validated and exposed through MCP',async t=>{
 for(const args of [{action:'save'},{action:'save',id:1,index:0},{action:'cancel',id:1,allTabs:true}])
  assert.throws(()=>parseCommand({command:'downloads',...args}),{code:'INVALID_ARGUMENT'});
 const {core,page}=await fixture(t,'<p>MCP</p>');await page.evaluate(()=>console.log('over MCP'));
 const mcp=createMcpServer(core),client=new Client({name:'page-events',version:'1'});const [ct,st]=InMemoryTransport.createLinkedPair();
 t.after(async()=>{await client.close();await mcp.close();});
 await mcp.connect(st);await client.connect(ct);
 const result=await client.callTool({name:'browser_console_messages',arguments:{allTabs:true}});assert.notEqual(result.isError,true);
 assert.deepEqual(logged(result.structuredContent.messages,'over MCP').map(m=>[m.text,typeof m.pageId]),[['over MCP','number']]);
});
