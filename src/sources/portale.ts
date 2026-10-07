// Juristische Jobportale ohne offizielle Schnittstelle: TalentRocket, LTO Karriere, beck-stellenmarkt, stellenanzeigen.de.
// Jede Quelle liefert RawJobs und scheitert für sich; der Lauf meldet den Fehler und macht mit den anderen weiter.
import { fetchJson, fetchText, sleep, stripHtml } from '../http.ts';
import type { Place } from '../prefs.ts';
import type { Store } from '../store.ts';
import type { RawJob } from '../types.ts';
import { BROWSER_UA } from './linkedin.ts';

const HEADERS = { 'User-Agent': BROWSER_UA, 'Accept-Language': 'de-DE,de;q=0.9' };
const decode = (s: string) => stripHtml(s).replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/\s+/g, ' ').trim();

// ---------- TalentRocket: serverseitig gerenderte Listen je Stellenart, Seiten bis kein rel="next" ----------
const TR_LISTS = ['werkstudent', 'wissenschaftlicher-mitarbeiter'];
const TR_PAGES = 6;

export function parseTalentrocket(html: string): RawJob[] {
  const out: RawJob[] = [];
  for (const card of html.split(/<app-job-card\b/).slice(1)) {
    const href = /href="(\/jura-jobs\/details\/[^"]+)"/.exec(card)?.[1];
    const title = /data-cy="job-title"[^>]*>([\s\S]*?)<\/div>/.exec(card)?.[1];
    if (!href || !title) continue;
    const location = /data-cy="location"[^>]*>([\s\S]*?)<\/div>/.exec(card)?.[1] ?? '';
    const remote = /data-cy="remote"[^>]*>([\s\S]*?)<\/div>/.exec(card)?.[1] ?? '';
    // Erstes alt ist das Hintergrundbild der Anzeige, das zweite das Arbeitgeber-Logo
    const alts = [...card.matchAll(/alt="([^"]+)"/g)].map((m) => decode(m[1])).filter((a) => !/background picture$/i.test(a));
    const remoteText = decode(remote);
    out.push({
      id: `talentrocket:${href.split('/').pop()}`,
      source: 'talentrocket',
      company: alts[0] || 'unbekannt',
      title: decode(title),
      locations: decode(location) ? [{ label: decode(location) }] : [],
      mode: /remote|homeoffice/i.test(remoteText) && !/vor ort/i.test(remoteText) ? 'remote' : /remote|homeoffice/i.test(remoteText) ? 'hybrid' : 'unbekannt',
      url: `https://www.talentrocket.de${href}`,
    });
  }
  return out;
}

export async function listTalentrocket(): Promise<RawJob[]> {
  const seen = new Map<string, RawJob>();
  for (const list of TR_LISTS) {
    for (let page = 1; page <= TR_PAGES; page++) {
      const html = await fetchText(`https://www.talentrocket.de/jura-jobs/${list}?page=${page}`, { headers: HEADERS });
      for (const j of parseTalentrocket(html)) seen.set(j.id, j);
      if (!/rel="next"/.test(html)) break;
      await sleep(800);
    }
  }
  return [...seen.values()];
}

// ---------- LTO Karriere: interne Such-API der Next.js-Seite (POST), Volltextsuche nach Relevanz ----------
const LTO_QUERIES: [string, number][] = [['werkstudent', 2], ['wissenschaftliche mitarbeit', 3], ['studentische hilfskraft', 1], ['wissenschaftlicher mitarbeiter', 2]];

interface LtoItem { id: number; slug: string; title: string; lastUpdated?: string; bundesweit?: boolean | null; employer?: { name?: string }; locations?: { city?: string; coordinates?: { lat: number; lon: number } }[]; workLocationTypes?: { label?: string }[] }

export async function listLto(): Promise<RawJob[]> {
  const seen = new Map<string, RawJob>();
  for (const [query, pages] of LTO_QUERIES) {
    for (let page = 1; page <= pages; page++) {
      const r = await fetchJson<{ items?: LtoItem[]; pageTotalFound?: number }>('https://www.lto.de/karriere/api/jobs/search', {
        method: 'POST',
        headers: { ...HEADERS, 'Content-Type': 'application/json', Referer: 'https://www.lto.de/karriere/stellenmarkt' },
        body: JSON.stringify({ page, limit: 50, sort: { relevance: 'desc' }, apiKey: 'development', query }),
      });
      for (const i of r.items ?? []) {
        const id = `lto:${i.id}`;
        if (seen.has(id)) continue;
        const remote = (i.workLocationTypes ?? []).some((w) => /remote/i.test(w.label ?? ''));
        seen.set(id, {
          id, source: 'lto', company: i.employer?.name?.trim() || 'unbekannt', title: decode(i.title),
          locations: (i.locations ?? []).filter((l) => l.city).map((l) => ({ label: l.city!, lat: l.coordinates?.lat, lon: l.coordinates?.lon })),
          mode: remote ? 'remote' : 'unbekannt',
          url: `https://www.lto.de/karriere/stellenmarkt/job/${i.id}-${i.slug}`,
          published: i.lastUpdated,
        });
      }
      if ((r.pageTotalFound ?? 1) <= page) break;
      await sleep(800);
    }
  }
  return [...seen.values()];
}

