import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';

// A project's own Playwright Test may differ from the Playwright this package bundles.
// Playwright Test refuses to load a second copy, so the installed SDK must never load one.
export async function checkInstalledRunner(npm,tarball,baseEnv){
  const bundled=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).dependencies.playwright;
  const [major,minor]=bundled.split('.').map(Number);assert.ok(minor>0,'Choose another Playwright Test version for the caller runner check.');
  // One minor back is a separate copy whose client still drives the bundled Chromium build.
  const other=`${major}.${minor-1}.0`;
  const directory=await mkdtemp(join(tmpdir(),'jev-runner-consumer-'));
  function run(args){return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,args,{cwd:directory,env:baseEnv,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Caller runner process timed out'));},120000);
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('close',code=>{clearTimeout(timer);if(code!==0)reject(new Error(`Caller runner process failed (${code})\n${stdout}\n${stderr}`));else resolve(stdout);});
  });}
  try{
    await writeFile(join(directory,'package.json'),JSON.stringify({private:true,type:'module'}));
    await run([npm,'install','--ignore-scripts','--no-audit','--no-fund',`@playwright/test@${other}`,tarball]);
    const playwright=from=>createRequire(join(directory,'node_modules',from,'package.json'))('playwright/package.json').version;
    assert.deepEqual([playwright('@playwright/test'),playwright('@tontoko/jev-browser')],[other,bundled],'The caller runner check needs two Playwright copies.');
    await writeFile(join(directory,'playwright.config.mjs'),`import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'.',reporter:'line',workers:1,use:{browserName:'chromium',launchOptions:{executablePath:${JSON.stringify(chromium.executablePath())}}}});
`);
    const html=`<h1>Pending</h1><button onclick="document.querySelector('h1').textContent='Saved'">Save</button>`;
    await writeFile(join(directory,'borrowed.spec.mjs'),`import {test,expect} from '@playwright/test';
import {JevBrowser} from '@tontoko/jev-browser';
test('the installed SDK borrows the caller runner Page',async({page})=>{
  await page.setContent(${JSON.stringify(html)});
  const browser=new JevBrowser({page});
  try{
    expect((await browser.snapshot()).elements.some(e=>e.name==='Save')).toBe(true);
    await browser.native({command:'click',target:'button'});
    await browser.native({command:'assert',target:'h1',property:'text',expected:'Saved'});
    await expect(page.getByRole('heading')).toHaveText('Saved');
  }finally{await browser.close();}
  expect(page.isClosed()).toBe(false);
});
`);
    const output=await run([join(directory,'node_modules','@playwright','test','cli.js'),'test']);
    assert.match(output,/\b1 passed\b/,output);
    return {callerPlaywrightTest:other};
  }finally{await rm(directory,{recursive:true,force:true,maxRetries:8,retryDelay:125});}
}
