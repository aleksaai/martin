import { UA } from './config.ts';

export async function fetchText(url: string, init: RequestInit = {}, timeoutMs = 25_000): Promise<string> {
  const res = await fetch(url, {
    ...init,
    headers: { 'User-Agent': UA, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} bei ${url}`);
  return res.text();
}

export async function fetchJson<T = any>(url: string, init: RequestInit = {}, timeoutMs = 25_000): Promise<T> {
  return JSON.parse(await fetchText(url, init, timeoutMs)) as T;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function stripHtml(html: string | undefined | null): string {
  if (!html) return '';
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|li|h\d|div)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}
