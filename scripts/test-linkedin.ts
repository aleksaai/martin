// LinkedIn-Gastsuche ohne Modell prüfen: `node --import tsx scripts/test-linkedin.ts`
import { listLinkedin, enrichLinkedin, parseSearch } from '../src/sources/linkedin.ts';
import { studentCheck } from '../src/filter.ts';
const t0 = Date.now();
const jobs = await listLinkedin([{ name: 'Erftstadt', lat: 50.7965, lon: 6.769, km: 50 }]);
console.log(`${jobs.length} Stellen in ${Math.round((Date.now() - t0) / 1000)} s`);
const students = jobs.filter((j) => !studentCheck(j));
console.log(`${students.length} Studentenrollen nach Vorfilter`);
for (const j of students.slice(0, 12)) console.log(`- ${j.title} | ${j.company} | ${j.locations[0]?.label ?? '-'} | ${j.published ?? ''}`);
const one = students[0];
if (one) { const e = await enrichLinkedin(one); console.log(`\nBeschreibung ${one.company}: ${e.description?.length ?? 0} Zeichen, Modus ${e.mode}\n${e.description?.slice(0, 300)}`); }
if (!parseSearch('<li>kaputt</li>').length) console.log('\nleere/kaputte Seite → 0 Stellen, kein Absturz');
