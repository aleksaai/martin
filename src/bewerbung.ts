// Bewerbung per Knopf: Anschreiben (Text + PDF), Lebenslauf, Weg zur Bewerbung, Nachverfolgung.
import { readFileSync } from 'node:fs';
import { docPath, fileSafe, letterPdf } from './documents.ts';
import { interviewPrep, writeLetter, writeMail } from './llm.ts';
import type { Store } from './store.ts';
import { button, esc, tg, tgFile } from './tg.ts';
import type { StoredJob } from './types.ts';

// Portale mit Konto-Pflicht oder ohne direktes Formular: dort bewirbt Martin sich selbst über den Link
const NO_FORM = new Set(['ba', 'workday', 'successfactors_rss', 'oracle_hcm']);
export const canFillForm = (job: StoredJob) => !NO_FORM.has(job.source);

export function applicationEmail(text: string | null): string | null {
  const all = [...(text ?? '').matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)].map((m) => m[0].toLowerCase());
  const usable = all.filter((e) => !/datenschutz|privacy|noreply|no-reply|dsb@|dataprotection|webmaster|presse|press@/.test(e));
  return usable.find((e) => /karriere|career|job|bewerb|recruit|hr@|personal|talent|people/.test(e)) ?? usable[0] ?? null;
}

const DAY = 86_400_000;

async function sendLetterPdf(chatId: string, job: StoredJob, letter: string) {
  const pdf = await letterPdf(letter, job);
  await tgFile('sendDocument', chatId, pdf, `Anschreiben_Martin_Spalevic_${fileSafe(job.company)}.pdf`);
}

/** Knopf "📨 Bewerben": alles vorbereiten, was Martin zum Abschicken braucht. */
export async function prepareApplication(store: Store, chatId: string, job: StoredJob, ref: string) {
  await tg('sendChatAction', { chat_id: chatId, action: 'typing' });
  const letter = await writeLetter(job, await store.letterExamples(4), (await store.kvGet('answers')) ?? '');
  await store.upsertApplication({ job_id: job.id, letter });
  await store.setFeedback(job.id, 'gut');

  const msg = await tg('sendMessage', {
    chat_id: chatId,
    text: `✍️ <b>Anschreiben für ${esc(job.title)}</b> bei ${esc(job.company)}\n\n${esc(letter)}\n\n<i>Willst du etwas ändern? Antworte auf diese Nachricht mit deiner fertigen Fassung (lang drücken → Antworten). Dann baue ich das PDF neu und merke mir deinen Stil für die nächsten Anschreiben.</i>`,
    parse_mode: 'HTML',
  });
  await store.kvSet(`letter_msg:${chatId}:${msg.message_id}`, job.id);

  await sendLetterPdf(chatId, job, letter);
  const cv = docPath('lebenslauf');
  if (cv) await tgFile('sendDocument', chatId, readFileSync(cv), 'Lebenslauf_Martin_Spalevic.pdf');

  const email = applicationEmail(job.description);
  const rows: any[][] = [];
  let how: string;
  if (email) {
    const mail = await writeMail(job);
    how = `📧 Die Anzeige nennt <b>${esc(email)}</b>. Schick dort Anschreiben und Lebenslauf als Anhang hin, zum Beispiel mit diesem Text:\n\n${esc(mail)}`;
  } else if (canFillForm(job)) {
    how = `🤖 Ich kann das Bewerbungsformular für dich ausfüllen. Du bekommst einen Screenshot und entscheidest dann, ob es abgeschickt wird.`;
    rows.push([button('🤖 Formular ausfüllen', `form:${ref}`)]);
  } else {
    how = `🔗 Diese Bewerbung läuft über das Portal des Arbeitgebers. Öffne die Anzeige und lade dort Anschreiben und Lebenslauf hoch:\n${esc(job.url)}`;
  }
  rows.push([button('✅ Ich habe mich beworben', `ok:${ref}`)]);
  await tg('sendMessage', { chat_id: chatId, text: how, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: rows } });
}

