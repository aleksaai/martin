// Real Chromium + actual bot handlers. External services are replaced by local fixtures.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
process.env.ANTHROPIC_API_KEY='test';process.env.TELEGRAM_BOT_TOKEN='test';
let received=0,photoMarkup:any,modelCalls=0,confirm=true;
const html=`<!doctype html><html><body><form action="/submitted" method="post">
<label>Vorname<input name="first" required></label>
<label>Wochenstunden<input name="hours" required></label>
<label>Application documents<input type="file" name="attachments"></label>
<label><input type="checkbox" name="consent" required>Datenschutzhinweise gelesen</label>
<a onclick="document.querySelector('form').requestSubmit()">Bewerben</a></form><div id="files"></div>
<script>document.querySelectorAll('input[type=file]').forEach(el=>el.onchange=()=>{let d=document.createElement('p');d.textContent=el.files[0].name;document.querySelector('#files').append(d)})</script></body></html>`;
const server=createServer((req,res)=>{if(req.url==='/submitted'){received++;res.setHeader('content-type','text/html; charset=utf-8');res.end(confirm ? 'Vielen Dank für Ihre Bewerbung.' : 'Vielen Dank für Ihr Interesse. Bitte prüfen Sie Ihre Angaben.');}else{res.setHeader('content-type','text/html; charset=utf-8');
if(req.url==='/jobs')res.end('<h1>Stellenübersicht</h1><form><h2>Kontakt</h2><input><input type="email"><textarea></textarea><button>Absenden</button></form><article><h2>Werkstudent</h2><span class="job-location">Köln</span><div hidden><a href="/job/details">Mehr erfahren</a></div></article>');
else if(req.url==='/job/details')res.end('<h1>Werkstudent Köln</h1><a href="/landing" target="_blank">Bewerben</a>');
else if(req.url==='/landing')res.end('<h1>Werkstudent Köln</h1><a href="/form">Submit application</a>');
else res.end(html);
}});
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
const port=(server.address() as any).port;
const fetchOriginal=globalThis.fetch;
globalThis.fetch=(async(url:any,init:any)=>{
 if(String(url).includes('api.telegram.org')){
   if(init.body instanceof FormData){const x=init.body.get('reply_markup');if(x)photoMarkup=JSON.parse(String(x));}
   return new Response(JSON.stringify({ok:true,result:{message_id:Math.floor(Math.random()*100000)}}));
 }
 if(String(url).includes('api.anthropic.com')){
   modelCalls++;const req=JSON.parse(init.body);let content:any[];
   if(req.tools){
     const last=req.messages.at(-1);
     content=Array.isArray(last.content)&&last.content.some((x:any)=>x.type==='tool_result')?[{type:'text',text:'[STILL]'}]:[{type:'tool_use',id:'t1',name:'formular_ergaenzen',input:{angaben:'20 Stunden pro Woche'}}];
   }else{
     const fields=JSON.parse(req.messages[0].content.split('Felder:\n')[1]);
     const id=(part:string)=>fields.find((f:any)=>f.label.includes(part))?.id;
     const hours=req.system.includes('20 Stunden pro Woche');
     content=[{type:'text',text:JSON.stringify({fill:[{id:id('Vorname'),value:'Martin'},...(hours?[{id:id('Wochenstunden'),value:'20'}]:[])],files:[{id:id('Application documents'),doc:'lebenslauf'}],check:[],consent:[id('Datenschutzhinweise')],offen:hours?[]:['Wie viele Stunden pro Woche?']})}];
   }
   return new Response(JSON.stringify({id:'msg-test',type:'message',role:'assistant',model:'test',content,stop_reason:content[0].type==='tool_use'?'tool_use':'end_turn',usage:{input_tokens:1,output_tokens:1}}),{headers:{'content-type':'application/json'}});
 }
 throw new Error(`Unexpected network call: ${url}`);
}) as typeof fetch;
const job:any={id:'fixture',company:'Local fixture',title:'Werkstudent',url:`http://127.0.0.1:${port}/jobs`,source:'fixture',description:'',location:'Köln'};
const kv=new Map([['ref:fixture','fixture']]);let application:any={job_id:job.id,status:'entwurf',letter:'Betreff: Bewerbung\n\nSehr geehrte Damen und Herren,\n\nIch bewerbe mich als Werkstudent.\n\nMit freundlichen Grüßen\nMartin Spalevic'};
const store:any={kvGet:async(k:string)=>kv.get(k)??null,kvSet:async(k:string,v:string)=>kv.set(k,v),getJob:async()=>job,getApplication:async()=>application,listDocuments:async()=>[],subscribers:async()=>[{chat_id:'test',paused:false}],upsertApplication:async(a:any)=>{application={...application,...a}},setFeedback:async()=>{}};
const {handle}=await import('../src/telegram.ts');
const {inspectForm,submitForm,cancelForm}=await import('../src/apply.ts');
const callback=(data:string)=>({callback_query:{id:'c',data,message:{chat:{id:'test'}}}});
// Rapid double click: both updates must complete without closing each other's page.
await Promise.all([handle(callback('form:fixture'),store,async()=>''),handle(callback('form:fixture'),store,async()=>'')]);
let state=await inspectForm('test');assert(state);assert.equal(new URL(state.url).pathname,'/form');assert.equal(state.ready,false);assert.equal(received,0);
assert(!photoMarkup.inline_keyboard.flat().some((b:any)=>b.text.includes('Absenden')));
// Natural-language reply travels through chat agent -> refill -> actual browser.
await handle({message:{chat:{id:'test'},message_id:30,text:'Ich kann 20 Stunden pro Woche arbeiten.'}},store,async()=>'');
state=await inspectForm('test');assert.equal(state?.ready,true,JSON.stringify(state?.issues));assert.equal(received,0);
const oldReview=state!.review;
// Wrong chat cannot act on an existing form.
assert.equal(await submitForm(store,'other','fixture',oldReview),'weg');assert.equal(received,0);
// A stale approval must only rebuild the preview, never submit.
assert.equal(await submitForm(store,'test','fixture','outdated'),'weg');assert.equal(received,0);
const buttons=photoMarkup.inline_keyboard.flat();const send=buttons.find((b:any)=>b.text.includes('Absenden'));assert(send);
await Promise.all([handle(callback(send.callback_data),store,async()=>''),handle(callback(send.callback_data),store,async()=>'')]);
console.log('DELIVERY',kv.get('form_delivery:test:fixture'), 'APP',application.status);assert.equal(received,1,'one explicit click sequence submits once');assert.equal(application.status,'beworben');
assert.equal(JSON.parse(kv.get('form_delivery:test:fixture')!).status,'confirmed');
// Restart/replay cannot submit again.
await handle(callback(send.callback_data),store,async()=>'');assert.equal(received,1);
cancelForm('fixture');
confirm=false;job.id='uncertain';kv.set('ref:uncertain','uncertain');application={...application,job_id:job.id,status:'entwurf'};
const {startForm}=await import('../src/apply.ts');
await startForm(store,'test',job,'uncertain','20 Stunden pro Woche');
const unconfirmed=await inspectForm('test');assert.equal(unconfirmed?.ready,true);
assert.equal(await submitForm(store,'test','uncertain',unconfirmed!.review),'unklar');
assert.equal(JSON.parse(kv.get('form_delivery:test:uncertain')!).status,'uncertain');
assert.equal(application.status,'entwurf');assert.equal(received,2);
await submitForm(store,'test','uncertain',unconfirmed!.review);assert.equal(received,2);
cancelForm('uncertain');server.close();
console.log(`PASS real browser E2E: parallel clicks, partial form, natural-language reply, verified uploads/fields, approval guard, one submission, tracking, replay protection (${modelCalls} model fixtures).`);process.exit(0);
