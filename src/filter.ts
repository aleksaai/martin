// Vorfilter ohne Modell: Studentenrolle? Ort passend? Erst was hier durchkommt, kostet einen Haiku-Aufruf.
import { cfg } from './config.ts';
import { fetchJson, sleep } from './http.ts';
import type { RawJob } from './types.ts';
import type { Store } from './store.ts';

const STUDENT = /werk\s?student|working student|student(ische[rnm]?)?\s*(hilfskraft|mitarbeit|aushilfe|assistent|assistant|job)|studentjob|student worker|wissenschaftliche[rnm]?\s+mitarbeiter|wiss\.\s*mitarbeiter|studierende/i;
// Rollen, die trotz Treffer sicher nicht passen
const NOT_FOR_HIM = /ausbildung|azubi|duales studium|dualer student|abschlussarbeit|masterarbeit|bachelorarbeit|thesis|referendar|rechtsreferendar|vollzeit.*(senior|lead)|(senior|lead|head of)\b/i;

export function studentCheck(job: RawJob): string | null {
  if (!STUDENT.test(job.title)) return 'keine Studentenrolle';
  if (NOT_FOR_HIM.test(job.title)) return 'Ausbildung/Abschlussarbeit/Referendariat';
  return null;
}

const GERMANY = /deutschland|germany|^de$|\bde\b|dach|europe|europa|\beu\b|emea|anywhere|weltweit|worldwide/i;
const FOREIGN = /austria|österreich|schweiz|switzerland|united kingdom|\buk\b|london|usa|united states|new york|spain|madrid|barcelona|portugal|lisbon|poland|warsaw|netherlands|amsterdam|france|paris|ital|india|wien|vienna|zürich|zurich/i;

export function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

// Häufige Orte ohne Netzabfrage
const KNOWN: Record<string, [number, number]> = {
  köln: [50.9375, 6.9603], cologne: [50.9375, 6.9603], koeln: [50.9375, 6.9603],
  bonn: [50.7374, 7.0982], düsseldorf: [51.2277, 6.7735], dusseldorf: [51.2277, 6.7735], duesseldorf: [51.2277, 6.7735],
  aachen: [50.7753, 6.0839], leverkusen: [51.0459, 7.0192], hürth: [50.8781, 6.8761], frechen: [50.9119, 6.8131],
  kerpen: [50.8697, 6.6961], brühl: [50.8285, 6.9046], erftstadt: [50.7965, 6.769], bergheim: [50.9553, 6.6385],
  pulheim: [51.0, 6.8], wesseling: [50.8217, 6.9775], euskirchen: [50.66, 6.79], neuss: [51.2042, 6.6879],
  berlin: [52.52, 13.405], hamburg: [53.5511, 9.9937], münchen: [48.1351, 11.582], munich: [48.1351, 11.582],
  frankfurt: [50.1109, 8.6821], stuttgart: [48.7758, 9.1829], essen: [51.4556, 7.0116], dortmund: [51.5136, 7.4653],
};

async function geocode(label: string, store: Store): Promise<{ lat: number; lon: number } | null> {
  const key = label.toLowerCase().trim();
  for (const [name, [lat, lon]] of Object.entries(KNOWN)) {
    if (new RegExp(`(^|[^a-zäöüß])${name}([^a-zäöüß]|$)`).test(key)) return { lat, lon };
  }
  const cached = await store.kvGet(`geo:${key}`);
  if (cached !== null) return cached === 'none' ? null : JSON.parse(cached);
  await sleep(1100); // Nominatim: höchstens eine Anfrage pro Sekunde
  try {
    const r = await fetchJson<any[]>(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=de&q=${encodeURIComponent(label)}`);
    const hit = r[0] ? { lat: Number(r[0].lat), lon: Number(r[0].lon) } : null;
    await store.kvSet(`geo:${key}`, hit ? JSON.stringify(hit) : 'none');
    return hit;
  } catch {
    return null;
  }
}

export interface PlaceVerdict { ok: boolean; reason?: string; distance: number | null; label: string }

/** Remote in Deutschland: überall. Vor Ort/hybrid: nur bis MAX_KM um Erftstadt. */
export async function placeCheck(job: RawJob, store: Store): Promise<PlaceVerdict> {
  const labels = job.locations.map((l) => l.label).filter(Boolean);
  const label = labels.join(' / ') || (job.mode === 'remote' ? 'Remote' : 'ohne Ortsangabe');
  let best: number | null = null;
  for (const l of job.locations) {
    const p = l.lat && l.lon ? { lat: l.lat, lon: l.lon } : l.label && !/^remote$/i.test(l.label.trim()) ? await geocode(l.label, store) : null;
    if (p) {
      const d = distanceKm(cfg.home, p);
      if (best === null || d < best) best = d;
    }
  }
  if (best !== null && best <= cfg.maxKm) return { ok: true, distance: best, label };
  if (job.mode === 'remote') {
    const text = labels.join(' ');
    if (text && FOREIGN.test(text) && !GERMANY.test(text)) return { ok: false, reason: 'remote, aber im Ausland', distance: best, label };
    return { ok: true, distance: best, label };
  }
  // Ohne erkennbaren Modus und ohne Ort: Modell soll entscheiden
  if (best === null && job.mode === 'unbekannt') return { ok: true, distance: null, label };
  // Ort zu weit, Remote könnte trotzdem im Text stehen: BA-Detail oder Modell klären das
  if (job.mode === 'unbekannt' || job.mode === 'hybrid') return { ok: false, reason: `zu weit (${best} km)`, distance: best, label };
  return { ok: false, reason: `zu weit (${best} km)`, distance: best, label };
}

/** Für Duplikate über Quellen hinweg (gleiche Stelle bei BA und im Firmen-Feed). */
export function dedupeKey(job: RawJob): string {
  const norm = (s: string) =>
    s.toLowerCase().replace(/\(.*?\)|m\/w\/d|w\/m\/d|all genders|alle geschlechter|gmbh|ag|se|kg|mbh|&|co\.?/g, '').replace(/[^a-zäöüß0-9]/g, '');
  return `${norm(job.company).slice(0, 20)}|${norm(job.title).slice(0, 60)}`;
}
