// Neue Arbeitgeber im Umkreis von selbst finden: einmal pro Woche sucht das Modell per Websuche Kanzleien, Rechtsabteilungen,
// Legal-Tech- und Softwarefirmen mit Karriereseite, die noch nicht in der Liste stehen. Jede Kandidatin wird erst abgerufen;
// nur lesbare Seiten mit mindestens einer Stelle kommen in `extra_companies` und laufen ab dann in jedem Suchlauf mit.
import Anthropic from '@anthropic-ai/sdk';
import { cfg } from './config.ts';
import { companyFromUrl, extraCompanies, loadPrefs } from './prefs.ts';
import { loadCompanies } from './run.ts';
import { listCompany } from './sources/ats.ts';
import { listHtml } from './sources/html.ts';
import type { Store } from './store.ts';
import type { Company } from './types.ts';

const client = new Anthropic({ apiKey: cfg.anthropicKey });
const MAX_NEW = 8; // je Lauf, damit die Liste nicht in einer Woche verwildert
const MAX_CHECK = 25;
const THEMES = [
  'Wirtschaftskanzleien und mittelständische Rechtsanwaltskanzleien (Arbeitsrecht, Gesellschaftsrecht, IT-Recht, Datenschutz)',
  'Unternehmen mit eigener Rechtsabteilung oder Compliance-Abteilung (Konzerne, Mittelstand, Versicherer, Banken, Energieversorger)',
  'Legal-Tech-Firmen und Softwareunternehmen, die Werkstudenten in Legal, Compliance, Datenschutz oder Vertragsmanagement suchen',
  'Steuerberatungs- und Wirtschaftsprüfungsgesellschaften mit Rechtsberatung sowie Compliance- und Datenschutzberatungen',
  'Verbände, Kammern, Stiftungen und öffentliche Arbeitgeber mit juristischen Werkstudentenstellen',
];

const norm = (s: string) => s.toLowerCase().replace(/\(.*?\)|gmbh|ag\b|se\b|kg\b|mbb|partg|llp|rechtsanw[äa]lte|partnerschaft|&|und|\./g, '').replace(/[^a-zäöüß0-9]/g, '');
const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('Zeitüberschreitung')), ms))]);
}

export const THEME_COUNT = THEMES.length;

/** ISO-Woche, damit jede Woche ein anderes Thema dran ist. */
export function weekOfYear(d = new Date()): number {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  return Math.ceil(((t.getTime() - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86_400_000 + 1) / 7);
}

async function propose(theme: string, region: string, exclude: string[]): Promise<{ name: string; karriereseite: string }[]> {
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: `Thema: ${theme}\nRegion: ${region}\n\nSchon bekannt (nicht nochmal nennen):\n${exclude.join(', ')}` }];
  for (let i = 0; i < 6; i++) {
    const res = await client.messages.create({
      // Sonnet statt Haiku: braucht mehrere Suchrunden und Urteilsvermögen, läuft nur einmal pro Woche
      model: cfg.letterModel,
      max_tokens: 6000,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 14 } as never],
      system: `Du suchst Arbeitgeber für einen Jurastudenten (LL.B. Wirtschaftsrecht), der eine Werkstudentenstelle oder wissenschaftliche Mitarbeit im Raum der genannten Region sucht.
Finde per Websuche bis zu 15 Arbeitgeber zum Thema mit Sitz oder Standort in der Region, die noch nicht in der Liste stehen. Für jeden brauchst du die URL der Karriereseite oder Stellenliste (Seite mit den offenen Stellen, kein Jobportal wie Indeed/StepStone/LinkedIn, keine Startseite ohne Stellen). Lieber weniger Treffer mit echter Stellenseiten-URL als geratene Adressen. Suche in mehreren Runden (z.B. je Stadt, je Rechtsgebiet, „Werkstudent Recht <Stadt>“, „wissenschaftliche Mitarbeit Kanzlei <Stadt>“), öffne gefundene Firmenseiten und übernimm die tatsächliche Stellenseiten-URL.
Antworte am Ende nur mit JSON: {"firmen":[{"name":"…","karriereseite":"https://…"}]}`,
      messages,
    });
    messages.push({ role: 'assistant', content: res.content });
    if (res.stop_reason === 'pause_turn') continue;
    const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    if (process.env.DISCOVERY_DEBUG) console.log('Entdeckung Antwort:', res.stop_reason, res.content.map((b) => b.type).join(','), text.slice(-1500));
    const start = text.lastIndexOf('{"firmen"') >= 0 ? text.lastIndexOf('{"firmen"') : text.indexOf('{');
    const json = text.slice(start, text.lastIndexOf('}') + 1).replace(/^```(?:json)?|```$/g, '');
    try { return (JSON.parse(json).firmen ?? []).filter((f: any) => f?.name && /^https?:\/\//.test(f?.karriereseite ?? '')); }
    catch (e) { console.error('Entdeckung: Antwort nicht lesbar:', (e as Error).message, text.slice(-300)); return []; }
  }
  return [];
}

