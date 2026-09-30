// Regressions for observed-target authority, readback freshness, scoped progress waits and
// speculative actions after input effects (from #15, tracked in #37).
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {JevBrowser} from '../dist/index.js';
import {BrowserError,publicError} from '../dist/errors.js';
import {capture} from '../dist/observation.js';
import {waitForRelevantChange} from '../dist/completion.js';
import {fixtureBrowser,engine} from './helpers.mjs';
import {selectionFixture} from './selection-fixture.mjs';
import {modernFixture} from './modern-fixture.mjs';
import {continuationFixture,stagedDecider,goal,values} from './continuation-fixture.mjs';
let browser;
before(async()=>{browser=await fixtureBrowser();});after(async()=>{await browser?.close();});
const limits={maxElements:120,maxTexts:160};
const simpleEngine=()=>engine((q,r,id)=>id.startsWith('effect_')?'commit':id==='action'?c=>c?.kind==='click'&&c.target?.name==='Save':'__none__');
async function scopeApp(t,{moveAt,entry}={}){
 const context=await browser.newContext(),page=await context.newPage();
 await page.setContent('<main id="allowed"><section id="inner"><form aria-label="Record"><button type="button" onclick="window.saves=(window.saves||0)+1">Save</button></form></section><section id="another"></section></main><aside id="outside"></aside>');
 const move=()=>page.evaluate(()=>document.querySelector('#outside').append(document.querySelector('form')));
 const decider=simpleEngine(),original=decider.decide.bind(decider);let moved=false;
 decider.decide=async(r,o)=>{const result=await original(r,o);if(moveAt==='model'&&!moved){moved=true;await move();}return result;};
 const policy=kind=>async()=>{if(moveAt===kind&&!moved){moved=true;await move();}return true;};
 const core=new JevBrowser({page,engine:decider,allowAction:policy('allowAction'),allowCommand:policy('allowCommand')});
 t.after(async()=>{await core.close();await context.close();});
 const invoke=()=>entry==='run'?core.run('Save the record once.',{scope:'#allowed',settleTimeoutMs:80,maxSteps:4,until:p=>p.evaluate(()=>window.saves===1)}):core.act('Click Save.',{scope:'#allowed'});
 return {core,page,move,invoke};
}
for(const entry of ['act','run'])for(const moveAt of ['model','allowAction','allowCommand'])test(`observed scope: ${entry} cannot execute after ${moveAt} moves target outside`,async t=>{
 const a=await scopeApp(t,{entry,moveAt});let result,error;try{result=await a.invoke();}catch(e){error=e;}
 assert.equal(await a.page.evaluate(()=>window.saves||0),0);assert.notEqual(result?.status,'complete');assert.notEqual(result?.status,'executed');
 if(error)assert.equal(error.code,'STALE_TARGET');
});
for(const entry of ['plan','native-ref'])test(`observed scope: captured scope survives ${entry} handoff`,async t=>{
 const a=await scopeApp(t);const h=entry==='plan'?await a.core.observe('Click Save.',{scope:'#allowed'}):(await a.core.snapshot({scope:'#allowed'})).elements.find(e=>e.name==='Save');await a.move();
 await assert.rejects(entry==='plan'?a.core.act({id:h.id}):a.core.native({command:'click',ref:h.id}),{code:'STALE_TARGET'});assert.equal(await a.page.evaluate(()=>window.saves||0),0);
});
for(const mode of ['scope','selection'])for(const changed of ['none','outside','inside'])test(`progress wait: ${mode} capture, ${changed} change, ignores unrelated frames and regions`,async t=>{
 const context=await browser.newContext(),page=await context.newPage();t.after(()=>context.close());
 await page.setContent('<main id="task"><p id="inside">Pending</p></main><aside id="ticker">zero</aside><iframe srcdoc="<p>Unrelated</p>"></iframe>');await page.frameLocator('iframe').locator('p').waitFor();
 const handle=mode==='selection'?await page.locator('#task').elementHandle():undefined;
 const snapshot=await capture(page,{...limits,...(handle?{selection:{frame:page.mainFrame(),roots:[handle]}}:{scope:'#task'})});t.after(async()=>{await snapshot.dispose();await handle?.dispose();});
 if(changed==='outside')await page.locator('#ticker').evaluate(el=>el.textContent='one');if(changed==='inside')await page.locator('#inside').evaluate(el=>el.textContent='Saved');
 const actual=await waitForRelevantChange(page,snapshot,180,new AbortController().signal);assert.equal(actual,changed==='inside');
});
for(const mode of ['stable','changed','removed','rejected'])test(`readback checkpoint: ${mode} readback must be current before adoption`,async t=>{
 const f=await selectionFixture(t,browser),original=f.decider.decide.bind(f.decider);let reads=0;
 f.decider.decide=async(r,o)=>{const result=await original(r,o);if(r.questions.completion){reads++;
  if(mode==='rejected'&&r.state.page.texts.some(s=>s.role==='alert'))result.answers.completion.choice='rejected';
  if(reads===1){if(mode==='changed')await f.page.locator('#result dd').first().evaluate(el=>el.textContent='DE');if(mode==='removed')await f.page.locator('#result article').evaluate(el=>el.remove());if(mode==='rejected')await f.page.evaluate(()=>{const p=document.createElement('p');p.setAttribute('role','alert');p.textContent='Address rejected';document.body.append(p);});}}
  return result;};
 const r=await f.core.run('Save address once and verify the saved fields.',{values:{country:'JP',note:'synthetic-checkpoint'},settleTimeoutMs:1000,timeoutMs:15000});assert.equal(f.submissions.length,1);
 // The save response can take longer than a short settle window on a slow runner; this case is about adoption, not latency.
 if(mode==='stable'){assert.equal(r.status,'complete',JSON.stringify({reason:r.reason,reads}));assert.equal(reads,1);}else{assert.notEqual(r.status,'complete',JSON.stringify(r));assert.equal(r.checkpoints?.length??0,0);}
});
for(const closed of [false,true])test(`carried state: a run failure keeps its own error and executed steps (${closed?'Page closed':'Page open'})`,async t=>{
 const page=await browser.newPage();let nexts=0;await page.exposeFunction('recordNext',()=>{nexts++;});
 await page.setContent('<form><label>Email<input></label><button type="button" onclick="window.recordNext();document.querySelector(\'input\').type=\'hidden\';this.textContent=\'Continue\'">Next</button></form>');
 const decider=engine((q,r,id)=>id.startsWith('bind_')?r.state.page.elements.find(e=>e.name==='Email')?.id??'__none__':id.startsWith('effect_')?'advance':id==='action'?c=>c?.kind==='click'&&c.target?.name==='Next':'__none__');const decide=decider.decide.bind(decider);let calls=0;
 decider.decide=async(r,o)=>{calls++;if(calls>1){if(closed)await page.close();throw new BrowserError('PROVIDER_ERROR','Synthetic primary failure');}return decide(r,o);};
 const core=new JevBrowser({page,engine:decider});t.after(async()=>{await core.close();await page.close();});let e;try{await core.run('Enter email, click Next, then continue.',{values:{email:'synthetic@example.invalid'},decisionRetries:0});}catch(error){e=error;}
 assert.equal(e?.code,'PROVIDER_ERROR');assert.equal(publicError(e).code,'PROVIDER_ERROR');assert.equal(nexts,1);assert.ok(e.partial.steps.some(s=>s.plan.action.kind==='fill'));assert.ok(e.partial.steps.some(s=>s.plan.action.kind==='click'));if(closed)assert.equal(e.partial.continuation,undefined);
});

