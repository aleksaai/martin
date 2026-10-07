// Eigene Stelle per Link testen, Telegram auf Konsole: `ANTHROPIC_API_KEY=… node --import tsx scripts/test-own-job.ts "<Nachricht mit Link>"`
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  if (String(url).includes('api.telegram.org')) {
    const method = String(url).split('/').pop();
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    if (method === 'sendMessage' || method === 'editMessageText') console.log(`\n[Bot ${method}] ${body.text} ${body.reply_markup ? JSON.stringify(body.reply_markup) : ''}`);
    if (init?.body instanceof FormData) {
      const f = init.body.get('document') as File | null;
      console.log(`\n[Bot ${method}] Datei ${f?.name ?? '?'} (${f?.size ?? 0} B) ${init.body.get('caption') ?? ''} ${init.body.get('reply_markup') ?? ''}`);
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: Math.floor(Math.random() * 1e6) } }));
  }
  return realFetch(url, init);
}) as typeof fetch;
const { createStore } = await import('../src/store.ts');
const { chat } = await import('../src/agent.ts');
const store = createStore();
await store.init();
for (const q of process.argv.slice(2)) { console.log(`\n[Martin] ${q}`); await chat(store, 'test', q); }
const job = Object.values<any>(JSON.parse((await import('node:fs')).readFileSync(new URL('../data/state.json', import.meta.url), 'utf8')).jobs).find((j: any) => j.source === 'manuell');
console.log('\n[Store] manuelle Stelle:', job && { id: job.id, company: job.company, title: job.title, location: job.location, url: job.url, desc: job.description?.length });
process.exit(0);
