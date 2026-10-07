// Stelle, die Martin selbst gefunden hat (Link oder eingefügter Text): Anzeige holen, einordnen, ablegen und danach
// denselben Weg gehen wie bei einem Treffer aus der Suche (Anschreiben als PDF, Lebenslauf, Bewerbungsweg mit Knöpfen).
import { createHash } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { prepareApplication } from './bewerbung.ts';
import { cfg } from './config.ts';
import { fetchText, stripHtml } from './http.ts';
import type { Store } from './store.ts';
import type { StoredJob, WorkMode } from './types.ts';

const client = new Anthropic({ apiKey: cfg.anthropicKey });
// Viele Stellenseiten liefern Bots eine leere Hülle; mit Browser-Kennung kommt der Text
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

/** LinkedIn-Anzeigen sind hinter dem Login, der Gast-Endpunkt liefert dieselbe Anzeige ohne Konto. */
export function postingUrl(url: string): string {
  const li = /linkedin\.com\/.*?(?:jobs\/view\/(?:[^/?]*-)?|currentJobId=)(\d{6,})/i.exec(url);
  return li ? `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${li[1]}` : url;
}

export async function fetchPosting(url: string): Promise<string> {
  const html = await fetchText(postingUrl(url), { headers: { 'User-Agent': BROWSER_UA } }, 25_000);
  return stripHtml(html).slice(0, 12_000);
}

export interface OwnJobInput { link?: string; text?: string; firma?: string; titel?: string; ort?: string }

async function classify(text: string): Promise<{ firma: string; titel: string; ort: string; mode: WorkMode }> {
  const res = await client.messages.create({
    model: cfg.scoreModel,
    max_tokens: 300,
    system: 'Du liest den Text einer Stellenanzeige und antwortest nur mit JSON: {"firma": "...", "titel": "...", "ort": "Stadt oder leer", "mode": "remote"|"hybrid"|"vor Ort"|"unbekannt"}. Firma = der tatsächliche Arbeitgeber laut Anzeigentext (bei Konzern und Tochter die Tochter, z.B. congstar statt Deutsche Telekom; bei Kanzlei die Kanzlei, nicht das Jobportal). Titel ohne (m/w/d).',
    messages: [{ role: 'user', content: text.slice(0, 6000) }],
  });
  const raw = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  const j = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
  const mode = (['remote', 'hybrid', 'vor Ort'].includes(j.mode) ? j.mode : 'unbekannt') as WorkMode;
  return { firma: String(j.firma ?? '').trim(), titel: String(j.titel ?? '').trim(), ort: String(j.ort ?? '').trim(), mode };
}

/**
 * Legt die Stelle ab und startet die Bewerbungsvorbereitung. Gibt eine Meldung für das Modell zurück;
 * Martin bekommt PDF, Lebenslauf und Bewerbungsweg direkt vom System.
 */
export async function addOwnJob(store: Store, chatId: string, input: OwnJobInput): Promise<string> {
  const link = (input.link ?? '').trim();
  let text = (input.text ?? '').trim();
  let fetchError = '';
  if (!text && link) {
    try { text = await fetchPosting(link); }
    catch (e) { fetchError = (e as Error).message.slice(0, 100); }
  }
  if (text.length < 200 && !(input.firma && input.titel)) {
    return `Die Anzeige konnte ich nicht lesen${fetchError ? ` (${fetchError})` : ''}. Martin soll den Anzeigentext kopieren und in den Chat einfügen (oder Firma und Stellentitel nennen), dann geht es weiter.`;
  }
  const guess = text.length >= 200 ? await classify(text).catch(() => null) : null;
  const company = input.firma?.trim() || guess?.firma || 'unbekannt';
  const title = input.titel?.trim() || guess?.titel || 'Werkstudent';
  const location = input.ort?.trim() || guess?.ort || '';
  const id = `manuell:${createHash('sha1').update((link || `${company}|${title}`).toLowerCase()).digest('hex').slice(0, 16)}`;
  const existing = await store.getJob(id);
  const job: StoredJob & { dedupe_key: string } = {
    id, dedupe_key: id, source: 'manuell', company, title, location, distance_km: null,
    mode: guess?.mode ?? 'unbekannt', url: link, description: text || existing?.description || null,
    status: 'manuell', skip_reason: null, score: existing?.score ?? null, reason: existing?.reason ?? 'Von Martin selbst gefunden',
    first_seen: existing?.first_seen ?? new Date().toISOString(), notified_at: new Date().toISOString(), feedback: existing?.feedback ?? null,
  };
  await store.saveJob(job);
  const { shortRef } = await import('./telegram.ts');
  await prepareApplication(store, chatId, job, await shortRef(store, job.id));
  return `Stelle „${title}“ bei ${company}${location ? ` (${location})` : ''} ist angelegt. Anschreiben-PDF, Lebenslauf und Bewerbungsweg sind schon bei Martin. Nicht wiederholen, höchstens ein kurzer Satz.`;
}
