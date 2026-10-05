// Prüft alle Firmen-Feeds ohne Modell: welche antworten, wie viele Studentenstellen. `node --import tsx scripts/check-feeds.ts`
import { loadCompanies } from '../src/run.ts';
import { listCompany } from '../src/sources/ats.ts';
import { studentCheck } from '../src/filter.ts';
const cs = loadCompanies().filter((c) => c.ats.type !== 'html');
const byType: Record<string, { ok: number; fail: number; jobs: number; student: number }> = {};
const fails: string[] = [];
for (let i = 0; i < cs.length; i += 5) {
  await Promise.all(cs.slice(i, i + 5).map(async (c) => {
    const t = (byType[c.ats.type] ??= { ok: 0, fail: 0, jobs: 0, student: 0 });
    try { const t0 = Date.now(); const l = await Promise.race([listCompany(c), new Promise<never>((_, r) => setTimeout(() => r(new Error('Timeout 60s')), 60_000))]); if (Date.now() - t0 > 15000) console.log('LANGSAM', c.name, c.ats.type, Date.now() - t0); t.ok++; t.jobs += l.length; const st = l.filter((j) => !studentCheck(j)); t.student += st.length; for (const j of st) console.log('  ', c.name, '|', j.title, '|', j.locations.map((x) => x.label).join('/'), '|', j.mode); }
    catch (e) { t.fail++; fails.push(`${c.name} (${c.ats.type}): ${(e as Error).message.slice(0, 100)}`); }
  }));
}
console.log(byType); console.log(fails.join('\n'));
