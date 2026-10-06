// Dateien aus dem Chat: herunterladen, erkennen (Haiku liest PDF/Bild), in der Datenbank ablegen, für Formulare bereitstellen.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { cfg } from './config.ts';
import type { Store } from './store.ts';
import { button, esc, tg } from './tg.ts';

const client = new Anthropic({ apiKey: cfg.anthropicKey });

export const KINDS: Record<string, string> = {
  lebenslauf: 'Lebenslauf',
  immatrikulation: 'Immatrikulationsbescheinigung',
  zeugnis: 'Zeugnis',
  foto: 'Bewerbungsfoto',
  anschreiben: 'Anschreiben (Stilvorlage)',
  sonstiges: 'sonstiges Dokument',
};

// Nur eins je Art; Zeugnisse und Sonstiges dürfen mehrere sein
const SINGLE = new Set(['lebenslauf', 'immatrikulation', 'foto']);

async function download(fileId: string): Promise<Buffer> {
  const f = await tg('getFile', { file_id: fileId });
  const res = await fetch(`https://api.telegram.org/file/bot${cfg.telegramToken}/${f.file_path}`);
  if (!res.ok) throw new Error(`Download fehlgeschlagen (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

interface Guess { art: string; beschreibung: string; text?: string }

/** Haiku liest PDF oder Bild und ordnet ein. Word-Dateien nur nach Dateiname. */
async function classify(data: Buffer, mime: string, filename: string): Promise<Guess> {
  const byName = /lebenslauf|\bcv\b|resume/i.test(filename) ? 'lebenslauf' : /immatrik|studienbesch|enrol/i.test(filename) ? 'immatrikulation'
    : /zeugnis|reference/i.test(filename) ? 'zeugnis' : /anschreiben|cover/i.test(filename) ? 'anschreiben' : '';
  const readable = mime === 'application/pdf' || /^image\/(png|jpeg|webp|gif)$/.test(mime);
  if (!readable) return { art: byName || 'unklar', beschreibung: filename };
  const block = mime === 'application/pdf'
    ? { type: 'document' as const, source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: data.toString('base64') } }
    : { type: 'image' as const, source: { type: 'base64' as const, media_type: mime as 'image/png', data: data.toString('base64') } };
  const res = await client.messages.create({
    model: cfg.scoreModel,
    max_tokens: 3000,
    messages: [{ role: 'user', content: [block, { type: 'text', text: `Dateiname: ${filename}
Was ist das für ein Dokument eines Bewerbers? Antworte nur mit JSON:
{"art":"lebenslauf|immatrikulation|zeugnis|foto|anschreiben|sonstiges|unklar","beschreibung":"kurz, z.B. Arbeitszeugnis Opella 2026","text":"NUR bei art=anschreiben: der vollständige Brieftext ab der Anrede bis zum Namen, wörtlich"}
foto = Porträt-/Bewerbungsfoto. zeugnis = Arbeits-, Praktikums- oder Notenzeugnis/Transcript of Records.` }] }],
  });
  const raw = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  try {
    const g = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    return { art: KINDS[g.art] ? g.art : byName || 'unklar', beschreibung: String(g.beschreibung ?? filename), text: g.text };
  } catch {
    return { art: byName || 'unklar', beschreibung: filename };
  }
}

async function store1(store: Store, kind: string, filename: string, mime: string, data: Buffer, beschreibung: string) {
  const key = SINGLE.has(kind) ? kind : `${kind}:${createHash('sha1').update(data).digest('hex').slice(0, 10)}`;
  await store.saveDocument({ key, kind, filename: beschreibung ? `${beschreibung}|${filename}` : filename, mime }, data);
}

const CONFIRM: Record<string, string> = {
  lebenslauf: 'Neuer Lebenslauf übernommen, Kamerad. Geht ab jetzt bei jeder Bewerbung mit. Hat sich inhaltlich was geändert, sag mir was, dann passe ich auch die Anschreiben an.',
  immatrikulation: 'Immatrikulationsbescheinigung gesichert. Fragt ein Formular danach, lade ich sie mit hoch.',
  zeugnis: 'Zeugnis gesichert. Wo Formulare weitere Unterlagen wollen, kommt es mit rein.',
  foto: 'Bewerbungsfoto gesichert. Wo ein Formular ein Foto will, lade ich es hoch.',
  anschreiben: 'Anschreiben gelesen und als Stilvorlage übernommen. Die nächsten schreibe ich näher an deinem Ton.',
  sonstiges: 'Dokument abgelegt. Hochladen tue ich es nirgends von selbst, nur wenn du es mir für eine Bewerbung sagst.',
};

/** Eingehende Datei (document oder photo) verarbeiten. */
export async function handleUpload(store: Store, chatId: string, msg: any) {
  const doc = msg.document;
  const photo = msg.photo ? msg.photo[msg.photo.length - 1] : null;
  const fileId = doc?.file_id ?? photo?.file_id;
  const filename = doc?.file_name ?? 'foto.jpg';
  const mime = doc?.mime_type ?? 'image/jpeg';
  if ((doc?.file_size ?? photo?.file_size ?? 0) > 20 * 1024 * 1024) {
    await tg('sendMessage', { chat_id: chatId, text: 'Zu groß, Kamerad. Telegram lässt mich nur Dateien bis 20 MB holen.' });
    return;
  }
  await tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
  const data = await download(fileId);
  const g = await classify(data, mime, filename);
  if (g.art === 'unklar') {
    // Zwischenspeichern und nachfragen
    const n = Number((await store.kvGet('upload:next')) ?? '1');
    await store.kvSet('upload:next', String(n + 1));
    await store.saveDocument({ key: `wartet:${n}`, kind: 'wartet', filename, mime }, data);
    await tg('sendMessage', {
      chat_id: chatId,
      text: `Was ist „${esc(filename)}“, Kamerad?`,
      reply_markup: { inline_keyboard: [
        [button('Lebenslauf', `dk:${n}:lebenslauf`), button('Immatrikulation', `dk:${n}:immatrikulation`)],
        [button('Zeugnis', `dk:${n}:zeugnis`), button('Foto', `dk:${n}:foto`)],
        [button('Sonstiges', `dk:${n}:sonstiges`)],
      ] },
    });
    return;
  }
  // Bilder ohne Bewerbungsbezug (Screenshots, Logos …) nicht ablegen, sonst landen sie womöglich bei Arbeitgebern
  if (g.art === 'sonstiges' && mime.startsWith('image/')) {
    await tg('sendMessage', { chat_id: chatId, text: `Das sieht nicht nach einer Bewerbungsunterlage aus (${esc(g.beschreibung)}), deshalb lege ich es nicht ab. Bilder kann ich im Chat noch nicht auswerten, schreib mir deine Frage als Text.` });
    return;
  }
  if (g.art === 'anschreiben' && g.text && g.text.length > 200) await store.addLetterExample(g.text);
  await store1(store, g.art, filename, mime, data, g.beschreibung);
  await tg('sendMessage', { chat_id: chatId, text: CONFIRM[g.art] ?? CONFIRM.sonstiges });
}

/** Knopf aus der Rückfrage: Art festlegen und endgültig ablegen. */
export async function assignUpload(store: Store, chatId: string, n: string, kind: string) {
  const key = `wartet:${n}`;
  const data = await store.getDocumentData(key);
  const meta = (await store.listDocuments()).find((d) => d.key === key);
  if (!data || !meta || !KINDS[kind]) return;
  await store.deleteDocument(key);
  await store1(store, kind, meta.filename, meta.mime, data, '');
  await tg('sendMessage', { chat_id: chatId, text: CONFIRM[kind] ?? CONFIRM.sonstiges });
}

/** Alle Dokumente als Dateien bereitstellen (für Formular-Uploads und den Versand). Lebenslauf fällt auf die Datei im Repo zurück. */
export async function materialize(store: Store): Promise<Record<string, string[]>> {
  const dir = mkdtempSync(join(tmpdir(), 'unterlagen-'));
  const out: Record<string, string[]> = {};
  for (const d of await store.listDocuments()) {
    if (d.kind === 'wartet' || d.kind === 'anschreiben') continue;
    const data = await store.getDocumentData(d.key);
    if (!data) continue;
    const original = d.filename.split('|').pop() ?? d.filename;
    const ext = original.includes('.') ? original.slice(original.lastIndexOf('.')) : d.mime === 'application/pdf' ? '.pdf' : '.jpg';
    const name = d.kind === 'lebenslauf' ? `Lebenslauf_Martin_Spalevic${ext}` : d.kind === 'immatrikulation' ? `Immatrikulationsbescheinigung_Martin_Spalevic${ext}` : original;
    // Eigener Unterordner je Dokument, damit der Dateiname beim Arbeitgeber sauber bleibt
    const sub = join(dir, d.key.replace(/[^a-z0-9]/gi, '_'));
    mkdirSync(sub, { recursive: true });
    const path = join(sub, name);
    writeFileSync(path, data);
    (out[d.kind] ??= []).push(path);
  }
  if (!out.lebenslauf) {
    const repoCv = new URL('../data/docs/lebenslauf.pdf', import.meta.url).pathname;
    if (existsSync(repoCv)) out.lebenslauf = [repoCv];
  }
  // „weitere Unterlagen“: nur echte Bewerbungsunterlagen (Immatrikulation + Zeugnisse), nie „sonstiges“
  out.weitere = [...(out.immatrikulation ?? []), ...(out.zeugnis ?? [])];
  delete out.sonstiges;
  return out;
}

/** Kurzliste für den Chat-Agenten. */
export async function documentList(store: Store): Promise<string> {
  const docs = (await store.listDocuments()).filter((d) => d.kind !== 'wartet');
  return docs.length ? docs.map((d) => `${KINDS[d.kind] ?? d.kind}: ${d.filename.split('|')[0]}`).join('; ') : 'nur der Lebenslauf aus dem Start-Paket';
}
