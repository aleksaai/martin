// Formular-Trockenlauf an einer echten Stelle: `node --import tsx scripts/test-form.ts <firmenname> <zielordner>`. Schickt NIE ab.
import { readFileSync } from 'node:fs';
import { dryRunForm } from '../src/apply.ts';
import { listCompany } from '../src/sources/ats.ts';
import { studentCheck } from '../src/filter.ts';
import type { Company, StoredJob } from '../src/types.ts';
const [name, out] = process.argv.slice(2);
const companies = JSON.parse(readFileSync(new URL('../data/companies.json', import.meta.url), 'utf8')) as Company[];
const c = companies.find((x) => x.name === name)!;
const jobs = await listCompany(c);
const raw = jobs.find((j) => !studentCheck(j)) ?? jobs[0];
console.log('Stelle:', raw.title, '|', raw.url);
const job: StoredJob = { id: raw.id, source: raw.source, company: raw.company, title: raw.title, location: '', distance_km: null, mode: raw.mode, url: raw.url, description: raw.description ?? null, status: 'match', skip_reason: null, score: 8, reason: '', first_seen: '', notified_at: null, feedback: null };
const letter = readFileSync(new URL('../data/letters/vestlane.txt', import.meta.url), 'utf8');
const r = await dryRunForm(job, letter, `${out}/form-${c.ats.type}.png`);
console.log(`Felder: ${r.fields}\nAusgefüllt: ${r.done.join(', ')}\nOffen: ${r.plan.offen.join(', ')}\nEinwilligungen: ${r.plan.consent.length}`);
process.exit(0);
