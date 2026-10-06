// Freier Chat mit Martin: Bewerbungs-Assistent mit Werkzeugen (Formular ergänzen, Anschreiben ändern, Gedächtnis, Websuche).
// Absenden kann der Chat nie, das bleibt beim Knopf "✅ Absenden".
import Anthropic from '@anthropic-ai/sdk';
import { activeForm, refillForm, startForm } from './apply.ts';
import { reviseAndSend } from './bewerbung.ts';
import { cfg } from './config.ts';
import { PROFILE } from './llm.ts';
import type { Store } from './store.ts';
import { tg } from './tg.ts';

const client = new Anthropic({ apiKey: cfg.anthropicKey });
const HISTORY = 24;

type Msg = { role: 'user' | 'assistant'; content: string };

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'formular_ergaenzen',
    description: 'Trägt Martins Angaben ins gerade offene Bewerbungsformular ein, füllt neu aus und schickt ihm automatisch einen neuen Screenshot. Angaben in natürlicher Sprache, z.B. "Gehaltswunsch 14.000 € brutto im Jahr, Start 1.11.2026, 20 Stunden pro Woche, Mo bis Mi, Studium Teilzeit".',
    input_schema: { type: 'object' as const, properties: { angaben: { type: 'string' } }, required: ['angaben'] },
  },
  {
    name: 'formular_oeffnen',
    description: 'Öffnet das Bewerbungsformular der aktuellen Bewerbung (neu), füllt es mit allen bekannten und gespeicherten Angaben aus und schickt einen Screenshot. Für "bewirb mich", "mach das Formular nochmal auf". Schickt NICHT ab. Optional zusätzliche Angaben mitgeben.',
    input_schema: { type: 'object' as const, properties: { angaben: { type: 'string' } } },
  },
  {
    name: 'anschreiben_aendern',
    description: 'Ändert das Anschreiben der aktuellen Bewerbung nach Martins Wunsch und schickt das neue PDF. Für ganze eigene Fassungen den kompletten Text als wunsch übergeben.',
    input_schema: { type: 'object' as const, properties: { wunsch: { type: 'string' } }, required: ['wunsch'] },
  },
  {
    name: 'merken',
    description: 'Speichert eine Angabe dauerhaft in Martins Profil-Datenbank (fließt in alle künftigen Anschreiben und Formulare ein). NUR aufrufen, wenn Martin ausdrücklich zugestimmt hat.',
    input_schema: { type: 'object' as const, properties: { fakt: { type: 'string', description: 'Ein Satz, z.B. "Frühester Starttermin: 1.11.2026"' } }, required: ['fakt'] },
  },
  {
    name: 'vergessen',
    description: 'Löscht gespeicherte Angaben, die das Stichwort enthalten.',
    input_schema: { type: 'object' as const, properties: { stichwort: { type: 'string' } }, required: ['stichwort'] },
  },
];

