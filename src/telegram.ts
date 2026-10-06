// Telegram per Long Polling: kein Webhook, keine öffentliche Adresse nötig.
import { chat } from './agent.ts';
import { accountCreated, cancelForm, startForm, submitForm } from './apply.ts';
import { handleLetterReply, handleOutcome, markApplied, prepareApplication } from './bewerbung.ts';
import { overview } from './tracking.ts';
import { assignUpload, handleUpload } from './uploads.ts';
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

/** Beobachter (Aleksa): sieht die Meldungen, ändert aber nichts an Martins Daten. */
export async function isObserver(store: Store, chatId: string): Promise<boolean> {
  return (await store.kvGet(`role:${chatId}`)) === 'beobachter';
}

async function sendCard(chatId: string, j: StoredJob, ref: string, observer = false) {
  await tg('sendMessage', {
    chat_id: chatId,
    text: observer ? `👁 ${card(j)}` : card(j),
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    // Zwei Knöpfe: Bewerben zählt als "passt" (setzt das Feedback in prepareApplication), 👎 lernt das Gegenteil. Beobachter ohne Knöpfe.
    ...(observer ? {} : { reply_markup: { inline_keyboard: [[
      { text: '📨 Bewerben', callback_data: `bew:${ref}` },
      { text: '👎 Passt nicht', callback_data: `schlecht:${ref}` },
    ]] } }),
  }).catch((e) => console.error(e.message));
}

/** Wer neu dazukommt, bekommt die schon gemeldeten Treffer der letzten 14 Tage nachgeliefert. */
async function sendBacklog(store: Store, chatId: string): Promise<number> {
  const jobs = await store.recentMatches(14, 30);
  for (const j of jobs) await sendCard(chatId, j, await shortRef(store, j.id));
  // Für Martin sind sie neu: die 24-Stunden-Erinnerung zählt ab jetzt
  await store.touchNotified(jobs.map((j) => j.id));
  return jobs.length;
}

export async function notifyPending(store: Store): Promise<number> {
  if (!cfg.telegramToken) return 0;
  const subs = (await store.subscribers()).filter((s) => !s.paused);
  if (!subs.length) return 0;
  const jobs = await store.pending(cfg.maxPerRun);
  for (const j of jobs) {
    const ref = await shortRef(store, j.id);
    for (const s of subs) await sendCard(s.chat_id, j, ref, await isObserver(store, s.chat_id));
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
  'Melde mich zum Dienst, Kamerad. Ich suche dreimal täglich Werkstudentenstellen für dich, remote oder rund um Köln, und melde, was taugt.',
  '📨 Bewerben: Ich schreibe das Anschreiben und fülle auf Wunsch das Formular aus. Abgeschickt wird nur auf dein Kommando.',
  'Sonst einfach schreiben: Angaben fürs Formular, Gehaltsfragen, Änderungen am Anschreiben, oder „hab mich bei X beworben“, dann trage ich es ein.',
  'Unterlagen (Immatrikulation, Zeugnisse, Foto, neuer Lebenslauf) einfach als Datei schicken, ich erkenne und sichere sie.',
  '',
  '/suche  jetzt suchen  ·  /bewerbungen  Lagebericht  ·  /pause  ·  /weiter',
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
          // Different chats can proceed concurrently; handle serializes each chat, including buttons.
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
    { command: 'bewerbungen', description: 'Lagebericht deiner Bewerbungen' },
    { command: 'pause', description: 'Keine Meldungen mehr' },
    { command: 'beobachter', description: 'Nur mitlesen (für Aleksa)' },
    { command: 'weiter', description: 'Meldungen wieder an' },
  ] }).catch(() => {});
}

