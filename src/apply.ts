// Bewerbungsformular ausfüllen, Screenshot an Martin, absenden NUR nach seinem Klick auf "Absenden".
// Eine Sitzung bleibt bis zu 20 Minuten offen, damit Martin fehlende Angaben nachreichen kann.
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import type { BrowserContext, Frame, Page } from 'playwright';
import { getBrowser } from './browser.ts';
import { cfg } from './config.ts';
import { CONTACT, docPath, fileSafe, letterPdf } from './documents.ts';
import { PROFILE } from './llm.ts';
import type { Store } from './store.ts';
import { button, esc, tg, tgFile } from './tg.ts';
import type { StoredJob } from './types.ts';

const client = new Anthropic({ apiKey: cfg.anthropicKey });

interface Field { id: string; frame: number; kind: string; label: string; required: boolean; options?: string[] }
interface Plan { fill: { id: string; value: string }[]; files: { id: string; doc: string }[]; check: string[]; consent: string[]; offen: string[] }
interface Session { job: StoredJob; chatId: string; ref: string; context: BrowserContext; page: Page; fields: Field[]; plan: Plan; files: Record<string, string>; timer: NodeJS.Timeout; extra: string }

const sessions = new Map<string, Session>();

const DECLINE = /^(alle ablehnen|ablehnen|nur (notwendige|erforderliche|essenzielle)|notwendige cookies|reject( all)?|decline|deny|nur technisch notwendige)/i;
// Knopftexte variieren stark ("Auf diese Stelle bewerben", "Apply for this job", "Jetzt bewerben"): Stichwort genügt
const APPLY = /(bewerben|bewirb|zur bewerbung|bewerbung starten|apply)/i;
const NOT_APPLY = /initiativ|zurück|alle stellen|weitere stellen|teilen|share|login|anmelden/i;

async function dismissCookies(page: Page) {
  for (const f of page.frames()) {
    const btns = f.getByRole('button');
    const n = Math.min(await btns.count().catch(() => 0), 60);
    for (let i = 0; i < n; i++) {
      const t = ((await btns.nth(i).innerText().catch(() => '')) || '').trim();
      if (DECLINE.test(t)) { await btns.nth(i).click({ timeout: 3000 }).catch(() => {}); return; }
    }
  }
}

async function hasForm(page: Page): Promise<boolean> {
  for (const f of page.frames()) {
    const n = await f.locator('input[type=file], input[type=email]').count().catch(() => 0);
    if (n > 0) return true;
  }
  return false;
}

async function openForm(page: Page, url: string) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForTimeout(2500);
  await dismissCookies(page);
  for (let round = 0; round < 2 && !(await hasForm(page)); round++) {
    const cands = page.locator('a, button');
    const n = Math.min(await cands.count(), 400);
    let clicked = false;
    for (let i = 0; i < n && !clicked; i++) {
      const el = cands.nth(i);
      const t = ((await el.innerText().catch(() => '')) || '').trim();
      if (t.length < 40 && APPLY.test(t) && !NOT_APPLY.test(t) && (await el.isVisible().catch(() => false))) {
        await el.click({ timeout: 5000 }).catch(() => {});
        clicked = true;
      }
    }
    if (!clicked) break;
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(3000);
    await dismissCookies(page);
  }
}

