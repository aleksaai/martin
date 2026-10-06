// Original-Anzeige beim Arbeitgeber für BA-Stellen finden: `node --import tsx scripts/test-original.ts "<Titelteil>" ...`
import { readFileSync } from 'node:fs';
import { canFillForm } from '../src/bewerbung.ts';
import { findOriginalPosting } from '../src/llm.ts';
const state = JSON.parse(readFileSync(new URL('../data/state.json', import.meta.url), 'utf8'));
for (const needle of process.argv.slice(2)) {
  const job = Object.values<any>(state.jobs).find((j) => j.source === 'ba' && j.title.includes(needle));
  if (!job) { console.log('nicht gefunden:', needle); continue; }
  const url = await findOriginalPosting(job);
  console.log(`${job.title} | ${job.company}\n  → ${url ?? 'keine Original-Anzeige'}  Formular möglich: ${url ? canFillForm('ba', url) : false}`);
}
process.exit(0);