export interface DiscoveryReport { theme: string; region: string; proposed: number; checked: number; added: Company[]; rejected: string[] }

export async function discoverCompanies(store: Store, themeIndex = weekOfYear() % THEMES.length): Promise<DiscoveryReport> {
  const prefs = await loadPrefs(store);
  const region = ['Köln', 'Bonn', 'Düsseldorf', 'Aachen', 'Leverkusen', ...prefs.places.map((p) => p.name)].filter((v, i, a) => a.indexOf(v) === i).join(', ') + ' und Umgebung (Rheinland)';
  const known = [...loadCompanies(), ...(await extraCompanies(store))];
  const rejected: string[] = JSON.parse((await store.kvGet('discovery_rejected')) ?? '[]');
  const knownNames = new Set([...known.map((c) => norm(c.name)), ...rejected.map(norm)]);
  const knownHosts = new Set(known.map((c) => host(c.ats.feed_url ?? (c as any).careers_url ?? '')).filter(Boolean));
  const theme = THEMES[themeIndex];
  // Nur die regionalen Namen als Ausschlussliste, sonst wird der Prompt riesig
  const regional = known.filter((c) => /köln|bonn|düsseldorf|aachen|leverkusen|remote/i.test(c.city ?? '')).map((c) => c.name);
  const proposed = await propose(theme, region, regional.slice(0, 150));
  const report: DiscoveryReport = { theme, region, proposed: proposed.length, checked: 0, added: [], rejected: [] };
  const extra = await extraCompanies(store);

  for (const f of proposed.slice(0, MAX_CHECK)) {
    if (report.added.length >= MAX_NEW) break;
    const h = host(f.karriereseite);
    if (!h || knownNames.has(norm(f.name)) || knownHosts.has(h) || /indeed|stepstone|linkedin|xing|kimeta|glassdoor|arbeitsagentur/i.test(h)) continue;
    report.checked++;
    let company: Company;
    try { company = companyFromUrl(f.name, f.karriereseite); } catch { report.rejected.push(f.name); continue; }
    try {
      const jobs = await withTimeout(company.ats.type === 'html' ? listHtml(company, store) : listCompany(company), 45_000);
      if (!jobs.length) { report.rejected.push(f.name); continue; }
      company.city = 'entdeckt';
      company.discovered = new Date().toISOString().slice(0, 10);
      company.job_count = jobs.length;
      extra.push(company);
      knownNames.add(norm(f.name)); knownHosts.add(h);
      report.added.push(company);
    } catch {
      report.rejected.push(f.name);
    }
  }
  await store.kvSet('extra_companies', JSON.stringify(extra));
  await store.kvSet('discovery_rejected', JSON.stringify([...new Set([...rejected, ...report.rejected])].slice(-300)));
  await store.kvSet('discovery_last', new Date().toISOString());
  return report;
}

/** Einmal pro Woche fällig (frühestens nach 6 Tagen), abschaltbar mit DISCOVERY=off. */
export async function discoveryDue(store: Store): Promise<boolean> {
  if ((process.env.DISCOVERY ?? 'on') === 'off') return false;
  const last = await store.kvGet('discovery_last');
  return !last || Date.now() - new Date(last).getTime() > 6 * 86_400_000;
}
