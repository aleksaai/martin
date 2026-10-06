// Karriereseiten ohne Feed (viele Kanzleien): Seite holen, Links und Text an Haiku, Stellen als JSON zurück.
// Haiku läuft nur, wenn sich die Seite seit dem letzten Lauf geändert hat. Sonst gilt das gespeicherte Ergebnis.
import { createHash } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { cfg } from '../config.ts';
import { fetchText, stripHtml } from '../http.ts';
import type { Store } from '../store.ts';
import type { Company, RawJob } from '../types.ts';

const client = new Anthropic({ apiKey: cfg.anthropicKey });

interface Extracted { title: string; url: string; location?: string }

function links(html: string, base: string): string {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const text = stripHtml(m[2]).replace(/\s+/g, ' ').trim();
    if (!text || text.length > 160) continue;
    let href: string;
    try { href = new URL(m[1], base).toString(); } catch { continue; }
    if (seen.has(href) || /^(mailto|tel|javascript):/i.test(href)) continue;
    seen.add(href);
    out.push(`${text} -> ${href}`);
  }
  return out.slice(0, 400).join('\n');
}

export async function listHtml(c: Company, store: Store): Promise<RawJob[]> {
  const url = c.ats.feed_url ?? (c as any).careers_url;
  if (!url) return [];
  const html = await fetchText(url, {}, 20_000);
  const text = stripHtml(html).slice(0, 12_000);
  const linkList = links(html, url);
  const hash = createHash('sha1').update(text + linkList).digest('hex');
  const cacheKey = `html:${url}`;
  const cached = await store.kvGet(cacheKey);
  let jobs: Extracted[];
  if (cached && JSON.parse(cached).hash === hash) {
    jobs = JSON.parse(cached).jobs;
  } else {
    const res = await client.messages.create({
      model: cfg.scoreModel,
      max_tokens: 2000,
      system: `Du liest die Karriereseite eines Arbeitgebers und listest die dort ausgeschriebenen Stellen auf.
Antworte ausschließlich mit JSON: {"jobs":[{"title":"...","url":"absolute URL der Stellenanzeige oder der Seite selbst","location":"Ort, falls genannt"}]}.
Nur echte Stellenanzeigen (auch Werkstudenten, studentische und wissenschaftliche Mitarbeiter, Praktika, Referendariat), keine Navigation,
keine allgemeinen Texte wie "Karriere bei uns" oder "Initiativbewerbung", es sei denn, es ist ausdrücklich eine Stelle.
Keine Stellen gefunden: {"jobs":[]}.`,
      messages: [{ role: 'user', content: `Arbeitgeber: ${c.name}\nSeite: ${url}\n\nLinks:\n${linkList}\n\nText:\n${text}` }],
    });
    const raw = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    try {
      jobs = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)).jobs ?? [];
    } catch {
      jobs = [];
    }
    await store.kvSet(cacheKey, JSON.stringify({ hash, jobs }));
  }
  return jobs.filter((j) => j.title).map((j) => ({
    id: `html:${createHash('sha1').update(`${c.name}|${j.title}|${j.url}`).digest('hex').slice(0, 16)}`,
    source: 'html',
    company: c.name,
    title: j.title,
    locations: j.location ? [{ label: j.location }] : c.city ? [{ label: c.city }] : [],
    mode: /remote|home ?office/i.test(`${j.title} ${j.location ?? ''}`) ? 'remote' : 'unbekannt',
    url: j.url || url,
  }));
}

/** Beschreibung einer einzelnen Anzeige von einer Kanzleiseite nachladen. */
export async function enrichHtml(job: RawJob): Promise<RawJob> {
  try {
    const html = await fetchText(job.url);
    return { ...job, description: stripHtml(html).slice(0, 8000) };
  } catch {
    return job;
  }
}