const COLLECT_SRC = `function (fi) {
  var res = [];
  var textOf = function (el) { return ((el && el.textContent) || '').replace(/\\s+/g, ' ').trim(); };
  var labelFor = function (el) {
    var id = el.getAttribute('id');
    var byFor = id ? document.querySelector('label[for="' + CSS.escape(id) + '"]') : null;
    var lb = el.getAttribute('aria-labelledby');
    var fs = el.closest('fieldset');
    return [
      el.getAttribute('aria-label'), textOf(byFor),
      lb ? lb.split(' ').map(function (x) { return textOf(document.getElementById(x)); }).join(' ') : '',
      textOf(el.closest('label')), el.placeholder, el.getAttribute('name'),
      textOf(fs ? fs.querySelector('legend') : null),
      textOf(el.parentElement ? el.parentElement.previousElementSibling : null)
    ].filter(Boolean).join(' | ').slice(0, 300);
  };
  var n = 0;
  document.querySelectorAll('input, select, textarea').forEach(function (el) {
    var type = (el.getAttribute('type') || el.tagName).toLowerCase();
    if (el.getAttribute('role') === 'combobox' || el.getAttribute('aria-autocomplete') === 'list') type = 'combobox';
    if (['hidden', 'submit', 'button', 'image', 'reset', 'search'].indexOf(type) >= 0) return;
    var visible = el.offsetParent !== null || getComputedStyle(el).position === 'fixed';
    if (!visible && type !== 'file' && type !== 'checkbox' && type !== 'radio') return;
    var id = 'f' + fi + '_' + (n++);
    el.setAttribute('data-jr', id);
    var options;
    if (el.tagName === 'SELECT') options = Array.prototype.map.call(el.options, function (o) { return o.text.trim(); }).filter(Boolean).slice(0, 60);
    res.push({ id: id, frame: fi, kind: type, label: labelFor(el) + ((type === 'radio' || type === 'checkbox') ? ' [Wert: ' + el.value + ']' : ''), required: el.required || el.getAttribute('aria-required') === 'true', options: options });
  });
  return res;
}`;

/** Alle Eingabefelder in allen Frames einsammeln und markieren (data-jr). */
async function collectFields(page: Page): Promise<Field[]> {
  const out: Field[] = [];
  const frames = page.frames();
  for (let fi = 0; fi < frames.length; fi++) {
    // Als Text übergeben: tsx würde in eine echte Funktion Hilfsaufrufe (__name) einbauen, die es im Browser nicht gibt
    const got = await frames[fi].evaluate(`(${COLLECT_SRC})(${fi})`).catch((e: Error) => {
      console.error(`Felder in Frame ${fi} nicht lesbar: ${e.message.slice(0, 160)}`);
      return [] as any[];
    }) as any[];
    out.push(...got);
  }
  // Selbstgebaute Aufklapplisten (React-Select bei Greenhouse u.a.): kurz öffnen und Optionen lesen
  for (const f of out.filter((x) => x.kind === 'combobox').slice(0, 15)) {
    const fr = frames[f.frame];
    const el = fr.locator(`[data-jr="${f.id}"]`);
    try {
      await el.click({ timeout: 3000 });
      await fr.waitForTimeout(400);
      const opts = await fr.locator('[role="option"]').allInnerTexts();
      f.options = opts.map((o) => o.trim()).filter(Boolean).slice(0, 80);
      await el.press('Escape').catch(() => {});
    } catch { /* bleibt ohne Optionen */ }
  }
  return out;
}

async function planFill(job: StoredJob, fields: Field[], letter: string, extra: string): Promise<Plan> {
  const res = await client.messages.create({
    model: cfg.letterModel,
    max_tokens: 16000, // Sonnet denkt vorher nach
    system: `Du füllst ein Online-Bewerbungsformular für Martin Spalevic aus. Antworte ausschließlich mit JSON.

Seine Daten (nur diese verwenden, nichts erfinden):
${JSON.stringify(CONTACT, null, 1)}

Profil:
${PROFILE}

Zusätzliche Angaben von Martin (haben Vorrang):
${extra || '(keine)'}

Dokumente zum Hochladen: "lebenslauf", "anschreiben"${docPath('immatrikulation') ? ', "immatrikulation"' : ''}.

Regeln:
- "fill": Textfelder und Auswahllisten (auch kind "combobox"). Bei Auswahllisten exakt einen Optionstext aus "options" als value. Für Herkunftsfragen (wie aufmerksam geworden) die Option für Website/Karriereseite/Internet/Jobbörse wählen, falls vorhanden. Telefon-Ländervorwahl: Deutschland/Germany (+49). Textfeld für Anschreiben/Nachricht/Motivation/Cover Letter: value = "__ANSCHREIBEN__".
- "files": Datei-Felder. Lebenslauf/CV/Resume -> "lebenslauf", Anschreiben/Cover Letter/Motivationsschreiben -> "anschreiben", Immatrikulation/Studienbescheinigung -> "immatrikulation". Gibt es nur ein Datei-Feld für alle Unterlagen: "lebenslauf". Nicht vorhandenes Dokument weglassen.
- "check": IDs von Radio-Buttons oder Checkboxen, die eine Sachfrage beantworten (z.B. Anrede, Studierender ja), nur wenn die Antwort sicher aus seinen Daten folgt.
- "consent": IDs von Einwilligungs-Checkboxen (Datenschutz, Speicherung, Talentpool nur wenn Pflicht). NICHT in "check" aufnehmen.
- "offen": kurze deutsche Beschreibung jeder Pflichtangabe, die du NICHT sicher beantworten kannst (z.B. Gehaltsvorstellung, frühester Start, Wochenstunden, Staatsangehörigkeit/Arbeitserlaubnis, Notendurchschnitt, wie er auf die Stelle aufmerksam wurde). Raten ist verboten. Freiwillige unklare Felder einfach leer lassen.
- Felder wie Suche, Newsletter, Login, Passwort, Konto anlegen: ignorieren.

Format: {"fill":[{"id":"f0_1","value":"Martin"}],"files":[{"id":"f0_7","doc":"lebenslauf"}],"check":[],"consent":["f0_9"],"offen":["Gehaltsvorstellung"]}`,
    messages: [{ role: 'user', content: `Stelle: ${job.title} bei ${job.company}\n\nFelder:\n${JSON.stringify(fields)}` }],
  });
  const raw = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  const p = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
  return { fill: p.fill ?? [], files: p.files ?? [], check: p.check ?? [], consent: p.consent ?? [], offen: p.offen ?? [] };
}

