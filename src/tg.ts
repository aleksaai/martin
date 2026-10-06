// Dünne Hülle um die Telegram Bot API.
import { cfg } from './config.ts';

const API = () => `https://api.telegram.org/bot${cfg.telegramToken}`;

export async function tg(method: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${API()}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(70_000),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram ${method}: ${json.description}`);
  return json.result;
}

/** Datei oder Bild hochladen (sendDocument / sendPhoto). */
export async function tgFile(
  method: 'sendDocument' | 'sendPhoto',
  chatId: string,
  file: Buffer,
  filename: string,
  extra: Record<string, unknown> = {},
): Promise<any> {
  const form = new FormData();
  form.set('chat_id', chatId);
  const field = method === 'sendPhoto' ? 'photo' : 'document';
  const type = filename.endsWith('.pdf') ? 'application/pdf' : filename.endsWith('.png') ? 'image/png' : 'image/jpeg';
  form.set(field, new Blob([new Uint8Array(file)], { type }), filename);
  for (const [k, v] of Object.entries(extra)) form.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  const res = await fetch(`${API()}/${method}`, { method: 'POST', body: form, signal: AbortSignal.timeout(120_000) });
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram ${method}: ${json.description}`);
  return json.result;
}

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function button(text: string, data: string) {
  return { text, callback_data: data };
}
