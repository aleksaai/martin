// Telegram per Long Polling: kein Webhook, keine öffentliche Adresse nötig.
import { cancelForm, handleFormReply, startForm, submitForm } from './apply.ts';
import { handleLetterReply, handleOutcome, listApplications, markApplied, prepareApplication } from './bewerbung.ts';
import { cfg } from './config.ts';
import type { Store } from './store.ts';
import { esc, tg } from './tg.ts';
import type { StoredJob } from './types.ts';

// callback_data darf höchstens 64 Bytes haben, Job-IDs sind länger: kurze Nummer statt ID
export async function shortRef(store: Store, jobId: string): Promise<string> {
  const n = Number((await store.kvGet('ref:next')) ?? '1');
  await store.kvSet('ref:next', String(n + 1));
  await store.kvSet(`ref:${n}`, jobId);
  return String(n);
}

function card(j: StoredJob): string {
  const where = [j.location || null, j.distance_km !== null ? `${j.distance_km} km` : null, j.mode !== 'unbekannt' ? j.mode : null]
    .filter(Boolean).join(' · ');
  return [
    `🆕 <b>${esc(j.title)}</b>`,
    `${esc(j.company)}${where ? ` · ${esc(where)}` : ''}`,
    '',
    `${esc(j.reason ?? '')} <i>(Passung ${j.score}/10)</i>`,
    '',
    `<a href="${esc(j.url)}">Zur Stelle</a>`,
  ].join('\n');
}

async function sendCard(chatId: string, j: StoredJob, ref: string) {
  await tg('sendMessage', {
    chat_id: chatId,
    text: card(j),
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    // Zwei Knöpfe: Bewerben zählt als "passt" (setzt das Feedback in prepareApplication), 👎 lernt das Gegenteil
    reply_markup: { inline_keyboard: [[
      { text: '📨 Bewerben', callback_data: `bew:${ref}` },
      { text: '👎 Passt nicht', callback_data: `schlecht:${ref}` },
    ]] },
  }).catch((e) => console.error(e.message));
}

/** Wer neu dazukommt, bekommt die schon gemeldeten Treffer der letzten 14 Tage nachgeliefert. */
async function sendBacklog(store: Store, chatId: string): Promise<number> {
  const jobs = await store.recentMatches(14, 30);
  for (const j of jobs) await sendCard(chatId, j, await shortRef(store, j.id));
  return jobs.length;
}

export async function notifyPending(store: Store): Promise<number> {
  if (!cfg.telegramToken) return 0;
  const subs = (await store.subscribers()).filter((s) => !s.paused);
  if (!subs.length) return 0;
  const jobs = await store.pending(cfg.maxPerRun);
  for (const j of jobs) {
    const ref = await shortRef(store, j.id);
    for (const s of subs) await sendCard(s.chat_id, j, ref);
    await store.markNotified(j.id);
  }
  const rest = await store.pendingCount();
  if (jobs.length && rest) {
    for (const s of subs) await tg('sendMessage', { chat_id: s.chat_id, text: `Noch ${rest} weitere Treffer, die kommen beim nächsten Lauf.` }).catch(() => {});
  }
  return jobs.length;
}

export async function broadcast(store: Store, text: string) {
  for (const s of await store.subscribers()) await tg('sendMessage', { chat_id: s.chat_id, text }).catch(() => {});
}

const HELP = [
  'Ich suche mehrmals am Tag nach Werkstudentenstellen für dich: remote in Deutschland oder vor Ort/hybrid rund um Köln.',
  'Neue passende Stellen schicke ich dir sofort. Mit 📨 Bewerben und 👎 Passt nicht lerne ich, was dir gefällt.',
  '📨 Bewerben schreibt dir ein Anschreiben (Text + PDF), schickt deinen Lebenslauf mit und füllt auf Wunsch das Bewerbungsformular aus. Abgeschickt wird nur, wenn du auf Absenden tippst.',
  'Antwortest du auf ein Anschreiben mit deiner eigenen Fassung, lerne ich deinen Stil.',
  '',
  '/bewerbungen  Stand deiner Bewerbungen',
  '/suche  jetzt sofort suchen',
  '/status  was bisher gefunden wurde',
  '/pause  keine Meldungen mehr',
  '/weiter  Meldungen wieder an',
].join('\n');

