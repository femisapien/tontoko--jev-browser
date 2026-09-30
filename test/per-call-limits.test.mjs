import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {Client,InMemoryTransport} from '@modelcontextprotocol/client';
import {JevBrowser} from '../dist/index.js';
import {createMcpServer} from '../dist/mcp.js';
import {parseCommand} from '../dist/commands.js';
import {commandFromCLI,parseCLI} from '../dist/cli-options.js';
import {fixtureBrowser,engine} from './helpers.mjs';

let browser;
before(async()=>{browser=await fixtureBrowser();});
after(async()=>{await browser?.close();});
const forbidden={decide(){throw new Error('This observation must not reach a decision request.');}};
const buttons=n=>Array.from({length:n},(_,i)=>`<button>Item ${i}</button>`).join('');
async function content(t,html,options={}){
  const page=await browser.newPage();await page.setContent(html);
  const core=new JevBrowser({page,engine:forbidden,...options});t.after(async()=>{await core.close();await page.close();});
  return {core,page};
}

test('per-call maxElements and maxTexts raise or lower the core limits for one observation only',async t=>{
  const {core}=await content(t,`<main>${buttons(150)}${Array.from({length:30},(_,i)=>`<p>Note ${i}</p>`).join('')}</main>`,{maxTexts:20});
  const defaults=await core.snapshot();
  assert.equal(defaults.elements.length,120);assert.equal(defaults.truncatedElements,true);assert.equal(defaults.truncatedTexts,true);
  // Button labels are text sources too: 150 labels and 30 notes.
  const raised=await core.snapshot({maxElements:200,maxTexts:400});
  assert.equal(raised.elements.length,150);assert.equal(raised.truncatedElements,false);
  assert.equal(raised.texts.length,180);assert.equal(raised.truncatedTexts,false);
  const lowered=await core.snapshot({maxElements:5,maxTexts:3});
  assert.equal(lowered.elements.length,5);assert.equal(lowered.texts.length,3);assert.equal(lowered.truncated,true);
  // The next call without per-call limits uses the core defaults again.
  assert.equal((await core.snapshot()).elements.length,120);
});

test('per-call limits are clamped to the hard caps and invalid values are rejected',async t=>{
  const {core}=await content(t,`<main>${buttons(1010)}</main>`);
  const clamped=await core.snapshot({maxElements:5000});
  assert.equal(clamped.elements.length,1000);assert.equal(clamped.truncatedElements,true);
  for(const value of [0,-1,1.5,Number.NaN,'10'])
    await assert.rejects(core.snapshot({maxElements:value}),{code:'INVALID_ARGUMENT'},String(value));
  await assert.rejects(core.snapshot({maxCandidates:0}),{code:'INVALID_ARGUMENT'});
  await assert.rejects(core.snapshot({exclude:'nav'}),{code:'INVALID_ARGUMENT'});
  await assert.rejects(core.snapshot({exclude:['']}),{code:'INVALID_ARGUMENT'});
});

test('observe honors a per-call maxElements instead of failing with OBSERVATION_LIMIT',async t=>{
  // One list item per button keeps each row context short, so the request stays within the 128 KiB decision budget.
  const page=await browser.newPage();await page.setContent(`<ul>${Array.from({length:130},(_,i)=>`<li><button>Item ${i}</button></li>`).join('')}</ul>`);
  const decider=engine(()=>candidate=>candidate?.kind==='click'&&candidate?.target?.name==='Item 125');
  const core=new JevBrowser({page,engine:decider});t.after(async()=>{await core.close();await page.close();});
  await assert.rejects(core.observe('Click Item 125'),{code:'OBSERVATION_LIMIT'});
  const plan=await core.observe('Click Item 125',{maxElements:200});
  assert.equal(plan.action.target.name,'Item 125');
});

