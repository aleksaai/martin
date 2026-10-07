// Firmen-Entdeckung lokal: `ANTHROPIC_API_KEY=… node --import tsx scripts/test-entdeckung.ts [themaIndex]` (schreibt in data/state.json)
import { createStore } from '../src/store.ts';
import { discoverCompanies } from '../src/entdeckung.ts';
const store = createStore(); await store.init();
const r = await discoverCompanies(store, Number(process.argv[2] ?? 0));
console.log(`Thema: ${r.theme}\nRegion: ${r.region}\n${r.proposed} vorgeschlagen, ${r.checked} geprüft, ${r.added.length} aufgenommen, ${r.rejected.length} verworfen`);
for (const c of r.added) console.log(`  + ${c.name} | ${c.ats.type} | ${c.ats.feed_url ?? c.ats.slug} | ${c.job_count} Stellen`);
console.log('  verworfen:', r.rejected.join(', '));
process.exit(0);
