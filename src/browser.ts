// PDF work and interactive forms have separate lifetimes. Active leases never time out.
import { chromium, type Browser, type BrowserContext, type BrowserContextOptions } from 'playwright';

export class BrowserPool {
  private current: Promise<Browser> | null = null;
  private users = 0;
  private idle: NodeJS.Timeout | null = null;
  constructor(private idleMs = 10 * 60_000) {}

  async acquire(): Promise<{ browser: Browser; release: () => void }> {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    this.users++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (--this.users === 0) {
        const owned = this.current;
        this.idle = setTimeout(() => {
          if (this.users || this.current !== owned) return;
          this.current = null;
          void owned?.then(b => b.close()).catch(() => {});
        }, this.idleMs);
        this.idle.unref();
      }
    };
    try {
      if (!this.current) {
        const launch = chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
        this.current = launch;
        void launch.then(b => b.on('disconnected', () => { if (this.current === launch) this.current = null; })).catch(() => { if (this.current === launch) this.current = null; });
      }
      return { browser: await this.current, release };
    } catch (e) { release(); throw e; }
  }
}
const pdfPool = new BrowserPool();
const formPool = new BrowserPool();

export async function withBrowser<T>(fn: (b: Browser) => Promise<T>): Promise<T> {
  const lease = await pdfPool.acquire();
  try { return await fn(lease.browser); } finally { lease.release(); }
}

export async function createFormContext(options: BrowserContextOptions = {}): Promise<BrowserContext> {
  const lease = await formPool.acquire();
  try {
    const context = await lease.browser.newContext(options);
    context.once('close', lease.release);
    return context;
  } catch (e) { lease.release(); throw e; }
}