function frameOf(s: Session, id: string): Frame | undefined {
  const f = s.fields.find((x) => x.id === id);
  return f ? s.page.frames()[f.frame] : undefined;
}

async function applyPlan(s: Session, letter: string): Promise<string[]> {
  const done: string[] = [];
  for (const { id, value } of s.plan.fill) {
    const fr = frameOf(s, id); if (!fr) continue;
    const el = fr.locator(`[data-jr="${id}"]`);
    const v = value === '__ANSCHREIBEN__' ? letter : value;
    const kind = s.fields.find((f) => f.id === id)?.kind;
    if (kind === 'combobox') {
      const ok = await (async () => {
        await el.click({ timeout: 3000 });
        await el.fill(v.slice(0, 40), { timeout: 3000 }).catch(() => {});
        await fr.waitForTimeout(500);
        const opt = fr.getByRole('option', { name: v, exact: true });
        await ((await opt.count()) ? opt.first() : fr.getByRole('option').first()).click({ timeout: 3000 });
        return true;
      })().catch(() => false);
      if (ok) done.push(s.fields.find((f) => f.id === id)?.label.split(' | ')[0] || id);
      continue;
    }
    const tag = await el.evaluate('n => n.tagName').catch(() => '');
    const ok = tag === 'SELECT'
      ? await el.selectOption({ label: v }, { timeout: 4000 }).then(() => true).catch(() => false)
      : await el.fill(v, { timeout: 4000 }).then(() => true).catch(() => false);
    if (ok) done.push(s.fields.find((f) => f.id === id)?.label.split(' | ')[0] || id);
  }
  for (const { id, doc } of s.plan.files) {
    const fr = frameOf(s, id); const path = s.files[doc]; if (!fr || !path) continue;
    if (await fr.locator(`[data-jr="${id}"]`).setInputFiles(path, { timeout: 8000 }).then(() => true).catch(() => false)) done.push(`📎 ${doc}`);
  }
  // Uploads laufen nach setInputFiles noch: warten, damit Screenshot und Absenden sie sehen
  if (done.some((d) => d.startsWith('📎'))) await s.page.waitForTimeout(5000);
  for (const id of s.plan.check) {
    const fr = frameOf(s, id); if (!fr) continue;
    await fr.locator(`[data-jr="${id}"]`).check({ timeout: 3000, force: true }).catch(() => {});
  }
  return done;
}

async function screenshot(s: Session, caption: string, markup?: unknown) {
  const png = await s.page.screenshot({ fullPage: true, timeout: 20_000 });
  const size = await s.page.evaluate(() => ({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight })).catch(() => ({ w: 1280, h: 2000 }));
  const extra: Record<string, unknown> = { caption: caption.slice(0, 1000), parse_mode: 'HTML' };
  if (markup) extra.reply_markup = markup;
  // Sehr lange Seiten verweigert Telegram als Foto: dann als Datei
  return size.h / Math.max(size.w, 1) <= 3
    ? tgFile('sendPhoto', s.chatId, png, 'formular.png', extra)
    : tgFile('sendDocument', s.chatId, png, `Formular_${fileSafe(s.job.company)}.png`, extra);
}