test('observed scope: moving within the captured scope is not a false refusal',async t=>{
 const a=await scopeApp(t);const plan=await a.core.observe('Click Save.',{scope:'#allowed'});
 await a.page.evaluate(()=>document.querySelector('#another').append(document.querySelector('form')));
 assert.equal((await a.core.act({id:plan.id})).status,'executed');assert.equal(await a.page.evaluate(()=>window.saves),1);
});
test('progress wait: replacing a captured root is a change',async t=>{
 const page=await browser.newPage();t.after(()=>page.close());await page.setContent('<main id="task"><p>Pending</p></main>');
 const observed=await capture(page,{...limits,scope:'#task'});t.after(()=>observed.dispose());
 await page.locator('#task').evaluate(el=>el.outerHTML='<main id="task"><p>Pending</p></main>');
 assert.equal(await waitForRelevantChange(page,observed,180,new AbortController().signal),true);
});

for(const move of [false,true])test(`observed scope: owned popup control ${move?'leaves':'stays in'} original caller scope during option approval`,async t=>{
 let page;
 const app=await modernFixture(t,browser,{browserOptions:{allowCommand:async command=>{
   if(move&&command.command==='click'&&command.element==='Viola da gamba')await page.evaluate(()=>{const outside=document.createElement('aside');document.body.append(outside);outside.append(document.querySelector('form'));});
   return true;
 }}});page=app.page;await page.getByRole('button',{name:'New learner',exact:true}).click();
 let result,error;try{result=await app.core.run('Fill supplied learner details, select instrument and create the learner once.',{scope:'#editor',values:{student:{fullName:'Synthetic Learner',contactEmail:'synthetic@example.invalid'},instrument:'Viola da gamba'},settleTimeoutMs:150});}catch(e){error=e;}
 if(move){assert.equal(await page.evaluate(()=>window.optionClicks||0),0);assert.equal(app.attempts.length,0);assert.notEqual(result?.status,'complete');assert.equal(error?.code,'STALE_TARGET');}
 else{assert.equal(app.attempts.length,1);assert.equal(await page.evaluate(()=>window.optionClicks),1);}
});

