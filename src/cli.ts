// Lokaler Probelauf ohne Telegram: `npm run once` (mit ANTHROPIC_API_KEY in der Umgebung).
import { runOnce } from './run.ts';
import { createStore } from './store.ts';

const store = createStore();
await store.init();
const r = await runOnce(store);
console.log('\nQuellen:', r.bySource);
console.log(`${r.fetched} abgerufen, ${r.fresh} neu, ${r.scored} bewertet, ${r.matches} Treffer`);
if (r.errors.length) console.log(`Fehler (${r.errors.length}):\n  ${r.errors.join('\n  ')}`);
const top = await store.pending(50);
console.log('\nTreffer:');
for (const j of top) console.log(`${j.score}/10  ${j.title} | ${j.company} | ${j.location}${j.distance_km !== null ? ` (${j.distance_km} km)` : ''} | ${j.mode}\n       ${j.reason}\n       ${j.url}`);
// Offene Verbindungen und Zeitgeber würden den Prozess sonst am Leben halten
process.exit(0);
