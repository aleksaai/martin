// Ablage: Postgres auf Railway (DATABASE_URL), lokal eine JSON-Datei zum Testen.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import pg from 'pg';
import { cfg } from './config.ts';
import type { StoredJob } from './types.ts';

export interface Subscriber { chat_id: string; name: string | null; paused: boolean }

export interface Application {
  job_id: string;
  status: 'entwurf' | 'beworben' | 'einladung' | 'absage' | 'zusage' | 'zurueckgezogen';
  letter: string | null;
  applied_at: string | null;
  followup_at: string | null;
  followups: number;
  /** Wie beworben: adolf (Formular), mail, portal, linkedin, sonstiges */
  channel?: string | null;
  /** Freitext, z.B. Absagegrund oder Gesprächsnotiz */
  notes?: string | null;
}

export type ApplicationRow = Application & { title: string; company: string; source: string };

export interface Store {
  init(): Promise<void>;
  known(id: string, key: string): Promise<boolean>;
  saveJob(job: StoredJob & { dedupe_key: string }): Promise<void>;
  getJob(id: string): Promise<StoredJob | null>;
  pending(limit: number): Promise<StoredJob[]>;
  pendingCount(): Promise<number>;
  recentMatches(days: number, limit: number): Promise<StoredJob[]>;
  markNotified(id: string): Promise<void>;
  setFeedback(id: string, feedback: string): Promise<void>;
  recentFeedback(n: number): Promise<{ title: string; company: string; feedback: string }[]>;
  subscribers(): Promise<Subscriber[]>;
  addSubscriber(chatId: string, name: string | null): Promise<void>;
  setPaused(chatId: string, paused: boolean): Promise<void>;
  getApplication(jobId: string): Promise<Application | null>;
  upsertApplication(a: Partial<Application> & { job_id: string }): Promise<void>;
  dueFollowups(): Promise<Application[]>;
  applicationsByStatus(): Promise<Record<string, number>>;
  listApplications(): Promise<ApplicationRow[]>;
  /** Stellen nach Firma oder Titel finden (für "hab mich bei X beworben"). */
  findJobs(query: string, limit: number): Promise<StoredJob[]>;
  /** Gemeldete Treffer ohne Reaktion (kein 👎, keine Bewerbung) seit mindestens `hours` Stunden. */
  undecided(hours: number, limit: number): Promise<StoredJob[]>;
  addLetterExample(text: string): Promise<void>;
  letterExamples(n: number): Promise<string[]>;
  kvGet(key: string): Promise<string | null>;
  kvSet(key: string, value: string): Promise<void>;
  stats(): Promise<Record<string, number>>;
}

const now = () => new Date().toISOString();

class PgStore implements Store {
  private pool = new pg.Pool({ connectionString: cfg.databaseUrl, ssl: /railway\.internal|localhost/.test(cfg.databaseUrl) ? false : { rejectUnauthorized: false } });

