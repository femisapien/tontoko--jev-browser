import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { JevBrowser, JevDecisionEngine } from '../dist/index.js';
import { wireDecisionRequest } from '../dist/decision.js';
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
// Element refs carry a per-snapshot nonce; everything else must match byte for byte, in the same key order.
const text=value=>JSON.stringify(value).replace(/"(id|sourceId)":"r[0-9a-f]+_/g,'"$1":"');
const withoutMainFrame=value=>JSON.parse(JSON.stringify(value,(key,child)=>key==='frame'&&child===0?undefined:child));

test('act/observe leave link URLs out and send the built request with only frame 0 omitted',async t=>{
  const seam=engine(()=> '__none__');
  const built=new JevBrowser({page:await page(t),engine:seam,...limits});
  const sent=wire();
  const onWire=new JevBrowser({page:await page(t),engine:sent.engine,...limits});
  t.after(async()=>{await built.close();await onWire.close();});
  await built.observe('Edit Customer 7');
  await onWire.observe('Edit Customer 7');
  const [request]=seam.requests,[body]=sent.requests;
  const small={state:body.state,questions:body.questions};
  t.diagnostic(`observe request: ${bytes(request)} bytes as built, ${bytes(small)} bytes on the wire`);
  // 0.13.0 sent ~99.5 KB for this page: 40 link URL entries plus frame 0 on every element and text.
  assert.ok(bytes(small)<90_000,`${bytes(small)} bytes`);
  assert.ok(!JSON.stringify(body).includes('/customers/7/details'));
  assert.ok(!request.state.page.texts.some(source=>source.attribute==='href'));
  assert.ok(request.state.page.texts.some(source=>source.frame===0));
  assert.ok(!/"frame":0\b/.test(JSON.stringify(small)));
  // Row contexts, default-valued flags and key order are untouched.
  assert.match(JSON.stringify(small),/"context":"Customer 7 Example Holdings/);
  assert.match(JSON.stringify(small),/"disabled":false/);
  assert.equal(text(small.state),text(withoutMainFrame(request.state)));
  assert.equal(text(small.questions),text(withoutMainFrame(request.questions)));
});

test('extract keeps link URLs on the wire',async t=>{
  const sent=wire();
  const core=new JevBrowser({page:await page(t),engine:sent.engine,...limits});t.after(()=>core.close());
  await core.extract('Details link of Customer 7',z.object({url:z.string()})).catch(error=>assert.equal(error.code,'EXTRACTION_MISSING'));
  const [request]=sent.requests;
  t.diagnostic(`extract request: ${bytes({state:request.state,questions:request.questions})} bytes on the wire`);
  assert.ok(JSON.stringify(request).includes('http://fixture.test/customers/7/details'));
});

test('the wire form only omits frame 0 and keeps every other field in order',()=>{
  const request={state:{page:{texts:[{id:'a',frame:0,text:'One',context:'Row',role:'cell'},{id:'b',frame:1,text:'Two',context:'Row',role:'cell'}]}},
    questions:{action:{type:'choice',instructions:'Choose',criteria:{a:{kind:'click',target:{id:'e',role:'button',name:'Save',context:'Row',frame:0,disabled:false}},__none__:'No match'}}}};
  const sent=wireDecisionRequest(request);
  assert.equal(JSON.stringify(sent),'{"state":{"page":{"texts":[{"id":"a","text":"One","context":"Row","role":"cell"},{"id":"b","frame":1,"text":"Two","context":"Row","role":"cell"}]}},"questions":{"action":{"type":"choice","instructions":"Choose","criteria":{"a":{"kind":"click","target":{"id":"e","role":"button","name":"Save","context":"Row","disabled":false}},"__none__":"No match"}}}}');
  // The caller's request is not mutated.
  assert.equal(request.state.page.texts[0].frame,0);
  const plain={state:{screen:'synthetic'},questions:{q:{type:'choice',instructions:'x',criteria:{a:'A'}}}};
  assert.equal(JSON.stringify(wireDecisionRequest(plain)),JSON.stringify(plain));
});

test('link URLs have their own budget and no longer crowd displayed text out of maxTexts',async t=>{
  const page=await browser.newPage();t.after(()=>page.close());
  await page.setContent(`<main>${Array.from({length:30},(_,i)=>`<p>Note ${i}</p>`).join('')}${Array.from({length:20},(_,i)=>`<a href="/n/${i}">Link ${i}</a>`).join('')}</main>`);
  const core=new JevBrowser({page,engine:engine(()=> '__none__')});t.after(()=>core.close());
  const snapshot=await core.snapshot({maxTexts:50});
  assert.equal(snapshot.truncatedTexts,false);
  assert.equal(snapshot.texts.filter(source=>source.attribute==='href').length,20);
  assert.equal(snapshot.texts.filter(source=>source.attribute!=='href').length,50);
  const tight=await core.snapshot({maxTexts:10});
  assert.equal(tight.truncatedTexts,true);
  assert.equal(tight.texts.filter(source=>source.attribute==='href').length,10);
  assert.equal(tight.texts.filter(source=>source.attribute!=='href').length,10);
});

test('act and observe fail with OBSERVATION_LIMIT before any provider call when the request exceeds 128 KiB',async t=>{
  const page=await browser.newPage();t.after(()=>page.close());
  await page.setContent(`<ul>${Array.from({length:400},(_,i)=>`<li>Item ${i} ${'unique words '.repeat(35)}${i}<button>Open ${i}</button></li>`).join('')}</ul>`);
  const seam=engine(()=> '__none__');
  const core=new JevBrowser({page,engine:seam,maxElements:1000,maxTexts:2000,maxCandidates:1000});t.after(()=>core.close());
  await assert.rejects(core.act('Open item 7'),error=>error.code==='OBSERVATION_LIMIT'&&/128 KiB/.test(error.message));
  await assert.rejects(core.observe('Open item 7'),error=>error.code==='OBSERVATION_LIMIT');
  assert.equal(seam.requests.length,0);
});

test('a hosted input token rejection surfaces as OBSERVATION_LIMIT on every decision path',async t=>{
  // The #37 page is ~86 KB on the wire: under the 128 KiB pre-check, but hosted Jev rejects it by token count.
  let calls=0;
  const decisions=new JevDecisionEngine({baseURL:'http://127.0.0.1:9/',fetch:async()=>{calls++;return Response.json({detail:{error_type:'max_tokens_exceeded'}},{status:400});}});
  const core=new JevBrowser({page:await page(t),engine:decisions,...limits});
  t.after(()=>core.close());
  const paths={
    observe:()=>core.observe('Edit Customer 7'),
    act:()=>core.act('Edit Customer 7'),
    run:()=>core.run('Edit Customer 7'),
    extract:()=>core.extract('Customer names',z.object({names:z.array(z.string())})),
    locateSemantic:()=>core.locateSemantic('The edit button of Customer 7'),
    compareSemantic:()=>core.compareSemantic({actual:{description:'The status of Customer 7'},expected:'Active'},{maxCandidates:1000}),
  };
  for(const [name,call] of Object.entries(paths)){
    const before=calls;
    const error=await call().then(()=>undefined,e=>e);
    assert.equal(error?.code,'OBSERVATION_LIMIT',`${name}: ${error?.code} ${error?.message}`);
    assert.equal(error.retryable,false,name);
    assert.match(error.message,/Narrow scope or exclude, or lower maxElements\/maxTexts\/maxCandidates/,name);
    assert.ok(calls>before,`${name} reached the provider`);
  }
});
