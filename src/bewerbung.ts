// Bewerbung per Knopf: Anschreiben (Text + PDF), Lebenslauf, Weg zur Bewerbung, Nachverfolgung.
import { readFileSync } from 'node:fs';
import { docPath, fileSafe, letterPdf } from './documents.ts';
import { findOriginalPosting, interviewPrep, reviseLetter, writeLetter, writeMail } from './llm.ts';
import type { Store } from './store.ts';
import { button, esc, tg, tgFile } from './tg.ts';
import type { StoredJob } from './types.ts';

// Portale mit Konto-Pflicht: dort bewirbt Martin sich selbst über den Link.
// BA-Stellen gehen, wenn die Original-Anzeige beim Arbeitgeber gefunden wurde (findOriginalPosting).
const NO_FORM = new Set(['workday', 'successfactors_rss', 'oracle_hcm']);
const ACCOUNT_PORTAL = /myworkdayjobs|successfactors|oraclecloud|taleo|icims|avature|phenom/i;
export const canFillForm = (source: string, url: string) => !NO_FORM.has(source) && !ACCOUNT_PORTAL.test(url) && !/arbeitsagentur\.de/.test(url);

/** Statuszeile wie bei den anderen Agenten: eine Nachricht, die die Schritte zeigt und am Ende verschwindet. */
async function statusLine(chatId: string, first: string) {
  const msg = await tg('sendMessage', { chat_id: chatId, text: `⏳ ${first}` }).catch(() => null);
  let alive = true;
  const typing = setInterval(() => { if (alive) void tg('sendChatAction', { chat_id: chatId, action: 'upload_document' }).catch(() => {}); }, 4500);
  void tg('sendChatAction', { chat_id: chatId, action: 'upload_document' }).catch(() => {});
  return {
    step: (text: string) => (msg ? tg('editMessageText', { chat_id: chatId, message_id: msg.message_id, text: `⏳ ${text}` }).catch(() => {}) : undefined),
    done: async () => {
      alive = false;
      clearInterval(typing);
      if (msg) await tg('deleteMessage', { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
    },
  };
}

export function applicationEmail(text: string | null): string | null {
  const all = [...(text ?? '').matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)].map((m) => m[0].toLowerCase());
  const usable = all.filter((e) => !/datenschutz|privacy|noreply|no-reply|dsb@|dataprotection|webmaster|presse|press@/.test(e));
  return usable.find((e) => /karriere|career|job|bewerb|recruit|hr@|personal|talent|people/.test(e)) ?? usable[0] ?? null;
}

const DAY = 86_400_000;

/** Anschreiben nur als PDF. Eine Antwort auf dieses PDF ändert es (handleLetterReply). */
async function sendLetterPdf(store: Store, chatId: string, job: StoredJob, letter: string, caption: string) {
  const pdf = await letterPdf(letter, job);
  const msg = await tgFile('sendDocument', chatId, pdf, `Anschreiben_Martin_Spalevic_${fileSafe(job.company)}.pdf`, { caption });
  await store.kvSet(`letter_msg:${chatId}:${msg.message_id}`, job.id);
}

const LETTER_CAPTION = 'Dein Anschreiben. Etwas ändern? Antworte auf dieses PDF, z.B. „kürzer“ oder „erwähne meine Bachelorarbeit“, oder schick deine eigene Fassung.';

/** Knopf "📨 Bewerben": Anschreiben-PDF, Lebenslauf und der passende Weg zur Bewerbung. */
export async function prepareApplication(store: Store, chatId: string, job: StoredJob, ref: string) {
  const status = await statusLine(chatId, `Schreibe dein Anschreiben für ${job.company} …`);
  try {
    const answers = (await store.kvGet('answers')) ?? '';
    const letter = await writeLetter(job, await store.letterExamples(4), answers, status.step);
    await store.upsertApplication({ job_id: job.id, letter });
    await store.setFeedback(job.id, 'gut');

    await status.step('Baue das PDF …');
    await sendLetterPdf(store, chatId, job, letter, LETTER_CAPTION);
    const cv = docPath('lebenslauf');
    if (cv) await tgFile('sendDocument', chatId, readFileSync(cv), 'Lebenslauf_Martin_Spalevic.pdf');

    // Bewerbungsweg: Mail aus der Anzeige, sonst Formular beim Arbeitgeber, sonst Link
    let applyUrl = job.url;
    if (job.source === 'ba') {
      await status.step('Suche die Original-Anzeige beim Arbeitgeber …');
      applyUrl = (await findOriginalPosting(job)) ?? job.url;
    }
    await store.kvSet(`apply_url:${job.id}`, applyUrl);
    const email = applicationEmail(job.description);
    const rows: any[][] = [];
    let how: string;
    if (email) {
      await status.step('Schreibe die Begleitmail …');
      const mail = await writeMail(job);
      how = `📧 Die Anzeige nennt <b>${esc(email)}</b>. Schick dort Anschreiben und Lebenslauf als Anhang hin, zum Beispiel mit diesem Text:\n\n${esc(mail)}`;
    } else if (canFillForm(job.source, applyUrl)) {
      how = `🤖 Soll ich mich für dich bewerben? Ich fülle das Formular bei ${esc(job.company)} aus, lade beide PDFs hoch und schicke dir einen Screenshot. Abgeschickt wird erst, wenn du zustimmst.`;
      rows.push([button('🤖 Für mich bewerben', `form:${ref}`)]);
    } else if (/arbeitsagentur\.de/.test(applyUrl)) {
      how = `🔗 Diese Stelle gibt es nur bei der Arbeitsagentur, eine eigene Online-Anzeige des Arbeitgebers habe ich nicht gefunden. Den Bewerbungsweg zeigt die Arbeitsagentur erst nach einer Sicherheitsabfrage: Anzeige öffnen, ganz unten bei „Informationen zur Bewerbung“ die Zeichen eingeben, dann siehst du Mail oder Link.\n${esc(applyUrl)}`;
    } else {
      how = `🔗 Diese Bewerbung läuft über ein Portal mit eigenem Konto. Öffne die Anzeige und lade dort beide PDFs hoch:\n${esc(applyUrl)}`;
    }
    rows.push([button('✅ Ich habe mich schon beworben', `ok:${ref}`)]);
    await status.done();
    await tg('sendMessage', { chat_id: chatId, text: how, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: rows } });
  } catch (e) {
    await status.done();
    await tg('sendMessage', { chat_id: chatId, text: `Da ist etwas schiefgegangen (${(e as Error).message.slice(0, 100)}). Tipp nochmal auf 📨 Bewerben.` });
    throw e;
  }
}

