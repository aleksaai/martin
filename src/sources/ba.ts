// Jobbörse der Bundesagentur für Arbeit. Öffentlicher Schlüssel, keine Anmeldung.
// Liste über v6, Details (Beschreibung, Homeoffice) nur über v4 mit base64-Referenznummer.
import { fetchJson, sleep } from '../http.ts';
import type { RawJob } from '../types.ts';
import type { Place } from '../prefs.ts';

const BASE = 'https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc';
const HEADERS = { 'X-API-Key': 'jobboerse-jobsuche' };

// Umkreissuche um Erftstadt: breit, das Sieben machen Filter und Modell.
const LOCAL_QUERIES = [
  'Werkstudent',
  'studentische Hilfskraft',
  'studentischer Mitarbeiter',
  'studentische Mitarbeiterin',
  'wissenschaftlicher Mitarbeiter Kanzlei',
  'Working Student',
];
// Bundesweit nur mit Rechtsbezug, daraus zählen am Ende nur Remote-Stellen.
const REMOTE_QUERIES = [
  'Werkstudent Recht',
  'Werkstudent Legal',
  'Werkstudent Compliance',
  'Werkstudent Datenschutz',
  'Werkstudent Vertrag',
  'Werkstudent Rechtsabteilung',
  'Working Student Legal',
  'studentische Hilfskraft Kanzlei',
];

interface BaItem {
  referenznummer: string;
  stellenangebotsTitel?: string;
  titel?: string;
  firma?: string;
  stellenlokationen?: { adresse?: { ort?: string; plz?: string }; breite?: number; laenge?: number }[];
  datumErsteVeroeffentlichung?: string;
}

async function search(params: Record<string, string>): Promise<BaItem[]> {
  const out: BaItem[] = [];
  for (let page = 1; page <= 5; page++) {
    const q = new URLSearchParams({ ...params, size: '100', page: String(page), veroeffentlichtseit: '30' });
    const res = await fetchJson<{ ergebnisliste?: BaItem[]; maxErgebnisse?: number }>(`${BASE}/v6/jobs?${q}`, { headers: HEADERS });
    const items = res.ergebnisliste ?? [];
    out.push(...items);
    if (items.length < 100) break;
    await sleep(300);
  }
  return out;
}

export async function listBa(extraPlaces: Place[] = []): Promise<RawJob[]> {
  const seen = new Map<string, BaItem>();
  for (const was of LOCAL_QUERIES) {
    for (const i of await search({ was, wo: 'Erftstadt', umkreis: '50' })) seen.set(i.referenznummer, i);
    // Von Martin hinzugefügte Orte (z.B. Düsseldorf, Berlin) mit ihrem Umkreis
    for (const p of extraPlaces) {
      for (const i of await search({ was, wo: p.name, umkreis: String(Math.min(Math.max(p.km, 10), 200)) })) seen.set(i.referenznummer, i);
    }
  }
  for (const was of REMOTE_QUERIES) {
    for (const i of await search({ was })) seen.set(i.referenznummer, i);
  }
  return [...seen.values()].map((i) => ({
    id: `ba:${i.referenznummer}`,
    source: 'ba',
    company: i.firma ?? 'unbekannt',
    title: i.stellenangebotsTitel ?? i.titel ?? '',
    locations: (i.stellenlokationen ?? []).map((l) => ({
      label: [l.adresse?.plz, l.adresse?.ort].filter(Boolean).join(' '),
      lat: l.breite,
      lon: l.laenge,
    })),
    mode: 'unbekannt',
    url: `https://www.arbeitsagentur.de/jobsuche/jobdetail/${encodeURIComponent(i.referenznummer)}`,
    published: i.datumErsteVeroeffentlichung,
  }));
}

/** Holt Beschreibung und Homeoffice-Angabe nach. Nur für Stellen, die den Vorfilter bestanden haben. */
export async function enrichBa(job: RawJob): Promise<RawJob> {
  const ref = job.id.slice(3);
  try {
    const d = await fetchJson<any>(`${BASE}/v4/jobdetails/${Buffer.from(ref).toString('base64')}`, { headers: HEADERS });
    const ho = d.homeofficemoeglich;
    return {
      ...job,
      description: d.stellenangebotsBeschreibung ?? undefined,
      mode: ho === true ? 'hybrid' : job.mode,
      // allianzpartnerUrl ist oft nur die Startseite der Firma, die BA-Seite verlinkt die Anzeige zuverlässig
    };
  } catch {
    return job;
  }
}
