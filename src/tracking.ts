// Bewerbungs-Tracking: alles, wo Martin sich beworben hat, egal ob über Adolf, per Mail, Portal oder LinkedIn.
import { createHash } from 'node:crypto';
import type { ApplicationRow, Store } from './store.ts';
import { button, esc, tg } from './tg.ts';

const DAY = 86_400_000;
export const STATUS_LABEL: Record<string, string> = {
  entwurf: 'vorbereitet', beworben: 'beworben', einladung: 'Einladung', absage: 'Absage', zusage: 'Zusage', zurueckgezogen: 'zurückgezogen',
};

/** Eine Bewerbung eintragen. Bekannte Stelle wird verknüpft, sonst als manuelle Stelle angelegt. */
export async function recordApplication(store: Store, a: { firma: string; stelle: string; kanal?: string; datum?: string; link?: string; notiz?: string; jobId?: string }): Promise<string> {
  let jobId = a.jobId ?? null;
  if (!jobId) {
    const hits = (await store.findJobs(a.firma, 10)).filter((j) => !a.stelle || similar(j.title, a.stelle));
    jobId = hits[0]?.id ?? null;
  }
  if (!jobId) {
    jobId = `manuell:${createHash('sha1').update(`${a.firma}|${a.stelle}`.toLowerCase()).digest('hex').slice(0, 16)}`;
    await store.saveJob({
      id: jobId, dedupe_key: jobId, source: 'manuell', company: a.firma, title: a.stelle || 'Bewerbung', location: '', distance_km: null,
      mode: 'unbekannt', url: a.link ?? '', description: null, status: 'manuell', skip_reason: null, score: null, reason: null,
      first_seen: new Date().toISOString(), notified_at: null, feedback: 'gut',
    });
  }
  const applied = a.datum && !Number.isNaN(Date.parse(a.datum)) ? new Date(a.datum).toISOString() : new Date().toISOString();
  await store.upsertApplication({
    job_id: jobId, status: 'beworben', applied_at: applied, channel: a.kanal ?? 'sonstiges', notes: a.notiz ?? null,
    followup_at: new Date(Date.parse(applied) + 10 * DAY).toISOString(),
  });
  await store.setFeedback(jobId, 'gut');
  return jobId;
}

function similar(a: string, b: string): boolean {
  const words = (s: string) => new Set(s.toLowerCase().replace(/\(.*?\)/g, '').split(/[^a-zäöüß]+/).filter((w) => w.length > 3));
  const A = words(a), B = words(b);
  return [...B].some((w) => A.has(w));
}

/** Status einer Bewerbung ändern (Einladung, Absage mit Grund, Zusage …). */
export async function updateApplication(store: Store, query: string, status: string, notiz?: string): Promise<string> {
  const rows = (await store.listApplications()).filter((r) => `${r.company} ${r.title}`.toLowerCase().includes(query.toLowerCase()));
  if (!rows.length) return `Keine Bewerbung zu „${query}“ gefunden.`;
  if (rows.length > 1 && !rows.every((r) => r.job_id === rows[0].job_id)) return `Mehrdeutig: ${rows.slice(0, 5).map((r) => `${r.company} – ${r.title}`).join('; ')}. Genauer nachfragen.`;
  const r = rows[0];
  await store.upsertApplication({ job_id: r.job_id, status: status as ApplicationRow['status'], followup_at: null, notes: [r.notes, notiz].filter(Boolean).join(' | ') || null });
  return `${r.company} (${r.title}) steht jetzt auf ${STATUS_LABEL[status] ?? status}.`;
}

/** Zahlen und Liste für Chat und /bewerbungen. */
export async function overview(store: Store): Promise<string> {
  const rows = (await store.listApplications()).filter((r) => r.status !== 'entwurf');
  if (!rows.length) return 'Noch keine Bewerbung eingetragen.';
  const count = (s: string) => rows.filter((r) => r.status === s).length;
  const decided = count('einladung') + count('zusage') + count('absage');
  const lines = [
    `Bewerbungen gesamt: ${rows.length}`,
    `offen: ${count('beworben')} · Einladung: ${count('einladung')} · Zusage: ${count('zusage')} · Absage: ${count('absage')}${count('zurueckgezogen') ? ` · zurückgezogen: ${count('zurueckgezogen')}` : ''}`,
    decided ? `Quote Einladung/Zusage: ${Math.round(((count('einladung') + count('zusage')) / decided) * 100)} % der beantworteten` : '',
    `Kanäle: ${Object.entries(rows.reduce<Record<string, number>>((m, r) => ((m[r.channel ?? 'sonstiges'] = (m[r.channel ?? 'sonstiges'] ?? 0) + 1), m), {})).map(([k, n]) => `${k} ${n}`).join(', ')}`,
    '',
    ...rows.slice(0, 15).map((r) => `${r.applied_at ? new Date(r.applied_at).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }) : '--.--'} ${r.company}: ${r.title} → ${STATUS_LABEL[r.status] ?? r.status}${r.notes ? ` (${r.notes.slice(0, 80)})` : ''}`),
  ];
  return lines.filter((l, i) => l || i > 3).join('\n');
}

/** Treffer, auf die Martin seit 24 Stunden nicht reagiert hat: einmal gebündelt nachhaken. */
export async function nudgeUndecided(store: Store, newRef: (jobId: string) => Promise<string>) {
  const jobs = [];
  for (const j of await store.undecided(24, 10)) if (!(await store.kvGet(`nudged:${j.id}`))) jobs.push(j);
  if (!jobs.length) return;
  const subs = (await store.subscribers()).filter((s) => !s.paused);
  const rows = [];
  for (const j of jobs.slice(0, 6)) {
    const ref = await newRef(j.id);
    rows.push([button(`📨 ${j.company.slice(0, 28)}`, `bew:${ref}`), button('👎', `schlecht:${ref}`)]);
    await store.kvSet(`nudged:${j.id}`, new Date().toISOString());
  }
  const text = jobs.length === 1
    ? `Kamerad! Die Stelle bei ${esc(jobs[0].company)} (${esc(jobs[0].title)}) liegt seit gestern unbearbeitet. Bewerben oder wegtreten?`
    : `Kamerad! ${jobs.length} Stellen liegen seit gestern unbearbeitet. Gute Stellen warten nicht. Entscheidung, aber zackig:\n\n${jobs.slice(0, 6).map((j) => `• ${esc(j.company)}: ${esc(j.title)} (${j.score}/10)`).join('\n')}`;
  for (const s of subs) await tg('sendMessage', { chat_id: s.chat_id, text, parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } }).catch(() => {});
}
