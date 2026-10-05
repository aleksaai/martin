// Telegram per Long Polling: kein Webhook, keine öffentliche Adresse nötig.
import { cfg } from './config.ts';
import { writeLetter } from './llm.ts';
import type { Store } from './store.ts';
import type { StoredJob } from './types.ts';

const API = `https://api.telegram.org/bot${cfg.telegramToken}`;

async function tg(method: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(70_000),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram ${method}: ${json.description}`);
  return json.result;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// callback_data darf höchstens 64 Bytes haben, Job-IDs sind länger: kurze Nummer statt ID
async function shortRef(store: Store, jobId: string): Promise<string> {
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
    reply_markup: { inline_keyboard: [[
      { text: '👍 Passt', callback_data: `gut:${ref}` },
      { text: '👎 Passt nicht', callback_data: `schlecht:${ref}` },
      { text: '✍️ Anschreiben', callback_data: `brief:${ref}` },
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
  'Neue passende Stellen schicke ich dir sofort. Mit 👍/👎 lerne ich, was dir gefällt. ✍️ schreibt dir einen Anschreiben-Entwurf.',
  '',
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
          await handle(u, store, triggerRun).catch((e) => console.error('Update-Fehler:', e.message));
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
    const jobId = await store.kvGet(`ref:${ref}`);
    const job = jobId ? await store.getJob(jobId) : null;
    if (!job) { await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Stelle nicht mehr gefunden.' }); return; }
    if (action === 'gut' || action === 'schlecht') {
      await store.setFeedback(job.id, action);
      await tg('answerCallbackQuery', { callback_query_id: q.id, text: action === 'gut' ? 'Gemerkt, mehr davon.' : 'Gemerkt, weniger davon.' });
      return;
    }
    if (action === 'brief') {
      await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Schreibe den Entwurf, dauert etwa 20 Sekunden.' });
      await tg('sendChatAction', { chat_id: chatId, action: 'typing' });
      const letter = await writeLetter(job);
      await tg('sendMessage', {
        chat_id: chatId,
        text: `✍️ Entwurf für <b>${esc(job.title)}</b> bei ${esc(job.company)}:\n\n${esc(letter)}\n\n<i>Bitte prüfen und die Platzhalter in [Klammern] füllen.</i>`,
        parse_mode: 'HTML',
        reply_parameters: { message_id: q.message.message_id },
      });
      await store.setFeedback(job.id, 'gut');
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

  if (text.startsWith('/suche')) {
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
