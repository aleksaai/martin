// Real portals + model, isolated Store and intercepted Telegram. NEVER calls submitForm.
import {readFileSync,writeFileSync} from 'node:fs';
const dir=process.env.MARTIN_TEST_DIR!;
if(!dir) throw new Error('MARTIN_TEST_DIR required (private snapshot/runtime directory)');
Object.assign(process.env,JSON.parse(readFileSync(`${dir}/runtime.json`,'utf8')));
const data=JSON.parse(readFileSync(`${dir}/snapshot.json`,'utf8'));
const kv=new Map<string,string>(data.kv.map((r:any)=>[r.key,r.value]));
const ey=process.argv[2]==='ey';
const slug=ey?'ey':'rewe';
const job=data.jobs.find((j:any)=>ey?j.company.includes('Young'):j.company.includes('REWE'));
const draft=[...kv.entries()].find(([k])=>k.startsWith('form_draft:')&&k.endsWith(`:${job.id}`));
if(draft)kv.set(`form_draft:test:${job.id}`,draft[1]);
kv.set('active_job:test',job.id);kv.set('ref:test',job.id);
let n=0;
const fetchOriginal=globalThis.fetch;
globalThis.fetch=(async(url:any,init:any)=>{
  if(String(url).startsWith('https://api.telegram.org/')){
    n++;const body=init.body instanceof FormData?Object.fromEntries(init.body.entries()):JSON.parse(init.body);
    if(body.photo){writeFileSync(`${dir}/${slug}-flow-${n}.jpg`,Buffer.from(await body.photo.arrayBuffer()));delete body.photo;}
    console.log('TELEGRAM SIMULATION',body.text??body.caption??String(url).split('/').pop());
    return new Response(JSON.stringify({ok:true,result:{message_id:n}}));
  }
  return fetchOriginal(url,init);
}) as typeof fetch;
const store:any={kvGet:async(k:string)=>kv.get(k)??null,kvSet:async(k:string,v:string)=>kv.set(k,v),
 getJob:async(id:string)=>data.jobs.find((j:any)=>j.id===id),getApplication:async(id:string)=>data.apps.find((a:any)=>a.job_id===id),listDocuments:async()=>[]};
const {startForm,inspectForm,cancelForm,refillForm}=await import('../src/apply.ts');
const r=await startForm(store,'test',job,'test');
const report=await inspectForm('test');
writeFileSync(`${dir}/${slug}-flow.json`,JSON.stringify({r,report},null,2));
console.log('RESULT',JSON.stringify({r,ready:report?.ready,issues:report?.issues,fieldCount:report?.fields.length}));
if(process.argv[3]){
 const {chat}=await import('../src/agent.ts');
 await chat(store,'test',process.argv[3]);
 writeFileSync(`${dir}/${slug}-flow-after.json`,JSON.stringify(await inspectForm('test'),null,2));
}
cancelForm('test');process.exit(0);
