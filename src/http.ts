import { UA } from './config.ts';

export async function fetchText(url: string, init: RequestInit = {}, timeoutMs = 25_000): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      ...init,
      headers: { 'User-Agent': UA, 'Accept-Language': 'de-DE,de;q=0.9', ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Personio und Workable drosseln schnell: kurz warten, dann nochmal
    if ((res.status === 429 || res.status === 503) && attempt < 3) {
      const retryAfter = Number(res.headers.get('retry-after')) * 1000 || 4000 * (attempt + 1);
      // Cloudflare meldet bei IP-Sperren Retry-After von vielen Stunden: nicht warten, sondern klar scheitern
      if (retryAfter > 20_000) throw new Error(`${res.status} ${res.statusText} bei ${url} (gesperrt, Retry-After ${Math.round(retryAfter / 60000)} min)`);
      await sleep(retryAfter);
      continue;
    }
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} bei ${url}`);
    return res.text();
  }
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
