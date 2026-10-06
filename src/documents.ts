// Anschreiben als PDF: Geschäftsbrief nach DIN 5008 mit Martins Logo, im Look seines Lebenslaufs.
import { readFileSync, existsSync } from 'node:fs';
import { withBrowser } from './browser.ts';

export const CONTACT = JSON.parse(readFileSync(new URL('../data/contact.json', import.meta.url), 'utf8'));


const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function fileSafe(s: string): string {
  return s.normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '_').slice(0, 40);
}

const LOGO = (() => {
  const p = new URL('../data/docs/logo.png', import.meta.url);
  return existsSync(p) ? `data:image/png;base64,${readFileSync(p).toString('base64')}` : '';
})();

/** Ort aus der Stellenangabe für das Anschriftfeld: "50668 Köln / Frankfurt" → "50668 Köln". Remote bleibt leer. */
function recipientPlace(location?: string | null): string {
  const first = (location ?? '').split(/\s*[\/|;]\s*/)[0].trim();
  return /remote|home ?office|deutschland|germany/i.test(first) ? '' : first.replace(/,\s*(DE|Deutschland|Germany).*$/i, '');
}

/**
 * Anschreiben als Geschäftsbrief nach DIN 5008, im Look von Martins Lebenslauf:
 * Logo + Name im Kopf, Rücksendezeile, Anschriftfeld, Ort/Datum, fette Betreffzeile, Text, Gruß, Anlagen.
 */
export async function letterPdf(letter: string, job: { title: string; company: string; location?: string | null }): Promise<Buffer> {
  const date = new Date().toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Berlin' });
  // Grußformel und Name setzt die Vorlage selbst, deshalb aus dem Modelltext entfernen
  // Erste Zeile "Betreff: ..." liefert das Modell mit, sonst aus dem Stellentitel
  const subjectMatch = letter.match(/^\s*Betreff:\s*(.+)$/im);
  const subject = subjectMatch ? subjectMatch[1].trim() : `Bewerbung als ${job.title}`;
  const nbsp = (t: string) => t.replace(/(§§?|Art\.|Abs\.|Nr\.) (\d)/g, '$1\u00a0$2').replace(/(\d) (ff?\.)/g, '$1\u00a0$2').replace(/(\d) (BGB|DSGVO|HGB|UWG)/g, '$1\u00a0$2');
  const parts = nbsp(letter.replace(/^\s*Betreff:.*$/im, '')).trim().split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const person = parts[0]?.match(/^Sehr geehrte[rs]? (Frau|Herr) ((?:Dr\. |Prof\. )*[^,]+),/);
  while (parts.length && /^(mit freundlichen grüßen|freundliche grüße|beste grüße|viele grüße|martin spalevic)/i.test(parts[parts.length - 1])) parts.pop();
  const body = parts.map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
  const place = recipientPlace(job.location);
  const C = CONTACT;
  const html = `<!doctype html><html lang="de"><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
  @page { size: A4; margin: 0; }
  :root { --navy: #0d1625; --ink: #2a2f38; --muted: #6b7280; --rule: #c9ccd2; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: 'Poppins', sans-serif; color: var(--ink); font-size: 10pt; line-height: 1.6; }
  .page { position: relative; width: 210mm; min-height: 297mm; padding: 12mm 20mm 12mm 25mm; }
  .band { position: absolute; left: 0; top: 0; bottom: 0; width: 7mm; background: #eeeff1; }
  header { display: flex; align-items: center; gap: 7mm; padding-bottom: 4mm; border-bottom: 1.2px solid var(--navy); }
  header img { height: 15mm; width: auto; }
  .who .name { font-size: 21pt; font-weight: 300; letter-spacing: .6px; color: var(--navy); line-height: 1.1; }
  .who .name b { font-weight: 700; }
  .who .role { font-size: 8.5pt; font-weight: 400; text-transform: uppercase; letter-spacing: 1.6px; color: var(--muted); margin-top: 1.5mm; }
  .contact { margin-left: auto; text-align: right; font-size: 8pt; line-height: 1.55; color: var(--muted); }
  .address { margin-top: 9mm; height: 27mm; }
  .return { font-size: 6.8pt; color: var(--muted); padding-bottom: 1mm; border-bottom: .5px solid var(--rule); display: inline-block; margin-bottom: 3mm; }
  .to { font-size: 10pt; line-height: 1.5; }
  .date { text-align: right; font-size: 9.5pt; color: var(--muted); margin-top: 2mm; }
  .subject { font-weight: 600; color: var(--navy); font-size: 10.5pt; margin: 6mm 0 5mm; }
  p { margin: 0 0 2.8mm; }
  .closing { margin-top: 4mm; }
  .closing .sig { margin-top: 7mm; font-weight: 500; color: var(--navy); }
  .enc { margin-top: 6mm; font-size: 8.5pt; color: var(--muted); }
  .enc b { font-weight: 600; color: var(--ink); }
</style></head><body><div class="page"><div class="band"></div>
  <header>
    ${LOGO ? `<img src="${LOGO}" alt="">` : ''}
    <div class="who">
      <div class="name">${esc(C.first_name.toUpperCase())} <b>${esc(C.last_name.toUpperCase())}</b></div>
      <div class="role">${esc(C.title)}</div>
    </div>
    <div class="contact">${esc(C.street)}<br>${esc(C.zip)} ${esc(C.city)}<br>${esc(C.phone)}<br>${esc(C.email)}</div>
  </header>
  <div class="address">
    <div class="return">${esc(`${C.first_name} ${C.last_name} · ${C.street} · ${C.zip} ${C.city}`)}</div>
    <div class="to">${esc(job.company)}${person ? `<br>z. Hd. ${esc(person[1])} ${esc(person[2])}` : ''}${place ? `<br>${esc(place)}` : ''}</div>
  </div>
  <div class="date">${esc(C.city)}, ${esc(date)}</div>
  <div class="subject">${esc(subject)}</div>
  ${body}
  <div class="closing">Mit freundlichen Grüßen<div class="sig">${esc(C.first_name)} ${esc(C.last_name)}</div></div>
  <div class="enc"><b>Anlage</b><br>Lebenslauf</div>
</div></body></html>`;
  return withBrowser(async (b) => {
    // A4 in CSS-Pixeln, sonst misst die Einpassung in Fensterbreite und der Text bricht anders um als im PDF
    const page = await b.newPage({ viewport: { width: 794, height: 1123 } });
    try {
      await page.setContent(html, { waitUntil: 'networkidle', timeout: 20_000 }).catch(() => page.setContent(html));
      await page.emulateMedia({ media: 'print' });
      // Auf eine A4-Seite einpassen: Text schrittweise kleiner, bis der Inhalt in 297 mm passt
      await page.evaluate(`(() => {
        const page = document.querySelector('.page');
        const limit = (297 / 25.4) * 96;
        let size = 10;
        while (page.scrollHeight > limit + 1 && size > 9.05) {
          size -= 0.2;
          document.body.style.fontSize = size + 'pt';
          document.body.style.lineHeight = size < 9.6 ? '1.52' : '1.6';
        }
        return { size, height: page.scrollHeight, limit };
      })()`).then((r) => { if ((r as any).height > (r as any).limit + 1) console.log('Anschreiben passt nicht ganz auf eine Seite', r); });
      return Buffer.from(await page.pdf({ format: 'A4', printBackground: true }));
    } finally {
      await page.close();
    }
  });
}