  async init() {
    await this.pool.query(`
      create table if not exists jobs (
        id text primary key, dedupe_key text not null, source text not null, company text not null, title text not null,
        location text, distance_km int, mode text, url text, description text,
        status text not null, skip_reason text, score int, reason text,
        first_seen timestamptz not null default now(), notified_at timestamptz, feedback text
      );
      create index if not exists jobs_dedupe on jobs (dedupe_key);
      create index if not exists jobs_pending on jobs (status, notified_at);
      create table if not exists subscribers (chat_id text primary key, name text, paused boolean not null default false, created_at timestamptz not null default now());
      create table if not exists kv (key text primary key, value text not null);
      create table if not exists applications (
        job_id text primary key, status text not null default 'entwurf', letter text,
        applied_at timestamptz, followup_at timestamptz, followups int not null default 0
      );
      alter table applications add column if not exists channel text;
      alter table applications add column if not exists notes text;
      create table if not exists letter_examples (id serial primary key, text text not null, created_at timestamptz not null default now());
    `);
  }
  async known(id: string, key: string) {
    const r = await this.pool.query('select 1 from jobs where id = $1 or dedupe_key = $2 limit 1', [id, key]);
    return (r.rowCount ?? 0) > 0;
  }
  async saveJob(j: StoredJob & { dedupe_key: string }) {
    await this.pool.query(
      `insert into jobs (id, dedupe_key, source, company, title, location, distance_km, mode, url, description, status, skip_reason, score, reason, first_seen)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) on conflict (id) do nothing`,
      [j.id, j.dedupe_key, j.source, j.company, j.title, j.location, j.distance_km, j.mode, j.url, j.description, j.status, j.skip_reason, j.score, j.reason, j.first_seen],
    );
  }
  async getJob(id: string) {
    const r = await this.pool.query('select * from jobs where id = $1', [id]);
    return (r.rows[0] as StoredJob) ?? null;
  }
  async pending(limit: number) {
    const r = await this.pool.query(`select * from jobs where status = 'match' and notified_at is null order by score desc, first_seen asc limit $1`, [limit]);
    return r.rows as StoredJob[];
  }
  async pendingCount() {
    const r = await this.pool.query(`select count(*)::int as n from jobs where status = 'match' and notified_at is null`);
    return r.rows[0].n as number;
  }
  async recentMatches(days: number, limit: number) {
    const r = await this.pool.query(
      `select * from jobs where status = 'match' and notified_at is not null and notified_at > now() - make_interval(days => $1)
       order by score desc, first_seen desc limit $2`, [days, limit]);
    return r.rows as StoredJob[];
  }
  async markNotified(id: string) {
    await this.pool.query('update jobs set notified_at = now() where id = $1', [id]);
  }
  async setFeedback(id: string, feedback: string) {
    await this.pool.query('update jobs set feedback = $2 where id = $1', [id, feedback]);
  }
  async recentFeedback(n: number) {
    const r = await this.pool.query('select title, company, feedback from jobs where feedback is not null order by notified_at desc nulls last limit $1', [n]);
    return r.rows;
  }
  async subscribers() {
    return (await this.pool.query('select chat_id, name, paused from subscribers')).rows as Subscriber[];
  }
  async addSubscriber(chatId: string, name: string | null) {
    await this.pool.query('insert into subscribers (chat_id, name) values ($1,$2) on conflict (chat_id) do update set paused = false', [chatId, name]);
  }
  async setPaused(chatId: string, paused: boolean) {
    await this.pool.query('update subscribers set paused = $2 where chat_id = $1', [chatId, paused]);
  }
  async getApplication(jobId: string) {
    const r = await this.pool.query('select * from applications where job_id = $1', [jobId]);
    return (r.rows[0] as Application) ?? null;
  }
  async upsertApplication(a: Partial<Application> & { job_id: string }) {
    const cur = (await this.getApplication(a.job_id)) ?? { job_id: a.job_id, status: 'entwurf', letter: null, applied_at: null, followup_at: null, followups: 0 };
    const n = { ...cur, ...a };
    await this.pool.query(
      `insert into applications (job_id, status, letter, applied_at, followup_at, followups, channel, notes) values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (job_id) do update set status = $2, letter = $3, applied_at = $4, followup_at = $5, followups = $6, channel = $7, notes = $8`,
      [n.job_id, n.status, n.letter, n.applied_at, n.followup_at, n.followups, n.channel ?? null, n.notes ?? null]);
  }
  async dueFollowups() {
    return (await this.pool.query(`select * from applications where status = 'beworben' and followup_at <= now()`)).rows as Application[];
  }
  async applicationsByStatus() {
    const out: Record<string, number> = {};
    for (const r of (await this.pool.query('select status, count(*)::int as n from applications group by status')).rows) out[r.status] = r.n;
    return out;
  }
  async listApplications() {
    const r = await this.pool.query(`select a.*, j.title, j.company, j.source from applications a join jobs j on j.id = a.job_id order by coalesce(a.applied_at, j.first_seen) desc`);
    return r.rows as ApplicationRow[];
  }
  async findJobs(query: string, limit: number) {
    const r = await this.pool.query(
      `select * from jobs where status in ('match','manuell','low') and (company ilike $1 or title ilike $1) order by notified_at desc nulls last, first_seen desc limit $2`,
      [`%${query}%`, limit]);
    return r.rows as StoredJob[];
  }
  async undecided(hours: number, limit: number) {
    const r = await this.pool.query(
      `select j.* from jobs j left join applications a on a.job_id = j.id
       where j.status = 'match' and j.notified_at is not null and j.notified_at < now() - make_interval(hours => $1)
         and j.feedback is null and a.job_id is null order by j.score desc limit $2`, [hours, limit]);
    return r.rows as StoredJob[];
  }
  async addLetterExample(text: string) {
    await this.pool.query('insert into letter_examples (text) values ($1)', [text]);
  }
  async letterExamples(n: number) {
    return (await this.pool.query('select text from letter_examples order by id desc limit $1', [n])).rows.map((r) => r.text as string);
  }
  async kvGet(key: string) {
    const r = await this.pool.query('select value from kv where key = $1', [key]);
    return r.rows[0]?.value ?? null;
  }
  async kvSet(key: string, value: string) {
    await this.pool.query('insert into kv (key, value) values ($1,$2) on conflict (key) do update set value = excluded.value', [key, value]);
  }
  async stats() {
    const r = await this.pool.query(`select status, count(*)::int as n from jobs group by status`);
    const out: Record<string, number> = {};
    for (const row of r.rows) out[row.status] = row.n;
    const sent = await this.pool.query('select count(*)::int as n from jobs where notified_at is not null');
    out.gemeldet = sent.rows[0].n;
    return out;
  }
}

interface FileData { jobs: Record<string, StoredJob & { dedupe_key: string }>; subscribers: Subscriber[]; kv: Record<string, string>; applications?: Record<string, Application>; letters?: string[] }