// ---------- stellenanzeigen.de: JSON-API der Suchseite, Umkreis um Köln (Orts-ID aus der Oberfläche) ----------
const SA_KOELN = 'M-DE-13668';
const SA_QUERIES = ['Werkstudent', 'studentische Hilfskraft', 'wissenschaftliche Mitarbeit'];
const SA_MAX = 100; // je Suchbegriff, 25 je Seite

interface SaAd { id: string; positionTitle?: string; companyName?: string; link?: string; originalStartDate?: string; regions?: { region?: string; latitude?: number; longitude?: number }[]; region?: string; geo?: { lat: number; lng: number }[] }

export async function listStellenanzeigen(places: Place[]): Promise<RawJob[]> {
  const seen = new Map<string, RawJob>();
  const radius = Math.min(Math.max(places[0]?.km ?? 50, 10), 100);
  for (const q of SA_QUERIES) {
    for (let offset = 0; offset < SA_MAX; offset += 25) {
      const params = new URLSearchParams({ limit: '25', offset: String(offset), locationIds: SA_KOELN, perimeterRadius: String(radius), sort: 'RelevanzHighscore', fulltext: q, onlyAdsOnlineForDays: '14', includeVariants: 'true', onlyTopJobs: 'false' });
      for (const b of ['Internal', 'Paid', 'Free']) params.append('backfillTypes', b);
      const r = await fetchJson<{ jobAdSearchResultModel?: { jobAds?: { jobAd: SaAd }[]; count?: number } }>(`https://www.stellenanzeigen.de/api/jobs/?${params}`, { headers: { ...HEADERS, Accept: 'application/json' } });
      const ads = r.jobAdSearchResultModel?.jobAds ?? [];
      for (const { jobAd: a } of ads) {
        const id = `stellenanzeigen:${a.id}`;
        if (seen.has(id) || !a.positionTitle || !a.link) continue;
        const locs = (a.regions ?? []).filter((x) => x.region).map((x) => ({ label: x.region!, lat: x.latitude, lon: x.longitude }));
        if (!locs.length && a.region) locs.push({ label: a.region, lat: a.geo?.[0]?.lat, lon: a.geo?.[0]?.lng });
        seen.set(id, { id, source: 'stellenanzeigen', company: a.companyName?.trim() || 'unbekannt', title: decode(a.positionTitle), locations: locs, mode: 'unbekannt', url: a.link, published: a.originalStartDate });
      }
      if (ads.length < 25 || offset + 25 >= (r.jobAdSearchResultModel?.count ?? 0)) break;
      await sleep(600);
    }
  }
  return [...seen.values()];
}

// ---------- beck-stellenmarkt: Bot-Prüfung einmal mit Chromium lösen, Cookie merken, danach normale Abrufe ----------
const BECK_QUERIES = ['Werkstudent', 'Student', 'wissenschaftliche Mitarbeit'];
const BECK_COOKIE_KEY = 'beck_cookie';

async function beckCookie(store: Store, fresh = false): Promise<string> {
  if (!fresh) {
    const cached = await store.kvGet(BECK_COOKIE_KEY);
    if (cached) return cached;
  }
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ userAgent: BROWSER_UA, locale: 'de-DE' });
    const page = await ctx.newPage();
    await page.goto('https://www.beck-stellenmarkt.de/jobs', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    for (let i = 0; i < 20; i++) {
      const cookies = await ctx.cookies('https://www.beck-stellenmarkt.de');
      if (cookies.some((c) => c.name === 'bot_verified')) {
        const value = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
        await store.kvSet(BECK_COOKIE_KEY, value);
        return value;
      }
      await page.waitForTimeout(500);
    }
    throw new Error('Bot-Prüfung nicht bestanden (kein bot_verified-Cookie)');
  } finally {
    await browser.close();
  }
}

