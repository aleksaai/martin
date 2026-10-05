// Dienst auf Railway: Bot + Zeitplan. Sucht zu den Stunden in RUN_HOURS (Berliner Zeit).
import { cfg } from './config.ts';
import { runOnce, type RunReport } from './run.ts';
import { createStore } from './store.ts';
import { broadcast, notifyPending, startBot } from './telegram.ts';

const store = createStore();
await store.init();

let running: Promise<RunReport> | null = null;

async function run(reason: string): Promise<RunReport> {
  if (running) return running;
  running = (async () => {
    console.log(`Suchlauf (${reason}) startet`);
    const r = await runOnce(store);
    await store.kvSet('last_run', new Date().toISOString());
    const sent = await notifyPending(store);
    console.log(`Suchlauf fertig: ${r.fetched} abgerufen, ${r.fresh} neu, ${r.scored} bewertet, ${r.matches} Treffer, ${sent} gemeldet, ${r.errors.length} Fehler`);
    for (const e of r.errors) console.log('  Fehler:', e);
    return r;
  })().finally(() => { running = null; });
  return running;
}

function berlinSlot(): { hour: number; slot: string } {
  const parts = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { hour: Number(get('hour')), slot: `${get('year')}-${get('month')}-${get('day')} ${get('hour')}` };
}

async function tick() {
  const { hour, slot } = berlinSlot();
  if (!cfg.runHours.includes(hour)) return;
  if ((await store.kvGet('last_slot')) === slot) return;
  await store.kvSet('last_slot', slot);
  await run('Zeitplan').catch((e) => console.error('Suchlauf fehlgeschlagen:', e));
}

startBot(store, async () => {
  const r = await run('/suche');
  const sent = r.matches;
  return sent ? `Fertig: ${r.fresh} neue Stellen geprüft, ${sent} passen. Die Treffer stehen oben.` : `Fertig: ${r.fresh} neue Stellen geprüft, nichts Passendes dabei.`;
});

// Erster Lauf direkt nach dem Start, wenn noch nie gesucht wurde
if (!(await store.kvGet('last_run'))) {
  void run('erster Start').then((r) => broadcast(store, `Erster Suchlauf fertig: ${r.matches} passende Stellen gefunden.`)).catch((e) => console.error(e));
}
setInterval(() => void tick(), 5 * 60_000);
void tick();
console.log(`jobradar läuft. Suchzeiten: ${cfg.runHours.join(', ')} Uhr. Ablage: ${cfg.databaseUrl ? 'Postgres' : 'Datei'}.`);
