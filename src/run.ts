// Ein Suchlauf: alle Quellen abholen, Neues filtern, bewerten, ablegen. Melden macht telegram.ts.
import { readFileSync, existsSync } from 'node:fs';
import { cfg } from './config.ts';
import { dedupeKey, placeCheck, studentCheck } from './filter.ts';
import { scoreJob } from './llm.ts';
import { enrichBa, listBa } from './sources/ba.ts';
import { enrichAts, listCompany } from './sources/ats.ts';
import { enrichHtml, listHtml } from './sources/html.ts';
import type { Store } from './store.ts';
import type { Company, RawJob, StoredJob } from './types.ts';

// Nur echte Vollremote-Formulierungen. "Homeoffice möglich" heißt meist hybrid und reicht bei weit entfernten Stellen nicht.
const REMOTE_HINT = /(100\s?%|voll(ständig)?|komplett|ausschließlich|rein|full(y)?)[\s-]*(remote|mobil|home ?office)|remote[\s-]*(only|first)|ortsunabhängig|deutschlandweit remote|bundesweit remote|remote (aus|in) (ganz )?deutschland|\(remote\)|- remote\b|\bremote\)?$/i;

// Ein hängender Feed darf nie den ganzen Lauf blockieren
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`Zeitüberschreitung nach ${ms / 1000} s`)), ms))]);
}

async function enrich(job: RawJob, company?: Company): Promise<RawJob> {
  if (job.source === 'ba') return enrichBa(job);
  if (job.source === 'html') return enrichHtml(job);
  return company ? enrichAts(job, company) : job;
}

export function loadCompanies(): Company[] {
  const path = new URL('../data/companies.json', import.meta.url);
  if (!existsSync(path)) return [];
  const all = JSON.parse(readFileSync(path, 'utf8')) as Company[];
  // html-Seiten zählen auch ohne verifizierten Feed, solange eine URL da ist
  return all.filter((c) => c.ats?.type && (c.ats.type === 'html' ? !!(c.ats.feed_url ?? (c as any).careers_url) : c.verified !== false));
}

export interface RunReport { fetched: number; fresh: number; scored: number; matches: number; errors: string[]; bySource: Record<string, number> }

export async function runOnce(store: Store, log = console.log): Promise<RunReport> {
  const report: RunReport = { fetched: 0, fresh: 0, scored: 0, matches: 0, errors: [], bySource: {} };
  const jobs: { job: RawJob; company?: Company }[] = [];

  if (!cfg.sourcesOff.includes('ba')) {
    try {
      const ba = await listBa();
      jobs.push(...ba.map((job) => ({ job })));
      report.bySource.ba = ba.length;
    } catch (e) {
      report.errors.push(`BA: ${(e as Error).message}`);
    }
  }

  const companies = loadCompanies().filter((c) => !cfg.sourcesOff.includes(c.ats.type));
  // Wenige gleichzeitig, damit kein Anbieter uns drosselt
  for (let i = 0; i < companies.length; i += 6) {
    await Promise.all(companies.slice(i, i + 6).map(async (c) => {
      try {
        const list = await withTimeout(c.ats.type === 'html' ? listHtml(c, store) : listCompany(c), 90_000);
        jobs.push(...list.map((job) => ({ job, company: c })));
        report.bySource[c.ats.type] = (report.bySource[c.ats.type] ?? 0) + list.length;
      } catch (e) {
        report.errors.push(`${c.name} (${c.ats.type}): ${(e as Error).message.slice(0, 120)}`);
      }
    }));
  }
  report.fetched = jobs.length;

  const calibration = (await store.recentFeedback(15)).map((f) => `${f.feedback === 'gut' ? '👍' : '👎'} ${f.title} (${f.company})`).join('\n');

  // Innerhalb eines Laufs doppelte Stellen (z.B. mehrere BA-Suchbegriffe) nur einmal prüfen
  const seenKeys = new Set<string>();
  const queue: { raw: RawJob; company?: Company; key: string }[] = [];
  for (const { job: raw, company } of jobs) {
    const key = dedupeKey(raw);
    if (seenKeys.has(key) || seenKeys.has(raw.id)) continue;
    seenKeys.add(key); seenKeys.add(raw.id);
    if (await store.known(raw.id, key)) continue;
    queue.push({ raw, company, key });
  }
  report.fresh = queue.length;

  const work = async ({ raw, company, key }: (typeof queue)[number]) => {

    const base: StoredJob & { dedupe_key: string } = {
      id: raw.id, dedupe_key: key, source: raw.source, company: raw.company, title: raw.title,
      location: raw.locations.map((l) => l.label).join(' / '), distance_km: null, mode: raw.mode, url: raw.url,
      description: null, status: 'skipped', skip_reason: null, score: null, reason: null,
      first_seen: new Date().toISOString(), notified_at: null, feedback: null,
    };

    const notStudent = studentCheck(raw);
    if (notStudent) { await store.saveJob({ ...base, skip_reason: notStudent }); return; }

    let job = raw;
    let place = await placeCheck(job, store);
    // Zu weit: vielleicht trotzdem remote. Beschreibung holen und nachsehen.
    if (!place.ok && place.reason?.startsWith('zu weit')) {
      job = await enrich(job, company);
      if (REMOTE_HINT.test(`${job.title} ${job.description ?? ''}`)) place = { ...place, ok: true };
    }
    if (!place.ok) {
      await store.saveJob({ ...base, distance_km: place.distance, skip_reason: place.reason ?? 'Ort' });
      return;
    }
    if (!job.description) job = await enrich(job, company);

    const placeText = place.distance !== null ? `${place.label} (${place.distance} km von Erftstadt)` : place.label;
    try {
      const v = await scoreJob(job, placeText, calibration);
      report.scored++;
      // Weiter weg als MAX_KM zählt nur, wenn die Stelle wirklich vollremote ist
      const tooFar = place.distance !== null && place.distance > cfg.maxKm && v.mode !== 'remote';
      const isMatch = v.machbar && !tooFar && v.score >= cfg.minScore;
      if (isMatch) report.matches++;
      await store.saveJob({
        ...base,
        mode: (['remote', 'hybrid', 'vor Ort'].includes(v.mode) ? v.mode : job.mode) as StoredJob['mode'],
        url: job.url,
        distance_km: place.distance,
        description: job.description?.slice(0, 12_000) ?? null,
        status: isMatch ? 'match' : 'low',
        skip_reason: !v.machbar ? 'laut Modell nicht machbar' : tooFar ? 'zu weit und nicht vollremote' : null,
        score: v.score,
        reason: v.reason,
      });
      log(`${isMatch ? '✅' : '·'} ${v.score}/10 ${job.title} | ${job.company} | ${placeText}`);
    } catch (e) {
      // Nicht speichern, damit der nächste Lauf es erneut versucht
      report.errors.push(`Bewertung ${job.title}: ${(e as Error).message.slice(0, 120)}`);
    }
  };

  // Fünf gleichzeitig: schnell genug, ohne an Rate-Limits zu stoßen
  let next = 0;
  await Promise.all(Array.from({ length: 5 }, async () => {
    while (next < queue.length) await work(queue[next++]);
  }));
  return report;
}
