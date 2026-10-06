// Ein gemeinsamer Chromium für PDFs und Formulare. Startet erst bei Bedarf und schließt nach 10 Minuten ohne Nutzung.
import { chromium, type Browser } from 'playwright';

let browser: Browser | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let users = 0;

export async function withBrowser<T>(fn: (b: Browser) => Promise<T>): Promise<T> {
  users++;
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  try {
    if (!browser || !browser.isConnected()) browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    return await fn(browser);
  } finally {
    users--;
    if (users === 0) {
      idleTimer = setTimeout(() => { void browser?.close(); browser = null; }, 10 * 60_000);
    }
  }
}

/** Für Formular-Sitzungen, die zwischen zwei Telegram-Klicks offen bleiben. */
export async function getBrowser(): Promise<Browser> {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (!browser || !browser.isConnected()) browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  return browser;
}
