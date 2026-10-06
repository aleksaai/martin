// Chat-Assistent lokal testen, Telegram wird auf die Konsole umgeleitet: `node --import tsx scripts/test-chat.ts "<Titelteil der aktiven Stelle>" "Frage 1" "Frage 2" ...`
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  if (String(url).includes('api.telegram.org')) {
    const method = String(url).split('/').pop();
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    if (method === 'sendMessage' || method === 'editMessageText') console.log(`\n[Bot ${method}] ${body.text}`);
    if (init?.body instanceof FormData) console.log(`\n[Bot ${method}] ${init.body.get('caption') ?? ''} ${init.body.get('reply_markup') ?? ''}`);
    return new Response(JSON.stringify({ ok: true, result: { message_id: Math.floor(Math.random() * 1e6) } }));
  }
  return realFetch(url, init);
}) as typeof fetch;
const { createStore } = await import('../src/store.ts');
const { chat } = await import('../src/agent.ts');
const store = createStore();
await store.init();
const [needle, ...questions] = process.argv.slice(2);
const state = JSON.parse((await import('node:fs')).readFileSync(new URL('../data/state.json', import.meta.url), 'utf8'));
const job = Object.values<any>(state.jobs).find((j) => j.title.includes(needle));
await store.kvSet('active_job:test', job.id);
for (const q of questions) { console.log(`\n[Martin] ${q}`); await chat(store, 'test', q); }
process.exit(0);