function close(ref: string) {
  const s = sessions.get(ref);
  if (!s) return;
  clearTimeout(s.timer);
  void s.context.close().catch(() => {});
  sessions.delete(ref);
}

async function fillAndReport(store: Store, s: Session) {
  const app = await store.getApplication(s.job.id);
  const letter = app?.letter ?? '';
  const standing = (await store.kvGet('answers')) ?? '';
  s.fields = await collectFields(s.page);
  if (!s.fields.length) {
    await tg('sendMessage', { chat_id: s.chatId, text: `Ich finde auf der Seite kein Bewerbungsformular. Bitte bewirb dich direkt:\n${s.job.url}` });
    close(s.ref);
    return;
  }
  s.plan = await planFill(s.job, s.fields, letter, [standing, s.extra].filter(Boolean).join('\n'));
  const done = await applyPlan(s, letter);
  const captcha = (await s.page.locator('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"]').count()) > 0;
  const lines = [
    `🤖 <b>Formular bei ${esc(s.job.company)}</b>`,
    `Ausgefüllt: ${esc(done.join(', ') || 'nichts')}`,
    s.plan.consent.length ? 'Datenschutz-Einwilligung: setze ich erst beim Absenden.' : '',
    s.plan.offen.length ? `\n❓ <b>Noch offen:</b> ${esc(s.plan.offen.join(', '))}\nAntworte auf dieses Bild mit den Angaben, z.B. „Start 1.11., 20 Std/Woche, 15 €/h“. Ich merke sie mir auch für spätere Formulare.` : '',
    captcha ? '\n⚠️ Die Seite hat eine Captcha-Prüfung. Falls das Absenden scheitert, schick es bitte selbst über den Link ab.' : '',
    `\nBitte prüf den Screenshot. Abgeschickt wird erst, wenn du auf Absenden tippst.`,
  ].filter(Boolean).join('\n');
  const rows = [[...(s.plan.offen.length ? [] : [button('✅ Absenden', `send:${s.ref}`)]), button('❌ Abbrechen', `stop:${s.ref}`)], [{ text: '🔗 Selbst öffnen', url: s.job.url }]];
  const msg = await screenshot(s, lines, { inline_keyboard: rows });
  await store.kvSet(`form_msg:${s.chatId}:${msg.message_id}`, s.ref);
}

