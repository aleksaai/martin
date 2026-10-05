// Anschreiben als PDF im Look von Martins Lebenslauf (Poppins, Name dünn + fett, graue Akzente).
import { readFileSync, existsSync } from 'node:fs';
import { withBrowser } from './browser.ts';

export const CONTACT = JSON.parse(readFileSync(new URL('../data/contact.json', import.meta.url), 'utf8'));

export function docPath(name: 'lebenslauf' | 'immatrikulation'): string | null {
  const p = new URL(`../data/docs/${name}.pdf`, import.meta.url).pathname;
  return existsSync(p) ? p : null;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function fileSafe(s: string): string {
  return s.normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '_').slice(0, 40);
}

export async function letterPdf(letter: string, job: { title: string; company: string }): Promise<Buffer> {
  const date = new Date().toLocaleDateString('de-DE', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'Europe/Berlin' });
  const paragraphs = letter.split(/\n\s*\n/).map((p) => `<p>${esc(p.trim()).replace(/\n/g, '<br>')}</p>`).join('');
  const html = `<!doctype html><html lang="de"><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;600;700&display=swap" rel="stylesheet">
<style>
  @page { size: A4; margin: 0; }
  body { margin: 0; font-family: 'Poppins', sans-serif; color: #2b2b2b; font-size: 10pt; line-height: 1.6; }
  .side { position: fixed; left: 0; top: 0; bottom: 0; width: 14mm; background: #efefef; }
  .page { padding: 20mm 22mm 18mm 32mm; }
  .name { font-size: 26pt; font-weight: 300; letter-spacing: .5px; margin: 0; }
  .name b { font-weight: 700; }
  .role { font-size: 10.5pt; font-weight: 300; text-transform: uppercase; letter-spacing: 1px; margin: 2mm 0 0; }
  .contact { margin-top: 5mm; padding-bottom: 4mm; border-bottom: 1px solid #c9c9c9; font-size: 8.5pt; color: #555; }
  .meta { display: flex; justify-content: space-between; margin: 12mm 0 10mm; }
  .to { font-size: 9.5pt; }
  .date { font-size: 9.5pt; color: #555; }
  .subject { font-weight: 600; margin-bottom: 6mm; }
  p { margin: 0 0 3.5mm; text-align: left; }
</style></head><body><div class="side"></div><div class="page">
  <h1 class="name">${esc(CONTACT.first_name.toUpperCase())} <b>${esc(CONTACT.last_name.toUpperCase())}</b></h1>
  <div class="role">${esc(CONTACT.title)}</div>
  <div class="contact">${esc(CONTACT.street)}, ${esc(CONTACT.zip)} ${esc(CONTACT.city)} &nbsp;·&nbsp; ${esc(CONTACT.phone)} &nbsp;·&nbsp; ${esc(CONTACT.email)}</div>
  <div class="meta"><div class="to">${esc(job.company)}</div><div class="date">${esc(CONTACT.city)}, ${esc(date)}</div></div>
  <div class="subject">Bewerbung als ${esc(job.title)}</div>
  ${paragraphs}
</div></body></html>`;
  return withBrowser(async (b) => {
    const page = await b.newPage();
    try {
      await page.setContent(html, { waitUntil: 'networkidle', timeout: 20_000 }).catch(() => page.setContent(html));
      return Buffer.from(await page.pdf({ format: 'A4', printBackground: true }));
    } finally {
      await page.close();
    }
  });
}