class FileStore implements Store {
  private data: FileData = { jobs: {}, subscribers: [], kv: {} };
  private writing: Promise<void> = Promise.resolve();
  constructor(private path: string) {}
  // Schreibvorgänge nacheinander, sonst überschreiben sich parallele Läufe
  private flush() {
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(this.path, JSON.stringify(this.data, null, 1));
    });
    return this.writing;
  }
  async init() {
    try { this.data = JSON.parse(await readFile(this.path, 'utf8')); } catch { /* neu */ }
  }
  async known(id: string, key: string) {
    return !!this.data.jobs[id] || Object.values(this.data.jobs).some((j) => j.dedupe_key === key);
  }
  async saveJob(j: StoredJob & { dedupe_key: string }) {
    if (!this.data.jobs[j.id]) { this.data.jobs[j.id] = j; await this.flush(); }
  }
  async getJob(id: string) { return this.data.jobs[id] ?? null; }
  private pendingList() {
    return Object.values(this.data.jobs).filter((j) => j.status === 'match' && !j.notified_at).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  }
  async pending(limit: number) { return this.pendingList().slice(0, limit); }
  async pendingCount() { return this.pendingList().length; }
  async recentMatches(days: number, limit: number) {
    const since = Date.now() - days * 86_400_000;
    return Object.values(this.data.jobs)
      .filter((j) => j.status === 'match' && j.notified_at && Date.parse(j.notified_at) > since)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, limit);
  }
  async markNotified(id: string) { this.data.jobs[id].notified_at = now(); await this.flush(); }
  async setFeedback(id: string, feedback: string) { if (this.data.jobs[id]) { this.data.jobs[id].feedback = feedback; await this.flush(); } }
  async recentFeedback(n: number) {
    return Object.values(this.data.jobs).filter((j) => j.feedback).slice(-n).map(({ title, company, feedback }) => ({ title, company, feedback: feedback! }));
  }
  async subscribers() { return this.data.subscribers; }
  async addSubscriber(chatId: string, name: string | null) {
    const s = this.data.subscribers.find((x) => x.chat_id === chatId);
    if (s) s.paused = false; else this.data.subscribers.push({ chat_id: chatId, name, paused: false });
    await this.flush();
  }
  async setPaused(chatId: string, paused: boolean) {
    const s = this.data.subscribers.find((x) => x.chat_id === chatId);
    if (s) { s.paused = paused; await this.flush(); }
  }
  async getApplication(jobId: string) { return this.data.applications?.[jobId] ?? null; }
  async upsertApplication(a: Partial<Application> & { job_id: string }) {
    this.data.applications ??= {};
    const cur = this.data.applications[a.job_id] ?? { job_id: a.job_id, status: 'entwurf', letter: null, applied_at: null, followup_at: null, followups: 0 };
    this.data.applications[a.job_id] = { ...cur, ...a } as Application;
    await this.flush();
  }
  async dueFollowups() {
    return Object.values(this.data.applications ?? {}).filter((a) => a.status === 'beworben' && a.followup_at && Date.parse(a.followup_at) <= Date.now());
  }
  async applicationsByStatus() {
    const out: Record<string, number> = {};
    for (const a of Object.values(this.data.applications ?? {})) out[a.status] = (out[a.status] ?? 0) + 1;
    return out;
  }
  async listApplications() {
    return Object.values(this.data.applications ?? {}).map((a) => {
      const j = this.data.jobs[a.job_id];
      return { ...a, title: j?.title ?? '?', company: j?.company ?? '?', source: j?.source ?? '?' };
    }).sort((a, b) => (b.applied_at ?? '').localeCompare(a.applied_at ?? ''));
  }
  async findJobs(query: string, limit: number) {
    const q = query.toLowerCase();
    return Object.values(this.data.jobs)
      .filter((j) => ['match', 'manuell', 'low'].includes(j.status) && (j.company.toLowerCase().includes(q) || j.title.toLowerCase().includes(q)))
      .sort((a, b) => (b.notified_at ?? '').localeCompare(a.notified_at ?? '')).slice(0, limit);
  }
  async undecided(hours: number, limit: number) {
    const before = Date.now() - hours * 3_600_000;
    return Object.values(this.data.jobs)
      .filter((j) => j.status === 'match' && j.notified_at && Date.parse(j.notified_at) < before && !j.feedback && !this.data.applications?.[j.id])
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, limit);
  }
  async addLetterExample(text: string) { (this.data.letters ??= []).push(text); await this.flush(); }
  async letterExamples(n: number) { return (this.data.letters ?? []).slice(-n).reverse(); }
  async kvGet(key: string) { return this.data.kv[key] ?? null; }
  async kvSet(key: string, value: string) { this.data.kv[key] = value; await this.flush(); }
  async stats() {
    const out: Record<string, number> = { gemeldet: 0 };
    for (const j of Object.values(this.data.jobs)) { out[j.status] = (out[j.status] ?? 0) + 1; if (j.notified_at) out.gemeldet++; }
    return out;
  }
}

export function createStore(): Store {
  return cfg.databaseUrl ? new PgStore() : new FileStore(new URL('../data/state.json', import.meta.url).pathname);
}