test('per-call maxCandidates bounds action candidates',async t=>{
  const page=await browser.newPage();await page.setContent(`<main>${buttons(10)}</main>`);
  const core=new JevBrowser({page,engine:engine(()=>'__none__')});t.after(async()=>{await core.close();await page.close();});
  await assert.rejects(core.observe('Click Item 3',{maxCandidates:3}),{code:'CANDIDATE_LIMIT'});
  assert.equal(await core.observe('Click Item 3'),null);
});

test('exclude removes matching subtrees, including open shadow content, from observation',async t=>{
  const {core}=await content(t,`<nav><a href="/a">Nav link</a><p>Nav text</p></nav><div class="ad"><button>Buy now</button></div>
    <main><h1>Title</h1><button>Save</button><section id="host"></section></main>
    <script>document.getElementById('host').attachShadow({mode:'open'}).innerHTML='<div class="ad"><button>Shadow ad</button></div><button>Shadow keep</button>';</script>`);
  const snapshot=await core.snapshot({exclude:['nav','.ad']});
  assert.deepEqual(snapshot.elements.map(element=>element.name),['Save','Shadow keep']);
  assert.ok(snapshot.texts.some(source=>source.text==='Title'));
  assert.ok(!snapshot.texts.some(source=>/Nav/.test(source.text)));
  await assert.rejects(core.snapshot({exclude:['[[invalid']}),{code:'INVALID_SELECTOR'});
});

test('scope accepts a snapshot or semantic_locate ref and observes only that element',async t=>{
  const page=await browser.newPage();
  await page.setContent(`<div role="listbox" aria-label="Billing"><div role="option">Card</div><div role="option">Invoice</div></div>
    <div role="listbox" aria-label="Shipping"><div role="option">Express</div><div role="option">Ground</div></div><button>Save</button>
    <iframe srcdoc="<div role='listbox' aria-label='Framed'><div role='option'>Framed option</div></div>"></iframe>`);
  const decider=engine(question=>Object.entries(question.criteria).find(([,candidate])=>candidate?.name==='Shipping')?.[0]??'__none__');
  const core=new JevBrowser({page,engine:decider});t.after(async()=>{await core.close();await page.close();});
  await page.waitForFunction(()=>document.querySelector('iframe').contentDocument?.querySelector('[role=option]'));
  const snapshot=await core.snapshot();
  const shipping=snapshot.elements.find(element=>element.name==='Shipping');
  const scoped=await core.snapshot({scope:shipping.id});
  assert.deepEqual(scoped.elements.map(element=>element.name),['Shipping','Express','Ground']);
  const framed=(await core.snapshot()).elements.find(element=>element.name==='Framed');
  const inFrame=await core.snapshot({scope:`ref:${framed.id}`});
  assert.deepEqual(inFrame.elements.map(element=>[element.name,element.frame]),[['Framed',framed.frame],['Framed option',framed.frame]]);
  // Refs expire like any other ref once replaced; a stale ref is never read as a CSS selector.
  await assert.rejects(core.snapshot({scope:shipping.id}),{code:'STALE_TARGET'});
  await assert.rejects(core.snapshot({scope:'r0123456789ab_e0_99'}),{code:'STALE_TARGET'});
  // A semantic_locate ref is equally usable, for AI operations as well.
  const target=await core.locateSemantic('The shipping method list');
  const located=await core.snapshot({scope:target.ref});
  assert.deepEqual(located.elements.map(element=>element.name),['Shipping','Express','Ground']);
  const again=await core.locateSemantic('The shipping method list');
  decider.requests.length=0;
  assert.equal(await core.observe('Choose Ground',{scope:again.ref}),null);
  assert.deepEqual(decider.requests.at(-1).state.page.elements.map(element=>element.name),['Shipping','Express','Ground']);
});

