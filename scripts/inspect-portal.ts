// Local diagnostic. No Telegram calls and no application submission.
import { readFileSync, writeFileSync } from 'node:fs';
const dir = process.env.MARTIN_TEST_DIR!;
Object.assign(process.env, JSON.parse(readFileSync(`${dir}/runtime.json`, 'utf8')));
const data = JSON.parse(readFileSync(`${dir}/snapshot.json`, 'utf8'));
const kv = new Map<string,string>(data.kv.map((r:any)=>[r.key,r.value]));
const { createFormContext } = await import('../src/browser.ts');
const { getCredential } = await import('../src/vault.ts');
const context = await createFormContext({locale:'de-DE',viewport:{width:1280,height:900}});
const page = await context.newPage();
const ey = process.argv[2] === 'ey';
const url = ey ? 'https://career5.successfactors.eu/career?company=EYHRISPRD1&lang=en_GB&career_job_req_id=1620253&career_ns=job_application' : 'https://karriere.rewe-group.com/konzernzentrale/content/apply/?locale=de_DE&extJobId=975196-de_DE';
await page.goto(url, {waitUntil:'domcontentloaded'});await page.waitForTimeout(5000);
if(ey){
const cred=await getCredential({kvGet:async(k:string)=>kv.get(k)??null} as any,'career5.successfactors.eu?company=EYHRISPRD1');
console.log('credentials available:',!!cred);
if(cred && await page.locator('input[type=password]:visible').count()){
await page.locator('input[type=text]:visible,input[type=email]:visible').first().fill(cred.username);
await page.locator('input[type=password]:visible').first().fill(cred.password);
await page.locator('input[type=password]:visible').first().press('Enter');await page.waitForTimeout(7000);
}}
for (const frame of page.frames()) {
  const reject = frame.getByRole('button', {name:/^Reject All Cookies$|^Alle ablehnen$/i});
  if(await reject.count()) await reject.first().click().catch(()=>{});
}
if(ey){
  await page.getByRole('button',{name:'Expand all sections',exact:true}).click();
  await page.waitForTimeout(1500);
  writeFileSync(`${dir}/ey-expanded.html`,await page.content());
  writeFileSync(`${dir}/ey-expanded-text.txt`,await page.locator('body').innerText());
}
const { uploadPortalDocuments } = await import('../src/form-portals.ts');
const { letterPdf } = await import('../src/documents.ts');
const job = data.jobs.find((j:any)=>ey ? j.company.includes('Young') : j.company.includes('REWE'));
const letter = data.apps.find((a:any)=>a.job_id===job.id)?.letter;
const letterPath = `${dir}/Anschreiben_Martin_Spalevic.pdf`;
writeFileSync(letterPath, await letterPdf(letter,job));
await uploadPortalDocuments(page, {lebenslauf:[new URL('../data/docs/lebenslauf.pdf',import.meta.url).pathname],anschreiben:[letterPath]});
console.log('UPLOAD VERIFIED');
console.log('URL:',page.url());
writeFileSync(`${dir}/${ey?'ey':'rewe'}-shadow.json`,JSON.stringify(await page.evaluate(`(() => {const roots=[document];let out=[]; for(let i=0;i<roots.length;i++){roots[i].querySelectorAll('*').forEach(e=>{if(e.shadowRoot){roots.push(e.shadowRoot);out.push({host:e.outerHTML.slice(0,200),html:e.shadowRoot.innerHTML});}});}return out;})()`)));
writeFileSync(`${dir}/${ey?'ey':'rewe'}-inspect.html`,await page.content());
for(const [i,f] of page.frames().entries()) writeFileSync(`${dir}/${ey?'ey':'rewe'}-frame-${i}.html`,await f.content());
writeFileSync(`${dir}/${ey?'ey':'rewe'}-text.txt`,await page.locator('body').innerText());
await page.screenshot({path:`${dir}/${ey?'ey':'rewe'}-inspect.png`,fullPage:true});
console.log((await page.locator('body').innerText()).slice(0,16000));
console.log('UPLOAD ELEMENTS',JSON.stringify(await page.locator('input[type=file],button,a,[role=button]').evaluateAll(es=>es.filter(e=>/upload|attach|cv|resume|document|cover letter|expand/i.test(e.textContent??'')||e.getAttribute('type')==='file').map(e=>e.outerHTML.slice(0,1400))).catch(()=>[])));
await context.close();process.exit(0);
