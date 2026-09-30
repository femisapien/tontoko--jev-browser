// Structured-extraction evidence keys are reversible field paths (from #15, tracked in #37).
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {JevBrowser} from '../dist/index.js';
import {fixtureBrowser,engine} from './helpers.mjs';
let browser;
before(async()=>{browser=await fixtureBrowser();});after(async()=>{await browser?.close();});
// Each field's description names the displayed value it should copy.
const byDescription=()=>engine(q=>c=>c?.value===/COPY\(([^)]*)\)/.exec(q.instructions)?.[1]);
async function extract(t,html,schema){
  const page=await browser.newPage();await page.setContent(html);
  const core=new JevBrowser({page,engine:byDescription()});t.after(async()=>{await core.close();await page.close();});
  return core.extract('Extract each labeled field.',schema);
}
test('extract field paths: a literal dotted key and a nested key keep distinct evidence',async t=>{
  const r=await extract(t,'<p>flat-value</p><p>nested-value</p>',z.object({'a.b':z.string().describe('COPY(flat-value)'),a:z.object({b:z.string().describe('COPY(nested-value)')})}));
  assert.deepEqual(r.data,{'a.b':'flat-value',a:{b:'nested-value'}});
  assert.deepEqual(Object.keys(r.evidence).sort(),['a.b','a\\.b']);
  assert.equal(r.evidence['a\\.b'].copiedValue,'flat-value');
  assert.equal(r.evidence['a.b'].copiedValue,'nested-value');
});
test('extract field paths: backslash and empty keys are escaped reversibly',async t=>{
  const r=await extract(t,'<p>empty-value</p><p>slash-value</p><p>dot-value</p><p>inner-value</p>',z.object({
    '':z.string().describe('COPY(empty-value)'),'\\':z.string().describe('COPY(slash-value)'),'.':z.string().describe('COPY(dot-value)'),
    x:z.object({'':z.string().describe('COPY(inner-value)')}),
  }));
  assert.deepEqual(r.data,{'':'empty-value','\\':'slash-value','.':'dot-value',x:{'':'inner-value'}});
  assert.equal(r.evidence[''].copiedValue,'empty-value');
  assert.equal(r.evidence['\\\\'].copiedValue,'slash-value');
  assert.equal(r.evidence['\\.'].copiedValue,'dot-value');
  assert.equal(r.evidence['x.'].copiedValue,'inner-value');
  assert.equal(Object.keys(r.evidence).length,4);
});
test('extract field paths: a field nested under an empty name does not collide with a root field',async t=>{
  const r=await extract(t,'<p>root-value</p><p>under-empty-value</p>',z.object({b:z.string().describe('COPY(root-value)'),'':z.object({b:z.string().describe('COPY(under-empty-value)')})}));
  assert.deepEqual(r.data,{b:'root-value','':{b:'under-empty-value'}});
  assert.equal(r.evidence.b.copiedValue,'root-value');
  assert.equal(r.evidence['.b'].copiedValue,'under-empty-value');
});
test('extract field paths: ordinary keys and a root scalar keep their existing form',async t=>{
  const r=await extract(t,'<p>plain-value</p>',z.object({order:z.object({total:z.string().describe('COPY(plain-value)')})}));
  assert.deepEqual(Object.keys(r.evidence),['order.total']);
  const scalar=await extract(t,'<p>plain-value</p>',z.string().describe('COPY(plain-value)'));
  assert.deepEqual(Object.keys(scalar.evidence),['value']);
});