/** Antwort auf ein Anschreiben = Martins Endfassung: speichern, PDF neu, als Stilvorlage merken. */
export async function handleLetterReply(store: Store, chatId: string, replyToId: number, text: string): Promise<boolean> {
  const jobId = await store.kvGet(`letter_msg:${chatId}:${replyToId}`);
  if (!jobId) return false;
  const job = await store.getJob(jobId);
  if (!job) return false;
  await store.upsertApplication({ job_id: job.id, letter: text });
  await store.addLetterExample(text);
  await sendLetterPdf(chatId, job, text);
  await tg('sendMessage', { chat_id: chatId, text: 'Übernommen. Das PDF oben ist deine Fassung, und ich schreibe die nächsten Anschreiben näher an deinem Stil.' });
  return true;
}

export async function markApplied(store: Store, chatId: string, job: StoredJob, ref: string) {
  await store.upsertApplication({ job_id: job.id, status: 'beworben', applied_at: new Date().toISOString(), followup_at: new Date(Date.now() + 10 * DAY).toISOString() });
  await tg('sendMessage', {
    chat_id: chatId,
    text: `Notiert: Bewerbung bei ${job.company}. Ich frage in 10 Tagen nach. Kommt vorher eine Antwort, tipp hier auf den passenden Knopf.`,
    reply_markup: { inline_keyboard: [[button('📅 Einladung', `ein:${ref}`), button('❌ Absage', `abs:${ref}`)]] },
  });
}

/** Läuft mit dem Suchlauf: nach 10 Tagen nachfragen, danach noch zweimal im Wochenabstand. */
export async function sendFollowups(store: Store, newRef: (jobId: string) => Promise<string>) {
  const subs = (await store.subscribers()).filter((s) => !s.paused);
  for (const a of await store.dueFollowups()) {
    const job = await store.getJob(a.job_id);
    if (!job) continue;
    const ref = await newRef(job.id);
    const days = a.applied_at ? Math.round((Date.now() - Date.parse(a.applied_at)) / DAY) : 10;
    for (const s of subs) {
      await tg('sendMessage', {
        chat_id: s.chat_id,
        text: `Vor ${days} Tagen hast du dich bei ${job.company} beworben (${job.title}). Schon was gehört?`,
        reply_markup: { inline_keyboard: [[button('📅 Einladung', `ein:${ref}`), button('❌ Absage', `abs:${ref}`), button('⏳ Noch nichts', `nix:${ref}`)]] },
      }).catch(() => {});
    }
    // Erst nach Antwort oder in einer Woche wieder fragen
    await store.upsertApplication({ job_id: job.id, followup_at: a.followups >= 2 ? null : new Date(Date.now() + 7 * DAY).toISOString(), followups: a.followups + 1 });
  }
}

export async function handleOutcome(store: Store, chatId: string, job: StoredJob, action: 'ein' | 'abs' | 'nix') {
  if (action === 'ein') {
    await store.upsertApplication({ job_id: job.id, status: 'einladung', followup_at: null });
    await tg('sendMessage', { chat_id: chatId, text: `Glückwunsch zur Einladung bei ${job.company}! Ich bereite dich vor, einen Moment.` });
    await tg('sendChatAction', { chat_id: chatId, action: 'typing' });
    await tg('sendMessage', { chat_id: chatId, text: await interviewPrep(job) });
  } else if (action === 'abs') {
    await store.upsertApplication({ job_id: job.id, status: 'absage', followup_at: null });
    await tg('sendMessage', { chat_id: chatId, text: 'Schade. Abgehakt, die nächsten Stellen kommen.' });
  } else {
    await tg('sendMessage', { chat_id: chatId, text: 'Alles klar, ich frage in einer Woche nochmal.' });
  }
}

export async function listApplications(store: Store): Promise<string> {
  const by = await store.applicationsByStatus();
  const label: Record<string, string> = { entwurf: 'vorbereitet', beworben: 'beworben', einladung: 'Einladung', absage: 'Absage', zusage: 'Zusage' };
  const parts = Object.entries(by).map(([k, n]) => `${label[k] ?? k}: ${n}`);
  return parts.length ? `Deine Bewerbungen\n${parts.join('\n')}` : 'Noch keine Bewerbungen. Tipp bei einer Stelle auf 📨 Bewerben.';
}