export function startBot(store: Store, triggerRun: () => Promise<string>) {
  if (!cfg.telegramToken) { console.log('Kein TELEGRAM_BOT_TOKEN, Bot bleibt aus.'); return; }
  let offset = 0;
  const loop = async () => {
    for (;;) {
      try {
        const updates: any[] = await tg('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] });
        for (const u of updates) {
          offset = u.update_id + 1;
          // Nicht abwarten: Anschreiben und Formulare dauern, andere Klicks sollen trotzdem sofort gehen
          void handle(u, store, triggerRun).catch((e) => console.error('Update-Fehler:', e.message));
        }
      } catch (e) {
        console.error('Polling:', (e as Error).message);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  };
  void loop();
  void tg('setMyCommands', { commands: [
    { command: 'suche', description: 'Jetzt sofort suchen' },
    { command: 'status', description: 'Was bisher gefunden wurde' },
    { command: 'bewerbungen', description: 'Stand deiner Bewerbungen' },
    { command: 'pause', description: 'Keine Meldungen mehr' },
    { command: 'weiter', description: 'Meldungen wieder an' },
  ] }).catch(() => {});
}

async function handle(u: any, store: Store, triggerRun: () => Promise<string>) {
  const subs = await store.subscribers();
  if (u.callback_query) {
    const q = u.callback_query;
    const chatId = String(q.message?.chat?.id);
    if (!subs.some((s) => s.chat_id === chatId)) return;
    const [action, ref] = String(q.data).split(':');
    const answer = (text?: string) => tg('answerCallbackQuery', { callback_query_id: q.id, ...(text ? { text } : {}) }).catch(() => {});
    if (action === 'send' || action === 'stop') {
      await answer();
      if (action === 'stop') { cancelForm(ref); await tg('sendMessage', { chat_id: chatId, text: 'Abgebrochen, nichts wurde abgeschickt.' }); return; }
      const jobId = await store.kvGet(`ref:${ref}`);
      const result = await submitForm(store, chatId, ref);
      const job = jobId ? await store.getJob(jobId) : null;
      if (result === 'ok' && job) await markApplied(store, chatId, job, ref);
      else if (result === 'unklar') await tg('sendMessage', { chat_id: chatId, text: 'Wenn es geklappt hat, tipp hier:', reply_markup: { inline_keyboard: [[{ text: '✅ Ich habe mich beworben', callback_data: `ok:${ref}` }]] } });
      return;
    }
    const jobId = await store.kvGet(`ref:${ref}`);
    const job = jobId ? await store.getJob(jobId) : null;
    if (!job) { await answer('Stelle nicht mehr gefunden.'); return; }
    switch (action) {
      case 'gut':
      case 'schlecht':
        await store.setFeedback(job.id, action);
        await answer(action === 'gut' ? 'Gemerkt, mehr davon.' : 'Gemerkt, weniger davon.');
        return;
      case 'bew':
      case 'brief': // alte Knöpfe aus den ersten Meldungen
        await answer('Bereite die Bewerbung vor, dauert etwa 30 Sekunden.');
        await prepareApplication(store, chatId, job, ref);
        return;
      case 'form':
        await answer();
        await startForm(store, chatId, job, ref);
        return;
      case 'ok':
        await answer();
        await markApplied(store, chatId, job, ref);
        return;
      case 'ein':
      case 'abs':
      case 'nix':
        await answer();
        await handleOutcome(store, chatId, job, action);
        return;
    }
    return;
  }

  const m = u.message;
  if (!m?.text) return;
  const chatId = String(m.chat.id);
  const text: string = m.text.trim();
  const known = subs.some((s) => s.chat_id === chatId);

  if (text.startsWith('/start')) {
    const code = (text.split(/\s+/)[1] ?? '').trim();
    if (known) { await tg('sendMessage', { chat_id: chatId, text: HELP }); return; }
    if (!cfg.inviteCode || code !== cfg.inviteCode) {
      await tg('sendMessage', { chat_id: chatId, text: 'Dieser Bot ist privat. Bitte nutze den Einladungslink.' });
      return;
    }
    await store.addSubscriber(chatId, [m.from?.first_name, m.from?.last_name].filter(Boolean).join(' ') || null);
    await tg('sendMessage', { chat_id: chatId, text: `Hallo ${m.from?.first_name ?? ''}! Du bist angemeldet.\n\n${HELP}` });
    // Erst nachliefern, was andere schon bekommen haben, dann das noch Offene an alle
    const n = await sendBacklog(store, chatId);
    if (n) await tg('sendMessage', { chat_id: chatId, text: `Das waren die ${n} passenden Stellen der letzten 14 Tage. Ab jetzt kommen nur noch neue.` });
    await notifyPending(store);
    return;
  }
  if (!known) return;

  const replyTo = m.reply_to_message?.message_id;
  if (replyTo && !text.startsWith('/')) {
    if (await handleLetterReply(store, chatId, replyTo, text)) return;
    if (await handleFormReply(store, chatId, replyTo, text)) return;
  }

  if (text.startsWith('/bewerbungen')) {
    await tg('sendMessage', { chat_id: chatId, text: await listApplications(store) });
  } else if (text.startsWith('/suche')) {
    await tg('sendMessage', { chat_id: chatId, text: 'Ich suche jetzt, das dauert ein paar Minuten.' });
    await tg('sendMessage', { chat_id: chatId, text: await triggerRun() });
  } else if (text.startsWith('/status')) {
    const s = await store.stats();
    const last = await store.kvGet('last_run');
    await tg('sendMessage', {
      chat_id: chatId,
      text: [
        `Letzter Suchlauf: ${last ? new Date(last).toLocaleString('de-DE', { timeZone: 'Europe/Berlin' }) : 'noch keiner'}`,
        `Geprüfte Stellen: ${Object.entries(s).filter(([k]) => k !== 'gemeldet').reduce((a, [, n]) => a + n, 0)}`,
        `Passende Treffer: ${s.match ?? 0}, davon gemeldet: ${s.gemeldet ?? 0}`,
        `Bewertet, aber zu schwach: ${s.low ?? 0}`,
      ].join('\n'),
    });
  } else if (text.startsWith('/pause')) {
    await store.setPaused(chatId, true);
    await tg('sendMessage', { chat_id: chatId, text: 'Pausiert. Mit /weiter geht es wieder los.' });
  } else if (text.startsWith('/weiter')) {
    await store.setPaused(chatId, false);
    await tg('sendMessage', { chat_id: chatId, text: 'Läuft wieder.' });
    await notifyPending(store);
  } else {
    await tg('sendMessage', { chat_id: chatId, text: HELP });
  }
}
