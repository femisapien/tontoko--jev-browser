import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {JevBrowser} from '../dist/index.js';
import {fixtureBrowser} from './helpers.mjs';
let browser;
const confirmButton='<button onclick="document.title=String(confirm(\'Delete?\'))">Delete</button>';
before(async()=>{browser=await fixtureBrowser();});
after(async()=>{await browser?.close();});
async function fixture(t,html,options={}){
 const context=await browser.newContext();const page=await context.newPage();
 const core=new JevBrowser({page,...options});
 t.after(async()=>{await core.close();await context.close();});
 if(html!==undefined)await page.setContent(html);return {core,page,context};
}

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