for(const preselected of [false,true])test(`speculative action: a pre-resolution action cannot overwrite the resolved input (${preselected?'already selected':'new selection'})`,async t=>{
 const app=await selectionFixture(t,browser,{choice:'option_2',resultCountry:'DE'});
 if(preselected)await app.page.locator('select').selectOption('DE');
 await app.page.evaluate(()=>{window.selectedCountries=[];document.querySelector('select').addEventListener('change',e=>window.selectedCountries.push(e.target.value));});
 const decide=app.decider.decide.bind(app.decider);
 app.decider.decide=async(r,o)=>{
   const result=await decide(r,o);
   if(r.questions.action&&r.state.inputs.some(input=>input.path==='/country'&&!input.applied)){
     const stale=Object.entries(r.questions.action.criteria).find(([,action])=>action?.kind==='select'&&action.option?.label==='日本');
     if(stale){result.answers.action={choice:stale[0],confidence:0.95};result.answers['effect_'+stale[0]]={choice:'advance',confidence:0.95};}
   }
   return result;
 };
 const result=await app.core.run('Use the supplied country and private note, then Save once.',{values:{country:'Germany',note:'synthetic-state-change'},semanticInputs:{'/country':0.8},maxSteps:8,maxDecisions:16});
 assert.equal(result.status,'complete',JSON.stringify(result));assert.equal(app.submissions.length,1);assert.equal(app.submissions[0].a9,'DE');
 assert.ok(!(await app.page.evaluate(()=>window.selectedCountries)).includes('JP'),'The obsolete predicted action must not undo the resolved field.');
 assert.ok(app.decider.requests.some(r=>r.questions.action&&r.state.inputs.some(input=>input.path==='/country'&&input.applied)));
});

test('speculative action: a premature model done cannot bypass a failing final expect',async t=>{
  const decider=stagedDecider(3),decide=decider.decide.bind(decider);let forced=false;
  decider.decide=async(request,options)=>{
    const result=await decide(request,options);
    if(!forced&&request.questions.action&&request.state.page?.elements?.some(element=>element.name==='Save reservation')&&request.state.inputs.some(input=>input.path==='/reservationReference'&&!input.applied)){
      result.answers.action={choice:'__done__',confidence:0.95};forced=true;
    }
    return result;
  };
  const app=await continuationFixture(t,browser,{decider});
  const result=await app.core.run(goal,{values,expect:{target:'#final',property:'text',expected:'Ready'}});
  assert.equal(forced,true);
  assert.equal(result.status,'complete',JSON.stringify(result));
  assert.equal(result.checkpoints.length,3);
});
