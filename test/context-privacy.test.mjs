import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { JevBrowser } from '../dist/index.js';
import { fixtureBrowser, engine } from './helpers.mjs';
let browser;
before(async()=>{browser=await fixtureBrowser();});
after(async()=>{await browser?.close();});

// Row, list-item, form and record context strings are copied into every decision request.
// Editable text and native option labels must not ride along with unrelated targets.
const html=`<form aria-label="Profile">
  <table><tbody><tr><td>Notes row</td>
    <td><div role="textbox" aria-label="Private note" contenteditable="true"><p>CE-SEED</p></div></td>
    <td><textarea aria-label="Draft">TA-SEED</textarea></td>
    <td><button type="button">Save row</button></td></tr></tbody></table>
  <ul><li>Country item <select aria-label="Country"><option>OPT-ALPHA</option><option>OPT-BETA</option></select>
    <input aria-label="Token"> <button type="button">Apply item</button></li></ul>
  <article><h2>Plain card</h2><p>Card body</p><div contenteditable="plaintext-only" aria-label="Scratch">PT-SEED</div><button type="button">Open card</button></article>
  <dl><dt>Memo term</dt><dd><div contenteditable="true" aria-label="Memo">DD-SEED</div><button type="button">Edit memo</button></dd></dl>
</form>`;

test('context strings exclude contenteditable text, native options and form control text',async t=>{
  const page=await browser.newPage();await page.setContent(html);
  await page.getByRole('textbox',{name:'Private note'}).click();await page.keyboard.type(' CE-TYPED-SECRET');
  await page.getByLabel('Draft').fill('TA-TYPED-SECRET');
  await page.getByLabel('Token').fill('IN-TYPED-SECRET');
  const decisions=engine(()=> '__none__');
  const core=new JevBrowser({page,engine:decisions});
  t.after(async()=>{await core.close();await page.close();});
  const snapshot=await core.snapshot();
  await core.observe('Find the save button').catch(()=>{});
  await core.act('Click Save row').catch(()=>{});
  assert.ok(decisions.requests.length>0,'a decision request was made');
  const wire=JSON.stringify(decisions.requests),local=JSON.stringify(snapshot);
  const contexts=JSON.stringify([...snapshot.elements.map(e=>e.context)]);
  for(const secret of ['CE-SEED','CE-TYPED-SECRET','TA-SEED','TA-TYPED-SECRET','IN-TYPED-SECRET','PT-SEED','DD-SEED']){
    assert.ok(!wire.includes(secret),`${secret} leaked into a decision request`);
    assert.ok(!local.includes(secret),`${secret} leaked into the snapshot`);
  }
  // Option labels stay available on the select element itself, never in unrelated context strings.
  assert.ok(!contexts.includes('OPT-ALPHA')&&!contexts.includes('OPT-BETA'),contexts);
  assert.equal(snapshot.elements.find(e=>e.name==='Country').options.length,2);
  // Row identity and labels are retained.
  const byName=name=>snapshot.elements.find(e=>e.name===name);
  assert.match(byName('Save row').context,/Notes row/);
  assert.match(byName('Save row').context,/Save row/);
  assert.match(byName('Apply item').context,/Country item/);
  assert.match(byName('Open card').context,/Plain card Card body/);
  assert.match(byName('Edit memo').context,/Memo term/);
  assert.ok(wire.includes('Notes row'));
});