/** Antwort auf das Anschreiben-PDF: lange Antwort = Martins eigene Fassung (wird Stilvorlage), kurze = Änderungswunsch. */
export async function handleLetterReply(store: Store, chatId: string, replyToId: number, text: string): Promise<boolean> {
  const jobId = await store.kvGet(`letter_msg:${chatId}:${replyToId}`);
  if (!jobId) return false;
  const job = await store.getJob(jobId);
  if (!job) return false;
  const own = text.trim().split(/\s+/).length >= 120 || /^sehr geehrte/i.test(text.trim());
  const status = await statusLine(chatId, own ? 'Übernehme deine Fassung …' : 'Überarbeite das Anschreiben …');
  try {
    const current = (await store.getApplication(job.id))?.letter ?? '';
    const letter = own ? text : await reviseLetter(current, text, (await store.kvGet('answers')) ?? '');
    await store.upsertApplication({ job_id: job.id, letter });
    if (own) await store.addLetterExample(text);
    await status.step('Baue das PDF …');
    await sendLetterPdf(store, chatId, job, letter, own ? 'Deine Fassung. Ich schreibe die nächsten Anschreiben näher an deinem Stil.' : `Überarbeitet. ${LETTER_CAPTION}`);
  } finally {
    await status.done();
  }
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