function system(context: string): string {
  return `Du bist Martins Bewerbungs-Assistent im Telegram-Chat. Martin sucht eine Werkstudentenstelle im Wirtschaftsrecht.

Schreib wie ein Mensch im Messenger: kurz, meist ein bis drei Sätze, du-Form, Deutsch, kein Markdown, keine Überschriften,
Listen nur wenn es wirklich mehrere Punkte sind, keine Floskeln, keine Gedankenstriche. Ergebnis zuerst.

Was du tun kannst:
- Nach formular_oeffnen/formular_ergaenzen hat Martin schon den Screenshot samt Text, was fehlt. Wiederhole das nicht.
  Antworte höchstens mit einem kurzen Satz, z.B. eine gezielte Rückfrage zum ersten offenen Punkt, oder gar nicht.
- Das Bewerbungsformular öffnen bzw. nach Ablauf neu öffnen (formular_oeffnen). Ist keins offen und Martin macht Angaben dafür, öffne es direkt mit diesen Angaben, statt ihn zum Knopf zu schicken.
- Offene Bewerbungsformulare mit seinen Angaben ergänzen (formular_ergaenzen). Danach schickt das System selbst einen Screenshot,
  du antwortest dann höchstens mit einem kurzen Satz oder einer Rückfrage.
- Das Anschreiben der aktuellen Bewerbung ändern (anschreiben_aendern).
- Angaben dauerhaft merken (merken) und löschen (vergessen). Gibt Martin etwas an, das auch für spätere Bewerbungen gilt
  (Starttermin, Wochenstunden, Arbeitstage, Gehaltswunsch, Studium Voll-/Teilzeit, Führerschein ...), frag am Ende kurz,
  ob du dir das merken sollst. merken erst nach seinem Ja. Gespeichertes trägt das System bei jedem künftigen Formular und
  Anschreiben automatisch ein, Martin muss es nie wiederholen.
- Im Web recherchieren (web_search), z.B. übliche Werkstudentenvergütung für Rolle, Branche, Region und Unternehmensgröße.
  Bei Gehaltsfragen: Spanne nennen, eine konkrete Empfehlung mit einem Satz Begründung. Formulare fragen oft Jahresbrutto:
  Stundenlohn × Wochenstunden × 52. Nenne nur Zahlen, die du in der Recherche wirklich gefunden hast, Quelle in drei Wörtern.
- Einschätzungen und Tipps zu Stellen, Firmen und Bewerbungen geben.

Grenzen: Abschicken kannst du nicht, das macht Martin mit dem Knopf „Absenden“ unter dem Screenshot. Erfinde nichts über Martin.
Wenn kein Formular offen ist und er Angaben macht, biete an, sie dir zu merken.

Martins Profil:
${PROFILE}

${context}`;
}

async function contextBlock(store: Store, chatId: string): Promise<string> {
  const facts = (await store.kvGet('answers')) ?? '';
  const form = activeForm(chatId);
  const jobId = await store.kvGet(`active_job:${chatId}`);
  const job = jobId ? await store.getJob(jobId) : null;
  const app = job ? await store.getApplication(job.id) : null;
  return [
    `Gespeicherte Angaben von Martin:\n${facts || '(noch keine)'}`,
    job ? `Aktuelle Bewerbung: ${job.title} bei ${job.company} (${job.location}). Status: ${app?.status ?? 'nur angesehen'}.\nAnzeige (Auszug):\n${(job.description ?? '').slice(0, 2500)}` : 'Keine aktuelle Bewerbung.',
    form ? `Offenes Formular: ${form.title} bei ${form.company}. Noch offen: ${form.offen.join(', ') || 'nichts'}. Bisher von Martin nachgereicht: ${form.filledWith || '-'}` : 'Kein Formular offen.',
  ].join('\n\n');
}

