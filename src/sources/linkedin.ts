// LinkedIn-Stellen über den Gastzugang (ohne Konto, ohne Login). Keine offizielle Schnittstelle: LinkedIn kann den Weg
// jederzeit ändern oder drosseln. Dann scheitert nur diese Quelle, der Lauf meldet es und alles andere läuft weiter.
import { fetchText, sleep, stripHtml } from '../http.ts';
import type { Place } from '../prefs.ts';
import type { RawJob } from '../types.ts';

const SEARCH = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';
const POSTING = 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/';
// Ohne Browser-Kennung liefert LinkedIn eine leere Hülle
export const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const HEADERS = { 'User-Agent': BROWSER_UA, Accept: 'text/html' };

// Um Köln bzw. Martins Zusatzorte; das Sieben machen Vorfilter und Modell
const LOCAL_QUERIES = ['Werkstudent Legal', 'Werkstudent Recht', 'Werkstudent Compliance', 'Werkstudent Datenschutz', 'Werkstudent Vertragsmanagement', 'Werkstudent Rechtsabteilung', 'Wissenschaftliche Mitarbeit Kanzlei', 'Working Student Legal'];
// Bundesweit nur Remote-Stellen (f_WT=2) mit Rechtsbezug
const REMOTE_QUERIES = ['Werkstudent Legal', 'Werkstudent Recht', 'Werkstudent Compliance', 'Werkstudent Datenschutz'];
const PAGES = 3; // je 10 Treffer
const LAST_DAYS = 7; // der Lauf kommt dreimal täglich, älteres ist längst gesehen

function decode(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
}

/** LinkedIn-Link (jobs/view/…-4461782623 oder currentJobId=…) → Gast-Endpunkt derselben Anzeige. */
export function postingUrl(url: string): string {
  const li = /linkedin\.com\/.*?(?:jobs\/view\/(?:[^/?]*-)?|currentJobId=)(\d{6,})/i.exec(url);
  return li ? `${POSTING}${li[1]}` : url;
}

/** Text einer Anzeige; für LinkedIn über den Gastzugang, sonst die Seite selbst mit Browser-Kennung. */
export async function fetchPosting(url: string): Promise<string> {
  const html = await fetchText(postingUrl(url), { headers: HEADERS }, 25_000);
  return stripHtml(html).slice(0, 12_000);
}

/** Suchergebnis-Karten einer Gastsuche in RawJobs übersetzen. */
export function parseSearch(html: string): RawJob[] {
  const out: RawJob[] = [];
  for (const card of html.split(/<li>/).slice(1)) {
    const id = /data-entity-urn="urn:li:jobPosting:(\d+)"/.exec(card)?.[1];
    const title = /base-search-card__title[^>]*>([\s\S]*?)<\/h3>/.exec(card)?.[1];
    if (!id || !title) continue;
    const company = /base-search-card__subtitle[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/.exec(card)?.[1] ?? /base-search-card__subtitle[^>]*>([\s\S]*?)<\/h4>/.exec(card)?.[1] ?? '';
    const location = /job-search-card__location[^>]*>([\s\S]*?)<\/span>/.exec(card)?.[1] ?? '';
    const published = /<time[^>]*datetime="([^"]+)"/.exec(card)?.[1];
    // „Cologne, North Rhine-Westphalia, Germany“ → die Stadt reicht für die Ortsprüfung; Nominatim scheitert am englischen Rest
    const city = decode(location).split(',')[0].trim();
    out.push({
      id: `linkedin:${id}`,
      source: 'linkedin',
      company: decode(stripHtml(company)) || 'unbekannt',
      title: decode(stripHtml(title)),
      locations: city ? [{ label: city }] : [],
      mode: 'unbekannt',
      url: `https://www.linkedin.com/jobs/view/${id}`,
      published,
    });
  }
  return out;
}

async function search(params: Record<string, string>): Promise<RawJob[]> {
  const out: RawJob[] = [];
  for (let page = 0; page < PAGES; page++) {
    const q = new URLSearchParams({ ...params, f_TPR: `r${LAST_DAYS * 86_400}`, start: String(page * 10) });
    let html: string;
    try {
      html = await fetchText(`${SEARCH}?${q}`, { headers: HEADERS }, 25_000);
    } catch (e) {
      // Leere Seite am Ende der Ergebnisliste kommt als 400; alles andere ist ein echter Fehler
      if (/\b400\b/.test((e as Error).message)) break;
      throw e;
    }
    const jobs = parseSearch(html);
    out.push(...jobs);
    if (jobs.length < 10) break;
    await sleep(1000);
  }
  return out;
}

export async function listLinkedin(places: Place[]): Promise<RawJob[]> {
  const seen = new Map<string, RawJob>();
  const add = (jobs: RawJob[]) => { for (const j of jobs) if (!seen.has(j.id)) seen.set(j.id, j); };
  for (const was of LOCAL_QUERIES) {
    for (const p of places) {
      add(await search({ keywords: was, location: `${p.name}, Deutschland`, distance: String(Math.min(Math.max(p.km, 10), 100)) }));
      await sleep(1000);
    }
  }
  for (const was of REMOTE_QUERIES) {
    add(await search({ keywords: was, location: 'Deutschland', f_WT: '2' }));
    await sleep(1000);
  }
  return [...seen.values()];
}

/** Beschreibung nachholen (nur für Stellen, die den Vorfilter bestanden haben). */
export async function enrichLinkedin(job: RawJob): Promise<RawJob> {
  try {
    const html = await fetchText(postingUrl(job.url), { headers: HEADERS }, 25_000);
    const text = stripHtml(html);
    const mode: RawJob['mode'] = /\bremote\b|homeoffice|home office/i.test(job.title) ? 'remote' : /hybrid/i.test(`${job.title} ${text.slice(0, 3000)}`) ? 'hybrid' : job.mode;
    return { ...job, description: text.slice(0, 12_000), mode };
  } catch {
    return job;
  }
}
