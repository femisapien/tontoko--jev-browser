import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright-core';

// A project's own Playwright Test may pin an older Playwright than this package is developed with.
// playwright-core is a peer, so the SDK shares the caller's copy, and Playwright Test must never be loaded twice.
const minimum=async()=>/^>=(\d+\.\d+\.\d+) /.exec(JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).peerDependencies['playwright-core'])[1];
function runner(directory,baseEnv){return args=>new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,args,{cwd:directory,env:baseEnv,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);
  const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error(`Caller runner process timed out: ${args.slice(1).join(' ')}\n${stdout.slice(-4000)}\n${stderr.slice(-4000)}`));},120000);
  child.once('error',error=>{clearTimeout(timer);reject(error);});
  child.once('close',code=>{clearTimeout(timer);if(code!==0)reject(new Error(`Caller runner process failed (${code})\n${stdout}\n${stderr}`));else resolve(stdout);});
});}
export async function checkInstalledRunner(npm,tarball,baseEnv){
  const other=await minimum();
  const directory=await mkdtemp(join(tmpdir(),'jev-runner-consumer-'));
  const run=runner(directory,baseEnv);
  try{
    await writeFile(join(directory,'package.json'),JSON.stringify({private:true,type:'module'}));
    // npm resolves an unpinned peer to the newest release; pinning playwright-core to the runner's version makes one shared copy.
    await run([npm,'install','--ignore-scripts','--no-audit','--no-fund',`@playwright/test@${other}`,`playwright-core@${other}`,tarball]);
    const core=(...from)=>{const require=createRequire(join(directory,'node_modules',...from,'package.json'));return {path:require.resolve('playwright-core/package.json'),version:require('playwright-core/package.json').version};};
    const host=core('playwright'),sdk=core('@tontoko','jev-browser');
    assert.equal(host.version,other);assert.deepEqual(sdk,host,'The SDK must share the caller\'s playwright-core.');
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

// An older playwright-core forced past the peer range is refused with CONFIG before any browser is used.
export async function checkInstalledMinimum(npm,tarball,baseEnv){
  const [major,minor]=(await minimum()).split('.').map(Number);
  const old=`${major}.${minor-1}.0`;
  const directory=await mkdtemp(join(tmpdir(),'jev-minimum-consumer-'));
  const run=runner(directory,baseEnv);
  try{
    await writeFile(join(directory,'package.json'),JSON.stringify({private:true,type:'module'}));
    const zod=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).devDependencies.zod;
    await run([npm,'install','--ignore-scripts','--no-audit','--no-fund','--legacy-peer-deps',`playwright-core@${old}`,`zod@${zod}`,tarball]);
    const output=await run(['--input-type=module','-e',`
      import assert from 'node:assert/strict';
      import {JevBrowser} from '@tontoko/jev-browser';
      const refused=error=>error.code==='CONFIG'&&error.message.includes('playwright-core >=${major}.${minor}.0 <2')&&error.message.includes('${old}');
      assert.throws(()=>new JevBrowser({page:{}}),refused);
      await assert.rejects(JevBrowser.launch(),refused);
      console.log('refused');
    `]);
    assert.match(output,/refused/);
    return {refusedPlaywrightCore:old};
  }finally{await rm(directory,{recursive:true,force:true,maxRetries:8,retryDelay:125});}
}