export async function startForm(store: Store, chatId: string, job: StoredJob, ref: string) {
  close(ref);
  await tg('sendMessage', { chat_id: chatId, text: 'Ich öffne das Formular und fülle es aus, das dauert etwa eine Minute.' });
  const app = await store.getApplication(job.id);
  const dir = mkdtempSync(join(tmpdir(), 'bewerbung-'));
  const files: Record<string, string> = {};
  const cv = docPath('lebenslauf'); if (cv) files.lebenslauf = cv;
  const imm = docPath('immatrikulation'); if (imm) files.immatrikulation = imm;
  if (app?.letter) { files.anschreiben = join(dir, `Anschreiben_Martin_Spalevic.pdf`); writeFileSync(files.anschreiben, await letterPdf(app.letter, job)); }

  const browser = await getBrowser();
  const context = await browser.newContext({ locale: 'de-DE', viewport: { width: 1280, height: 900 }, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36' });
  const page = await context.newPage();
  const s: Session = { job, chatId, ref, context, page, fields: [], plan: { fill: [], files: [], check: [], consent: [], offen: [] }, files, extra: '', timer: setTimeout(() => close(ref), 20 * 60_000) };
  sessions.set(ref, s);
  try {
    await openForm(page, job.url);
    await fillAndReport(store, s);
  } catch (e) {
    await tg('sendMessage', { chat_id: chatId, text: `Das Formular konnte ich nicht ausfüllen (${(e as Error).message.slice(0, 120)}). Bitte bewirb dich direkt:\n${job.url}` });
    close(ref);
  }
}

/** Antwort auf den Formular-Screenshot: fehlende Angaben übernehmen und neu ausfüllen. */
export async function handleFormReply(store: Store, chatId: string, replyToId: number, text: string): Promise<boolean> {
  const ref = await store.kvGet(`form_msg:${chatId}:${replyToId}`);
  const s = ref ? sessions.get(ref) : undefined;
  if (!ref) return false;
  if (!s) { await tg('sendMessage', { chat_id: chatId, text: 'Die Formular-Sitzung ist abgelaufen. Tipp nochmal auf 🤖 Formular ausfüllen.' }); return true; }
  s.extra = [s.extra, text].filter(Boolean).join('\n');
  // Dauerhafte Angaben (Start, Stunden, Gehalt …) für künftige Formulare merken
  const prev = (await store.kvGet('answers')) ?? '';
  await store.kvSet('answers', [prev, text].filter(Boolean).join('\n').slice(-2000));
  await tg('sendMessage', { chat_id: chatId, text: 'Danke, ich trage das ein.' });
  await fillAndReport(store, s);
  return true;
}

export async function submitForm(store: Store, chatId: string, ref: string): Promise<'ok' | 'unklar' | 'weg'> {
  const s = sessions.get(ref);
  if (!s) { await tg('sendMessage', { chat_id: chatId, text: 'Die Formular-Sitzung ist abgelaufen. Tipp nochmal auf 🤖 Formular ausfüllen.' }); return 'weg'; }
  await tg('sendMessage', { chat_id: chatId, text: 'Schicke ab …' });
  for (const id of s.plan.consent) {
    const fr = frameOf(s, id);
    await fr?.locator(`[data-jr="${id}"]`).check({ timeout: 3000, force: true }).catch(() => {});
  }
  // Absende-Knopf im Frame mit den meisten Feldern
  const counts = new Map<number, number>();
  for (const f of s.fields) counts.set(f.frame, (counts.get(f.frame) ?? 0) + 1);
  const fi = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
  const fr = s.page.frames()[fi];
  const named = fr.getByRole('button', { name: /absenden|bewerbung (ab)?senden|jetzt bewerben|senden|submit|send application|apply/i });
  const target = (await named.count()) ? named.last() : fr.locator('button[type=submit], input[type=submit]').last();
  await target.click({ timeout: 8000 });
  await s.page.waitForTimeout(7000);
  const body = (await s.page.locator('body').innerText().catch(() => '')) + (await fr.locator('body').innerText().catch(() => ''));
  const success = /vielen dank|danke für (deine|ihre) bewerbung|erfolgreich|eingegangen|thank you for (your )?appl|application (has been )?(received|submitted)/i.test(body);
  await screenshot(s, success ? '✅ Abgeschickt. So sieht die Bestätigung aus.' : '⚠️ Ich habe auf Absenden getippt, sehe aber keine eindeutige Bestätigung. Bitte prüf den Screenshot und, wenn nötig, schick es selbst über den Link ab.');
  close(ref);
  return success ? 'ok' : 'unklar';
}

export function cancelForm(ref: string) { close(ref); }

/** Nur für Tests: Formular öffnen, ausfüllen, Screenshot als Datei. Schickt NIE ab und sendet nichts an Telegram. */
export async function dryRunForm(job: StoredJob, letter: string, outPng: string): Promise<{ fields: number; done: string[]; plan: Plan }> {
  const dir = mkdtempSync(join(tmpdir(), 'bewerbung-'));
  const files: Record<string, string> = {};
  const cv = docPath('lebenslauf'); if (cv) files.lebenslauf = cv;
  files.anschreiben = join(dir, 'Anschreiben_Martin_Spalevic.pdf');
  writeFileSync(files.anschreiben, await letterPdf(letter, job));
  const browser = await getBrowser();
  const context = await browser.newContext({ locale: 'de-DE', viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const s: Session = { job, chatId: '', ref: 'test', context, page, fields: [], plan: { fill: [], files: [], check: [], consent: [], offen: [] }, files, extra: '', timer: setTimeout(() => {}, 0) };
  try {
    await openForm(page, job.url);
    s.fields = await collectFields(page);
    console.log(`Formular: ${page.url()}, Eingaben: ${await page.locator('input, textarea, select').count()}, erkannt: ${s.fields.length}`);
    s.plan = await planFill(job, s.fields, letter, '');
    const done = await applyPlan(s, letter);
    writeFileSync(outPng, await page.screenshot({ fullPage: true }));
    return { fields: s.fields.length, done, plan: s.plan };
  } finally {
    await context.close();
    await browser.close();
  }
}
