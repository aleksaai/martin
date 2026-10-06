// Zugangsdaten für Bewerberportale (z.B. SuccessFactors, Workday), verschlüsselt in der Datenbank.
// Schlüssel aus VAULT_KEY oder ersatzweise aus dem Bot-Token abgeleitet: ohne Railway-Variablen ist nichts lesbar.
import { createCipheriv, createDecipheriv, randomBytes, randomInt, scryptSync } from 'node:crypto';
import { cfg } from './config.ts';
import type { Store } from './store.ts';

const key = () => scryptSync(process.env.VAULT_KEY || cfg.telegramToken || 'nur-lokal', 'martin-jobradar-vault', 32);

function encrypt(text: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}

function decrypt(blob: string): string {
  const [iv, tag, enc] = blob.split('.').map((s) => Buffer.from(s, 'base64'));
  const d = createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

/** Portal-Schlüssel: Hostname ohne www, bei SuccessFactors/Workday inkl. Firmenkennung, weil jede Firma eigene Konten hat. */
export function portalKey(url: string): string {
  const u = new URL(url);
  const host = u.hostname.replace(/^www\./, '');
  const company = u.searchParams.get('company');
  if (/successfactors/.test(host) && company) return `${host}?company=${company}`;
  return host;
}

export interface Credential { portal: string; username: string; password: string; status: 'wartet' | 'aktiv' }

export async function getCredential(store: Store, portal: string): Promise<Credential | null> {
  const raw = await store.kvGet(`cred:${portal}`);
  if (!raw) return null;
  try { return JSON.parse(decrypt(raw)); } catch { return null; }
}

export async function saveCredential(store: Store, cred: Credential) {
  await store.kvSet(`cred:${cred.portal}`, encrypt(JSON.stringify(cred)));
}

/** Starkes, gut abtippbares Passwort (keine verwechselbaren Zeichen), erfüllt übliche Portalregeln. */
export function generatePassword(): string {
  const pick = (s: string) => s[randomInt(s.length)];
  const lower = 'abcdefghjkmnpqrstuvwxyz', upper = 'ABCDEFGHJKMNPQRSTUVWXYZ', digit = '23456789', sym = '!?#+';
  const body = Array.from({ length: 12 }, () => pick(lower + upper + digit));
  return [pick(upper), ...body, pick(digit), pick(sym), pick(lower)].join('');
}
