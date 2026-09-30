import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { JevBrowser, JevDecisionEngine } from '../dist/index.js';
import { compactDecisionRequest } from '../dist/decision.js';
import { fixtureBrowser, engine, apiResult } from './helpers.mjs';
let browser;
before(async()=>{browser=await fixtureBrowser();});
after(async()=>{await browser?.close();});

// A deterministic 40-row table with a link per row and a 60-option select: the #37 measurement page.
const rows=Array.from({length:40},(_,i)=>`<tr><td>Customer ${i} Example Holdings</td><td>c${i}@example.com</td><td>${i%3?'Active':'Suspended'}</td><td><a href="/customers/${i}/details?tab=overview">Details</a></td><td><button type="button">Edit</button></td></tr>`).join('');
const options=Array.from({length:60},(_,i)=>`<option value="c${i}">Country number ${i}</option>`).join('');
const html=`<main><h1>Customers</h1><form aria-label="Filters"><label>Country <select name="country">${options}</select></label><button type="button">Apply</button></form>
<table><thead><tr><th>Name</th><th>Email</th><th>Status</th><th>Link</th><th>Action</th></tr></thead><tbody>${rows}</tbody></table></main>`;
const limits={maxElements:400,maxTexts:400,maxCandidates:400};
const bytes=value=>Buffer.byteLength(JSON.stringify(value));
async function page(t){
  const page=await browser.newPage();t.after(()=>page.close());
  await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:html}));
  await page.goto('http://fixture.test/customers');
  return page;
}
/** The real engine with a capturing fetch: the bytes that would be sent to Jev. */
function wire(){
  const requests=[];
  const fetch=async(_url,init)=>{const body=JSON.parse(init.body);requests.push(body);
    return Response.json(apiResult(body,q=>Object.hasOwn(q.criteria,'__none__')?'__none__':Object.keys(q.criteria)[0]));};
  return {requests,engine:new JevDecisionEngine({baseURL:'http://127.0.0.1:9/',fetch})};
}
/** Undo the table reference so the compact form can be compared with what the core built. */
function expand(value,table){
  if(Array.isArray(value))return value.map(item=>expand(item,table));
  if(!value||typeof value!=='object')return value;
  return Object.fromEntries(Object.entries(value).filter(([key])=>key!=='contextTable'&&key!=='legend').map(([key,child])=>key==='contextId'?['context',table[child]]:[key,expand(child,table)]));
}
const withoutDefaults=value=>JSON.parse(JSON.stringify(value,(key,child)=>{
  if(key==='frame'&&child===0)return undefined;
  if(['disabled','readOnly','fillable','required','multiple','selected'].includes(key)&&child===false)return undefined;
  if(key==='controls'&&Array.isArray(child)&&!child.length)return undefined;
  if(key==='inputType'&&child==='')return undefined;
  return child;
}));

