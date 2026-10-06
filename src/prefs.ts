// Sucheinstellungen, die Martin im Chat ändern kann: Umkreis, zusätzliche Orte, Themen ausschließen/bevorzugen, eigene Firmen.
// Liegen in der Datenbank (kv), gelten ab dem nächsten Suchlauf. Grundwerte aus den Railway-Variablen.
import { cfg } from './config.ts';
import type { Store } from './store.ts';
import type { Company } from './types.ts';

export interface Place { name: string; lat: number; lon: number; km: number }
export interface SearchPrefs { maxKm: number; places: Place[]; exclude: string[]; focus: string[] }

export async function loadPrefs(store: Store): Promise<SearchPrefs> {
  const raw = await store.kvGet('search_prefs');
  const p = raw ? JSON.parse(raw) : {};
  return { maxKm: p.maxKm ?? cfg.maxKm, places: p.places ?? [], exclude: p.exclude ?? [], focus: p.focus ?? [] };
}

export async function savePrefs(store: Store, p: SearchPrefs) {
  await store.kvSet('search_prefs', JSON.stringify(p));
}

/** Alle Suchmittelpunkte: Wohnort plus von Martin hinzugefügte Orte, jeweils mit eigenem Umkreis. */
export function origins(p: SearchPrefs): Place[] {
  return [{ name: 'Erftstadt', ...cfg.home, km: p.maxKm }, ...p.places];
}

/** Für die Stellenbewertung: Themenwünsche als Regel. */
export function prefsForScoring(p: SearchPrefs): string {
  return [
    p.exclude.length ? `Martin will KEINE Stellen zu: ${p.exclude.join(', ')}. Solche Stellen bekommen höchstens score 3.` : '',
    p.focus.length ? `Martin will bevorzugt: ${p.focus.join(', ')}. Passende Stellen eher hoch bewerten.` : '',
  ].filter(Boolean).join('\n');
}

export function prefsText(p: SearchPrefs, extra: Company[]): string {
  return [
    `Vor Ort/hybrid: bis ${p.maxKm} km um Erftstadt${p.places.map((x) => `, bis ${x.km} km um ${x.name}`).join('')}. Remote: ganz Deutschland.`,
    `Ausgeschlossen: ${p.exclude.join(', ') || 'nichts'}. Bevorzugt: ${p.focus.join(', ') || 'nichts Besonderes'}.`,
    `Eigene Firmen zusätzlich zu den 245 Standardfirmen: ${extra.map((c) => c.name).join(', ') || 'keine'}.`,
  ].join('\n');
}

export async function extraCompanies(store: Store): Promise<Company[]> {
  return JSON.parse((await store.kvGet('extra_companies')) ?? '[]');
}

/** Bewerbermanagement-System an der URL erkennen, sonst als Karriereseite (html) lesen. */
export function companyFromUrl(name: string, url: string): Company {
  const u = new URL(url);
  const h = u.hostname;
  const first = u.pathname.split('/').filter(Boolean)[0] ?? '';
  let m: RegExpMatchArray | null;
  if ((m = h.match(/^([^.]+)\.jobs\.personio\.(de|com)$/))) return { name, category: 'eigene', ats: { type: 'personio', slug: m[1] } };
  if (/greenhouse\.io$/.test(h) && first) return { name, category: 'eigene', ats: { type: 'greenhouse', slug: first } };
  if (h === 'jobs.lever.co' && first) return { name, category: 'eigene', ats: { type: 'lever', slug: first } };
  if (h === 'jobs.eu.lever.co' && first) return { name, category: 'eigene', ats: { type: 'lever_eu', slug: first } };
  if ((m = h.match(/^([^.]+)\.recruitee\.com$/))) return { name, category: 'eigene', ats: { type: 'recruitee', slug: m[1] } };
  if (h === 'jobs.ashbyhq.com' && first) return { name, category: 'eigene', ats: { type: 'ashby', slug: first } };
  if ((m = h.match(/^([^.]+)\.wd\d+\.myworkdayjobs\.com$/))) {
    // https://<tenant>.wd3.myworkdayjobs.com/<locale?>/<site>
    const parts = u.pathname.split('/').filter(Boolean).filter((x) => !/^[a-z]{2}-[A-Z]{2}$/.test(x));
    if (parts[0]) return { name, category: 'eigene', ats: { type: 'workday', host: h, slug: m[1], site: parts[0] } };
  }
  if ((m = h.match(/^([^.]+)\.teamtailor\.com$/))) return { name, category: 'eigene', ats: { type: 'teamtailor', slug: m[1], feed_url: `https://${h}/jobs.rss` } };
  return { name, category: 'eigene', ats: { type: 'html', feed_url: url } };
}