async function runTool(store: Store, chatId: string, name: string, input: any): Promise<string> {
  switch (name) {
    case 'formular_ergaenzen': {
      const r = await refillForm(store, chatId, String(input.angaben ?? ''));
      if (!r) return 'Kein Formular offen (nach 20 Minuten wird es geschlossen). Martin kann unter der Stelle erneut auf „Für mich bewerben“ tippen.';
      return r.ok ? `Neu ausgefüllt, Screenshot mit Text ist schon raus. Noch offen: ${r.offen.join(', ') || 'nichts, Absenden-Knopf ist da'}.` : `Fehlgeschlagen: ${r.note}`;
    }
    case 'formular_oeffnen': {
      const jobId = await store.kvGet(`active_job:${chatId}`);
      const job = jobId ? await store.getJob(jobId) : null;
      if (!job) return 'Keine aktuelle Bewerbung. Martin soll erst unter einer Stelle auf „📨 Bewerben“ tippen.';
      const { shortRef } = await import('./telegram.ts');
      const r = await startForm(store, chatId, job, await shortRef(store, job.id), String(input.angaben ?? ''));
      if (!r?.ok) return `Kein Formular ausgefüllt: ${r?.note ?? 'unbekannt'}. Martin hat dazu schon eine Nachricht bekommen.`;
      return `Ausgefüllt, Screenshot mit Text ist schon raus (Martin sieht dort auch, was fehlt). Noch offen: ${r.offen.join(', ') || 'nichts'}. ${r.offen.length ? 'Absenden-Knopf gibt es erst, wenn nichts mehr offen ist.' : 'Absenden-Knopf ist da.'}`;
    }
    case 'anschreiben_aendern': {
      const jobId = await store.kvGet(`active_job:${chatId}`);
      if (!jobId) return 'Keine aktuelle Bewerbung.';
      await reviseAndSend(store, chatId, jobId, String(input.wunsch ?? ''));
      return 'Neues PDF ist raus.';
    }
    case 'merken': {
      const prev = (await store.kvGet('answers')) ?? '';
      const fakt = String(input.fakt ?? '').trim();
      if (fakt) await store.kvSet('answers', [prev, fakt].filter(Boolean).join('\n').slice(-3000));
      return 'Gespeichert.';
    }
    case 'vergessen': {
      const word = String(input.stichwort ?? '').toLowerCase();
      const lines = ((await store.kvGet('answers')) ?? '').split('\n');
      const keep = lines.filter((l) => !l.toLowerCase().includes(word));
      await store.kvSet('answers', keep.join('\n'));
      return `${lines.length - keep.length} Angabe(n) gelöscht.`;
    }
  }
  return 'Unbekanntes Werkzeug.';
}

// Ein Durchlauf je Chat gleichzeitig, damit Nachrichten in Reihenfolge beantwortet werden
const queues = new Map<string, Promise<unknown>>();

export function chat(store: Store, chatId: string, text: string): Promise<void> {
  const prev = queues.get(chatId) ?? Promise.resolve();
  const next = prev.then(() => turn(store, chatId, text)).catch((e) => {
    console.error('Chat-Fehler:', e);
    return tg('sendMessage', { chat_id: chatId, text: 'Da ist bei mir gerade etwas schiefgelaufen, versuch es bitte gleich nochmal.' }).catch(() => {});
  });
  queues.set(chatId, next);
  return next.then(() => {});
}

async function turn(store: Store, chatId: string, text: string) {
  const history: Msg[] = JSON.parse((await store.kvGet(`hist:${chatId}`)) ?? '[]');
  const messages: any[] = [...history.map((m) => ({ role: m.role, content: m.content })), { role: 'user', content: text }];
  const sys = system(await contextBlock(store, chatId));
  const typing = setInterval(() => void tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {}), 4500);
  void tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
  let reply = '';
  try {
    for (let i = 0; i < 8; i++) {
      const res = await client.messages.create({
        model: cfg.letterModel,
        max_tokens: 8000,
        system: sys,
        tools: [...TOOLS, { type: 'web_search_20250305', name: 'web_search', max_uses: 4 } as never],
        messages,
      });
      messages.push({ role: 'assistant', content: res.content });
      if (res.stop_reason === 'pause_turn') continue;
      const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
      if (res.stop_reason !== 'tool_use' || !uses.length) {
        reply = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
        break;
      }
      const results = [];
      for (const u of uses) results.push({ type: 'tool_result', tool_use_id: u.id, content: await runTool(store, chatId, u.name, u.input) });
      messages.push({ role: 'user', content: results });
    }
  } finally {
    clearInterval(typing);
  }
  reply = reply.replace(/\s*[—–]\s*/g, ', ').replace(/\*\*(.+?)\*\*/g, '$1');
  if (reply) await tg('sendMessage', { chat_id: chatId, text: reply.slice(0, 4000), link_preview_options: { is_disabled: true } });
  const saved: Msg[] = [...history, { role: 'user' as const, content: text }, { role: 'assistant' as const, content: reply || '(Werkzeug ausgeführt)' }].slice(-HISTORY);
  await store.kvSet(`hist:${chatId}`, JSON.stringify(saved));
}
