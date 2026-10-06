// Anschreiben + PDF für eine Stelle aus data/state.json bauen, ohne Telegram: `node --import tsx scripts/test-letter.ts "<Titelteil>" <zielordner>`
import { readFileSync, writeFileSync } from 'node:fs';
import { letterPdf } from '../src/documents.ts';
import { writeLetter } from '../src/llm.ts';
const [needle, out] = process.argv.slice(2);
const state = JSON.parse(readFileSync(new URL('../data/state.json', import.meta.url), 'utf8'));
const job = Object.values<any>(state.jobs).find((j) => j.title.toLowerCase().includes(needle.toLowerCase()) && j.description);
if (!job) { console.log('Keine Stelle gefunden'); process.exit(1); }
console.log(job.title, '|', job.company);
const letter = await writeLetter(job);
console.log(`\n${letter}\n\n(${letter.split(/\s+/).length} Wörter)`);
writeFileSync(`${out}/letter.txt`, letter);
writeFileSync(`${out}/anschreiben.pdf`, await letterPdf(letter, job));
console.log('PDF:', `${out}/anschreiben.pdf`);
process.exit(0);
