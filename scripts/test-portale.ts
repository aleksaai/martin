// Die vier Jobportale ohne Modell prüfen: `node --import tsx scripts/test-portale.ts`
import { createStore } from '../src/store.ts';
import { studentCheck } from '../src/filter.ts';
import { enrichPortal, PORTALS } from '../src/sources/portale.ts';
const store = createStore(); await store.init();
const places = [{ name: 'Erftstadt', lat: 50.7965, lon: 6.769, km: 50 }];
for (const p of PORTALS) {
  const t0 = Date.now();
  try {
    const jobs = await p.list(store, places);
    const stud = jobs.filter((j) => !studentCheck(j));
    console.log(`\n== ${p.source}: ${jobs.length} Stellen, ${stud.length} Studentenrollen, ${Math.round((Date.now() - t0) / 1000)} s`);
    for (const j of stud.slice(0, 6)) console.log(`  - ${j.title} | ${j.company} | ${j.locations.map((l) => l.label).join('/') || '-'} | ${j.mode} | ${j.published ?? ''}`);
    if (stud[0]) { const e = await enrichPortal(stud[0], store); console.log(`  Beschreibung ${e.company}: ${e.description?.length ?? 0} Zeichen → ${e.description?.replace(/\s+/g, ' ').slice(0, 160)}`); }
  } catch (e) { console.log(`\n== ${p.source}: FEHLER ${(e as Error).message}`); }
}
process.exit(0);