test('run rejects a ref scope because refs do not survive the pages a goal visits',async t=>{
  const {core}=await content(t,'<button>Save</button>');
  const ref=(await core.snapshot()).elements[0].id;
  await assert.rejects(core.run('Save',{scope:ref}),{code:'INVALID_ARGUMENT'});
  await assert.rejects(core.run('Save',{scope:`ref:${ref}`}),{code:'INVALID_ARGUMENT'});
  // resume refuses a ref before looking the continuation up, and CSS syntax is still validated for run.
  await assert.rejects(core.resume('missing',{scope:ref}),{code:'INVALID_ARGUMENT'});
  await assert.rejects(core.run('Save',{scope:'[[invalid'}),{code:'INVALID_SELECTOR'});
});

test('MCP and CLI expose per-call limits and exclude on observing tools without top-level combinators',async t=>{
  const server=createMcpServer(async()=>{throw new Error('Unexpected browser startup');});
  const client=new Client({name:'per-call-limits',version:'1'});
  const [ct,st]=InMemoryTransport.createLinkedPair();
  t.after(async()=>{await client.close();await server.close();});
  await server.connect(st);await client.connect(ct);
  const tools=(await client.listTools()).tools;
  const observing=['snapshot','observe','act','extract','semantic_locate','semantic_locate_batch','semantic_compare','semantic_assert','semantic_compare_batch','semantic_assert_batch','run'];
  for(const name of observing){
    const schema=tools.find(tool=>tool.name===`browser_${name}`).inputSchema;
    for(const key of ['maxElements','maxTexts','maxCandidates','exclude']) assert.ok(schema.properties[key]?.description,`${name}.${key}`);
    assert.equal(schema.properties.exclude.type,'array');
    for(const key of ['oneOf','anyOf','allOf']) assert.equal(schema[key],undefined);
  }
  assert.equal(tools.find(tool=>tool.name==='browser_click').inputSchema.properties.maxElements,undefined);
  const snapshot=z.fromJSONSchema(tools.find(tool=>tool.name==='browser_snapshot').inputSchema);
  assert.ok(snapshot.safeParse({maxElements:5000,exclude:['nav']}).success);
  assert.equal(snapshot.safeParse({maxElements:0}).success,false);
  assert.deepEqual(parseCommand({command:'observe',instruction:'Save',maxElements:10,maxTexts:20,maxCandidates:30,exclude:['nav']}),{command:'observe',instruction:'Save',maxElements:10,maxTexts:20,maxCandidates:30,exclude:['nav']});
  assert.throws(()=>parseCommand({command:'click',target:'button',maxElements:10}),{code:'INVALID_ARGUMENT'});
  const {values}=parseCLI(['snapshot','--max-elements','300','--max-texts','400','--max-candidates','500','--exclude','nav','--exclude','.ad']);
  assert.deepEqual(commandFromCLI('snapshot',[],values),{command:'snapshot',maxElements:300,maxTexts:400,maxCandidates:500,exclude:['nav','.ad']});
  // Session-level flags on a native command stay launch options, not command arguments.
  assert.deepEqual(commandFromCLI('click',['button'],parseCLI(['click','button','--max-elements','300']).values),{command:'click',target:'button'});
});

test('per-call options flow from a command through the shared core',async t=>{
  const page=await browser.newPage();await page.setContent(`<nav><button>Skip</button></nav><main>${buttons(3)}</main>`);
  const core=new JevBrowser({page,engine:forbidden});t.after(async()=>{await core.close();await page.close();});
  const server=createMcpServer(core);
  const client=new Client({name:'per-call-limits',version:'1'});
  const [ct,st]=InMemoryTransport.createLinkedPair();
  t.after(async()=>{await client.close();await server.close();});
  await server.connect(st);await client.connect(ct);
  const result=await client.callTool({name:'browser_snapshot',arguments:{maxElements:2,exclude:['nav']}});
  assert.equal(result.isError,undefined);
  assert.deepEqual(result.structuredContent.elements.map(element=>element.name),['Item 0','Item 1']);
  assert.equal(result.structuredContent.truncatedElements,true);
});