export function parseBeck(html: string): RawJob[] {
  const out: RawJob[] = [];
  for (const art of html.split(/<article\b/).slice(1)) {
    const m = /<h2 class="node__title">\s*<a[^>]*href="(https:\/\/www\.beck-stellenmarkt\.de\/job\/[^"]+-(\d+))"[^>]*>([\s\S]*?)<\/a>/.exec(art);
    if (!m) continue;
    const company = /<div class="description">([\s\S]*?)<\/div>/.exec(art)?.[1] ?? '';
    const location = /<div class="location">([\s\S]*?)<\/div>/.exec(art)?.[1] ?? '';
    const date = /<div class="date">\s*(\d{2})\.(\d{2})\.(\d{4})/.exec(art);
    out.push({
      id: `beck:${m[2]}`, source: 'beck', company: decode(company) || 'unbekannt', title: decode(m[3]),
      locations: decode(location).split(',').map((s) => s.trim()).filter(Boolean).map((label) => ({ label })),
      mode: 'unbekannt', url: m[1], published: date ? `${date[3]}-${date[2]}-${date[1]}` : undefined,
    });
  }
  return out;
}

export async function listBeck(store: Store): Promise<RawJob[]> {
  let cookie = await beckCookie(store);
  const seen = new Map<string, RawJob>();
  const get = async (url: string) => {
    let html = await fetchText(url, { headers: { ...HEADERS, Cookie: cookie } });
    if (/botchallenge/.test(html)) {
      cookie = await beckCookie(store, true);
      html = await fetchText(url, { headers: { ...HEADERS, Cookie: cookie } });
      if (/botchallenge/.test(html)) throw new Error('Bot-Prüfung auch mit frischem Cookie nicht bestanden');
    }
    return html;
  };
  for (const q of BECK_QUERIES) {
    for (let page = 0; page < 3; page++) {
      const html = await get(`https://www.beck-stellenmarkt.de/jobs?search=${encodeURIComponent(q)}&page=${page}`);
      const jobs = parseBeck(html);
      for (const j of jobs) seen.set(j.id, j);
      if (jobs.length < 20) break;
      await sleep(800);
    }
  }
  return [...seen.values()];
}

/** LTO rendert die Anzeige clientseitig; ihr HTML steckt JSON-escaped im Next.js-Payload der Seite. */
export function ltoDescription(html: string): string {
  const decoded = html.replace(/\\u003c/g, '<').replace(/\\u003e/g, '>').replace(/\\u0026/g, '&').replace(/\\"/g, '"').replace(/\\n/g, '\n');
  // Kopf der Anzeige (Titel, Arbeitgeber, Ort) und danach der Anzeigentext; Nachrichtenteaser der Seite liegen davor
  const marker = decoded.indexOf('JobDetailHeader_JobDetailHeader');
  const start = marker > 0 ? decoded.indexOf('>', marker) + 1 : 0;
  const text = stripHtml(start > 0 ? decoded.slice(start, start + 60_000) : decoded);
  const cut = text.search(/Ähnliche Jobs|Weitere Jobs|Das könnte dich auch interessieren/);
  return (cut > 500 ? text.slice(0, cut) : text).trim();
}

/** Beschreibung von der Anzeigenseite nachholen (nur nach bestandenem Vorfilter). */
export async function enrichPortal(job: RawJob, store: Store): Promise<RawJob> {
  try {
    const headers: Record<string, string> = { ...HEADERS };
    if (job.source === 'beck') headers.Cookie = (await store.kvGet(BECK_COOKIE_KEY)) ?? '';
    const html = await fetchText(job.url, { headers });
    const text = job.source === 'lto' ? ltoDescription(html) : stripHtml(/<main\b[\s\S]*?<\/main>/.exec(html)?.[0] ?? html);
    return { ...job, description: text.slice(0, 12_000), mode: job.mode === 'unbekannt' && /\bremote\b|homeoffice|home office|mobiles arbeiten/i.test(text.slice(0, 6000)) ? 'hybrid' : job.mode };
  } catch {
    return job;
  }
}

export const PORTALS: { source: string; list: (store: Store, places: Place[]) => Promise<RawJob[]> }[] = [
  { source: 'talentrocket', list: () => listTalentrocket() },
  { source: 'lto', list: () => listLto() },
  { source: 'stellenanzeigen', list: (_s, places) => listStellenanzeigen(places) },
  { source: 'beck', list: (store) => listBeck(store) },
];
export const PORTAL_SOURCES = new Set(PORTALS.map((p) => p.source));