// Callback clicks and chat messages share one queue: opening a second form cannot close
// a browser while the first operation is still filling it.
const updateQueues = new Map<string, Promise<void>>();
export function handle(u: any, store: Store, triggerRun: () => Promise<string>): Promise<void> {
  const chatId = String(u.message?.chat?.id ?? u.callback_query?.message?.chat?.id ?? 'unknown');
  if (u.callback_query) void tg('answerCallbackQuery', { callback_query_id: u.callback_query.id }).catch(() => {});
  const task = (updateQueues.get(chatId) ?? Promise.resolve()).catch(() => {}).then(() => handleUpdate(u, store, triggerRun));
  updateQueues.set(chatId, task);
  void task.finally(() => { if (updateQueues.get(chatId) === task) updateQueues.delete(chatId); }).catch(() => {});
  return task;
}
async function handleUpdate(u: any, store: Store, triggerRun: () => Promise<string>) {
  const subs = await store.subscribers();
  if (u.callback_query) {
    const q = u.callback_query;
    const chatId = String(q.message?.chat?.id);
    if (!subs.some((s) => s.chat_id === chatId)) return;
    if (await isObserver(store, chatId)) {
      await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Beobachter-Modus: entscheiden kann hier nur Martin.' }).catch(() => {});
      return;
    }
    if (String(q.data).startsWith('dk:')) {
      const [, n, kind] = String(q.data).split(':');
      await tg('answerCallbackQuery', { callback_query_id: q.id }).catch(() => {});
      await assignUpload(store, chatId, n, kind);
      return;
    }
    const [action, ref, review] = String(q.data).split(':');
    const answer = (text?: string) => tg('answerCallbackQuery', { callback_query_id: q.id, ...(text ? { text } : {}) }).catch(() => {});
    if (action === 'send' || action === 'stop') {
      await answer();
      if (action === 'stop') { cancelForm(ref, chatId); await tg('sendMessage', { chat_id: chatId, text: 'Abgebrochen, nichts wurde abgeschickt.' }); return; }
      const jobId = await store.kvGet(`ref:${ref}`);
      const result = await submitForm(store, chatId, ref, review);
      const job = jobId ? await store.getJob(jobId) : null;
      if (result === 'ok' && job) await markApplied(store, chatId, job, ref, 'adolf');
      else if (result === 'unklar') await tg('sendMessage', { chat_id: chatId, text: 'Wenn es geklappt hat, tipp hier:', reply_markup: { inline_keyboard: [[{ text: '✅ Ich habe mich beworben', callback_data: `ok:${ref}` }]] } });
      return;
    }
    if (action === 'acct') {
      await answer('Super, ich melde mich jetzt an.');
      const p = await accountCreated(store, chatId);
      const job = p ? await store.getJob(p.jobId) : null;
      if (job && p) await startForm(store, chatId, job, p.ref);
      return;
    }
    if (action === 'acctown') {
      await answer();
      await tg('sendMessage', { chat_id: chatId, text: 'Dann schreib mir einfach E-Mail und Passwort für das Portal. Ich speichere sie verschlüsselt und lösche deine Nachricht direkt danach aus dem Chat.' });
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
        await store.kvSet(`active_job:${chatId}`, job.id);
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
  if (m && (m.document || m.photo)) {
    const fromId = String(m.chat.id);
    if (!subs.some((x) => x.chat_id === fromId)) return;
    if (await isObserver(store, fromId)) {
      await tg('sendMessage', { chat_id: fromId, text: 'Beobachter-Modus: Unterlagen schickt Martin in seinem Chat.' });
      return;
    }
    const reactOn = (on: boolean) => tg('setMessageReaction', { chat_id: fromId, message_id: m.message_id, reaction: on ? [{ type: 'emoji', emoji: '👀' }] : [] }).catch(() => {});
    await reactOn(true);
    try {
      await handleUpload(store, fromId, m);
      // Bildunterschrift mit Anweisung („das ist mein neues Zeugnis, nimm es für REWE“) geht danach an den Chat
      if (m.caption) await chat(store, fromId, `(Martin hat gerade eine Datei geschickt, sie ist gespeichert.) ${m.caption}`, m.message_id);
    } catch (e) {
      await tg('sendMessage', { chat_id: fromId, text: `Die Datei konnte ich nicht verarbeiten (${(e as Error).message.slice(0, 80)}). Nochmal schicken, am besten als PDF.` });
    } finally {
      await reactOn(false);
    }
    return;
  }
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
    // Erste Anmeldung nach der Testphase (Aleksa war Testnutzer): Testdaten weg, Test-Chats pausieren, ab jetzt echter Betrieb
    const firstReal = !(await store.kvGet('live_since'));
    if (firstReal) {
      const all = (await store.subscribers()).filter((x) => x.chat_id !== chatId);
      const observers: string[] = [];
      for (const x of all) if (await isObserver(store, x.chat_id)) observers.push(x.chat_id);
      const others = all.filter((x) => !x.paused && !observers.includes(x.chat_id));
      await store.resetTestData(chatId);
      for (const o of observers) await store.setPaused(o, false);
      await store.kvSet('live_since', new Date().toISOString());
      for (const o of others) {
        await tg('sendMessage', { chat_id: o.chat_id, text: 'Martin ist jetzt angemeldet, der Testbetrieb ist beendet. Deine Testdaten sind gelöscht und dieser Chat ist pausiert. Mit /beobachter liest du mit, ohne etwas zu verändern.' }).catch(() => {});
      }
      for (const o of observers) await tg('sendMessage', { chat_id: o, text: '👁 Martin ist angemeldet, ab jetzt läuft der echte Betrieb. Du siehst seine Meldungen als Beobachter.' }).catch(() => {});
    }
    await store.addSubscriber(chatId, [m.from?.first_name, m.from?.last_name].filter(Boolean).join(' ') || null);
    await tg('sendMessage', { chat_id: chatId, text: `Willkommen an Bord, ${m.from?.first_name ?? 'Kamerad'}!\n\n${HELP}` });
    // Erst nachliefern, was andere schon bekommen haben, dann das noch Offene an alle
    const n = await sendBacklog(store, chatId);
    if (n) await tg('sendMessage', { chat_id: chatId, text: `Das waren ${n} passende Stellen aus den letzten zwei Wochen. Ab jetzt melde ich nur noch Neues, dreimal am Tag. Abmarsch, Kamerad!` });
    await notifyPending(store);
    return;
  }
  if (!known) return;

  // 👀 zeigt sofort, dass die Nachricht angekommen ist; verschwindet mit der Antwort
  const react = (on: boolean) => tg('setMessageReaction', { chat_id: chatId, message_id: m.message_id, reaction: on ? [{ type: 'emoji', emoji: '👀' }] : [] }).catch(() => {});
  if (text.startsWith('/beobachter')) {
    await store.kvSet(`role:${chatId}`, 'beobachter');
    await store.setPaused(chatId, false);
    await tg('sendMessage', { chat_id: chatId, text: '👁 Beobachter-Modus an. Du bekommst dieselben Meldungen wie Martin, aber ohne Knöpfe, und nichts, was du hier tust, verändert seine Daten. Frag mich jederzeit nach dem Lagebericht. /pause stoppt die Meldungen, /weiter holt sie zurück.' });
    return;
  }
  const observer = await isObserver(store, chatId);
  if (!text.startsWith('/')) {
    await react(true);
    try {
      const replyTo = m.reply_to_message?.message_id;
      if (!observer && replyTo && (await handleLetterReply(store, chatId, replyTo, text))) return;
      // Alles, was kein Befehl ist, geht an den Chat-Assistenten (Formular ergänzen, Beratung, Gedächtnis, Konten)
      await chat(store, chatId, text, m.message_id, observer, replyTo);
    } finally {
      await react(false);
    }
    return;
  }

  if (text.startsWith('/bewerbungen')) {
    await tg('sendMessage', { chat_id: chatId, text: await overview(store) });
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