test('the act/observe request is compacted on the wire without changing candidates, roles, names or contexts',async t=>{
  const seam=engine(()=> '__none__');
  const before=new JevBrowser({page:await page(t),engine:seam,...limits});
  const sent=wire();
  const afterCore=new JevBrowser({page:await page(t),engine:sent.engine,...limits});
  t.after(async()=>{await before.close();await afterCore.close();});
  await before.observe('Edit Customer 7');
  await afterCore.observe('Edit Customer 7');
  const [built]=seam.requests,[compact]=sent.requests;
  const full=bytes(built),small=bytes({state:compact.state,questions:compact.questions});
  t.diagnostic(`observe request: ${full} bytes as built, ${small} bytes on the wire (${Math.round(100-small*100/full)}% smaller)`);
  // 0.13.0 sent ~99.5 KB for this page (40 link URLs, 549 context copies of 83 unique strings).
  assert.ok(small<60_000,`${small} bytes`);
  assert.ok(small<full*0.6,`${small} of ${full}`);
  // Context strings are sent once; every reference resolves.
  const table=compact.state.contextTable;
  assert.equal(new Set(Object.values(table)).size,Object.keys(table).length);
  assert.doesNotMatch(JSON.stringify(compact),/"context":"Customer 7 Example/);
  assert.match(compact.state.legend,/contextTable/);
  // Link URLs are extraction evidence, not act/observe state.
  assert.ok(!JSON.stringify(compact).includes('/customers/7/details'));
  assert.ok(!built.state.page.texts.some(text=>text.attribute==='href'));
  // Same candidates; each keeps its role, name and (resolved) row context.
  assert.deepEqual(Object.keys(compact.questions.action.criteria),Object.keys(built.questions.action.criteria));
  const edit=Object.values(compact.questions.action.criteria).find(candidate=>candidate?.target?.name==='Edit'&&table[candidate.target.contextId]?.startsWith('Customer 7 '));
  assert.equal(edit.target.role,'button');
  // Lossless apart from default-valued flags and the element refs' snapshot nonce.
  const normalize=value=>JSON.parse(JSON.stringify(value).replace(/"(?:id|sourceId)":"r[0-9a-f]+_/g,'"id":"'));
  assert.deepEqual(normalize(expand({state:compact.state,questions:compact.questions},table)),normalize(withoutDefaults({state:built.state,questions:built.questions})));
});

test('extract keeps link URLs and dedups their contexts on the wire',async t=>{
  const sent=wire();
  const core=new JevBrowser({page:await page(t),engine:sent.engine,...limits});t.after(()=>core.close());
  await core.extract('Details link of Customer 7',z.object({url:z.string()})).catch(error=>assert.equal(error.code,'EXTRACTION_MISSING'));
  const [request]=sent.requests;
  t.diagnostic(`extract request: ${bytes({state:request.state,questions:request.questions})} bytes on the wire (0.13.0: ~96.5 KB)`);
  assert.ok(JSON.stringify(request).includes('http://fixture.test/customers/7/details'));
  assert.ok(Object.keys(request.state.contextTable).length>0);
  assert.ok(bytes({state:request.state,questions:request.questions})<70_000);
});

test('compaction leaves requests without repeated contexts or defaults unchanged',()=>{
  const request={state:{screen:'synthetic'},questions:{action:{type:'choice',instructions:'Choose',criteria:{a:{kind:'click',target:{role:'button',name:'Save',context:'Only once here'}},__none__:'No match'}}}};
  assert.deepEqual(compactDecisionRequest(request),request);
  // A caller state that already uses contextTable is never overwritten.
  const owned={state:{contextTable:'mine',a:{context:'shared row text'},b:{context:'shared row text'}},questions:{q:{type:'choice',instructions:'x',criteria:{a:'A'}}}};
  assert.deepEqual(compactDecisionRequest(owned),owned);
});

test('link URLs have their own budget and no longer crowd displayed text out of maxTexts',async t=>{
  const page=await browser.newPage();t.after(()=>page.close());
  await page.setContent(`<main>${Array.from({length:30},(_,i)=>`<p>Note ${i}</p>`).join('')}${Array.from({length:20},(_,i)=>`<a href="/n/${i}">Link ${i}</a>`).join('')}</main>`);
  const core=new JevBrowser({page,engine:engine(()=> '__none__')});t.after(()=>core.close());
  const snapshot=await core.snapshot({maxTexts:50});
  assert.equal(snapshot.truncatedTexts,false);
  assert.equal(snapshot.texts.filter(text=>text.attribute==='href').length,20);
  assert.equal(snapshot.texts.filter(text=>text.attribute!=='href').length,50);
  const tight=await core.snapshot({maxTexts:10});
  assert.equal(tight.truncatedTexts,true);
  assert.equal(tight.texts.filter(text=>text.attribute==='href').length,10);
  assert.equal(tight.texts.filter(text=>text.attribute!=='href').length,10);
});

test('act fails with OBSERVATION_LIMIT before any provider call when its compact request exceeds 128 KiB',async t=>{
  const page=await browser.newPage();t.after(()=>page.close());
  // Unique long contexts cannot be shared, so the compact request stays above the budget.
  await page.setContent(`<ul>${Array.from({length:400},(_,i)=>`<li>Item ${i} ${'unique words '.repeat(35)}${i}<button>Open ${i}</button></li>`).join('')}</ul>`);
  const seam=engine(()=> '__none__');
  const core=new JevBrowser({page,engine:seam,maxElements:1000,maxTexts:2000,maxCandidates:1000});t.after(()=>core.close());
  await assert.rejects(core.act('Open item 7'),error=>error.code==='OBSERVATION_LIMIT'&&/128 KiB/.test(error.message));
  await assert.rejects(core.observe('Open item 7'),error=>error.code==='OBSERVATION_LIMIT');
  assert.equal(seam.requests.length,0);
});
