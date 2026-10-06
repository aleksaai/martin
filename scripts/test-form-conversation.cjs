// Offline regression: real conversation orchestration with simulated browser, model and Telegram.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function load(file, imports, suffix = '') {
  const source = fs.readFileSync(file, 'utf8').replaceAll('import.meta.url', JSON.stringify('file:///tmp/test.ts')) + suffix;
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, require: n => imports[n] ?? {}, console, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {}, URL, process, Buffer });
  return exports;
}
(async () => {
  const kv = new Map();
  const store = { kvGet: async k => kv.get(k), kvSet: async (k,v) => kv.set(k,v), getApplication: async () => null, getJob: async id => ({ id, company: id, title: 'Werkstudent', description: '' }) };
  let messages = [], sequence = 0, questions = ['Ab wann kannst du anfangen?', 'Wie viele Stunden pro Woche möchtest du arbeiten?', 'An welchen Tagen kannst du arbeiten?'];
  let planned = '';
  const tg = async (method, body) => { messages.push({method, ...body}); return { message_id: ++sequence }; };
  class SDK {}
  const page = { url: () => 'https://example.com/apply', locator: () => ({ count: async () => 0 }) };
  const app = load('src/apply.ts', {
    'node:fs': {mkdtempSync:()=>'/tmp/test'}, 'node:os':{tmpdir:()=>'/tmp'}, 'node:path':require('node:path'), './uploads.ts':{materialize:async()=>({})}, './browser.ts':{getBrowser:async()=>({newContext:async()=>({newPage:async()=>page,close:async()=>{}})})}, '@anthropic-ai/sdk': SDK, './config.ts': { cfg: {} }, './tg.ts': {tg, esc: s => s, button: (text, callback_data) => ({text, callback_data})},
  }, `
exports.hooks = (h) => { openForm = async () => {}; collectFields = h.collect; hasForm = async () => true; planFill = h.plan; applyPlan = async () => ['📎 lebenslauf', '📎 anschreiben']; screenshot = h.shot; };
exports.sessions = sessions; exports.report = fillAndReport;
`);
  app.hooks({collect: async () => [{ id: 'f0' }], plan: async (j,f,l,extra) => { planned = extra; return {fill:[],files:[],check:[],consent:[],offen: questions}; }, shot: async (s,text,markup) => tg('photo', {text, markup})});
  const session = { job:{id:'REWE',company:'REWE'}, chatId:'martin', ref:'1', page, context:{close:async()=>{}}, plan:{offen:[]}, extra:'', files:{}, timer:1 };
  app.sessions.set('1', session);
  kv.set('active_job:martin','REWE'); kv.set('ref:1','REWE');
  await app.report(store,session);
  assert.match(messages.at(-1).text,/Ab wann/);
  assert.match(messages.at(-1).text,/Wie viele Stunden/);
  assert.doesNotMatch(messages.at(-1).text,/An welchen Tagen/);
  assert.equal(messages.at(-1).reply_markup.force_reply,true);
  assert.equal(kv.get(`form_msg:martin:${sequence}`),'1');
  assert.match(messages[0].markup.inline_keyboard[1][0].text,/neu ausfüllen/);
  questions = ['An welchen Tagen kannst du arbeiten?'];
  await app.refillForm(store,'martin','Ab November, 20 Stunden pro Woche');
  assert.match(planned,/Ab November, 20 Stunden/);
  assert.match(messages.at(-1).text,/An welchen Tagen/);
  assert.doesNotMatch(messages.at(-1).text,/Ab wann/);
  assert.match(JSON.parse(kv.get('form_draft:martin:REWE')).extra,/Ab November/);
  kv.set('active_job:martin','Andere Firma');
  assert.equal(await app.refillForm(store,'martin','Dienstags'),null);
  assert.equal(app.activeForm('martin','Andere Firma'),null);
  app.sessions.clear();
  assert.equal(await app.refillForm(store,'martin','Mittwochs'),null);
  assert.match(JSON.parse(kv.get('form_draft:martin:REWE')).extra,/Ab November/);
  await app.startForm(store,'martin',{id:'REWE',company:'REWE',url:'https://example.com'},'2','Montag bis Mittwoch');
  assert.match(planned,/Ab November/); assert.match(planned,/Montag bis Mittwoch/);
  app.sessions.clear();
  // Chat reply to an old form restores the correct application inside its queue;
  // expired form tool falls back to reopening with the natural-language answer.
  let turns=0, reopened;
  class ChatSDK { messages = { create: async request => {
    if (turns++ === 0) {
      assert.match(request.system,/REWE/); assert.match(request.system,/Ab November/);
      return {stop_reason:'tool_use',content:[{type:'tool_use',id:'t1',name:'formular_ergaenzen',input:{angaben:'Montag bis Mittwoch'}}]};
    }
    return {stop_reason:'end_turn',content:[{type:'text',text:'[STILL]'}]};
  }} }
  const agent = load('src/agent.ts', {
    '@anthropic-ai/sdk':ChatSDK, './config.ts':{cfg:{}}, './llm.ts':{PROFILE:''}, './tg.ts':{tg}, './uploads.ts':{documentList:async()=>''},
    './apply.ts':{activeForm:()=>null,refillForm:async()=>null,startForm:async (s,c,j,r,extra)=>{reopened={j,extra};return {ok:true,offen:['Gehalt?']};}},
    './telegram.ts':{shortRef:async()=> '2'},
  });
  const questionId=sequence; kv.set(`form_msg:martin:${questionId}`,'1');
  await agent.chat(store,'martin','Montag bis Mittwoch',500,false,questionId);
  assert.equal(kv.get('active_job:martin'),'REWE');
  assert.equal(reopened.j.id,'REWE'); assert.equal(reopened.extra,'Montag bis Mittwoch');
  console.log('PASS: direct questions, partial answers, saved draft, application isolation, reply routing, expired-session recovery. No external calls.');
})().catch(e=>{console.error(e);process.exitCode=1;});
