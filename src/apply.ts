// Bewerbungsformular ausfüllen, Screenshot an Martin, absenden NUR nach seinem Klick auf "Absenden".
// Eine Sitzung bleibt bis zu 20 Minuten offen, damit Martin fehlende Angaben nachreichen kann.
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import type { BrowserContext, Frame, Page } from 'playwright';
import { getBrowser } from './browser.ts';
import { cfg } from './config.ts';
import { CONTACT, fileSafe, letterPdf } from './documents.ts';
import { materialize } from './uploads.ts';
import { findOriginalPosting, PROFILE } from './llm.ts';
import type { Store } from './store.ts';
import { button, esc, tg, tgFile } from './tg.ts';
import type { StoredJob } from './types.ts';
import { generatePassword, getCredential, portalKey, saveCredential } from './vault.ts';

const client = new Anthropic({ apiKey: cfg.anthropicKey });

interface Field { id: string; frame: number; kind: string; label: string; required: boolean; options?: string[] }
interface Plan { fill: { id: string; value: string }[]; files: { id: string; doc: string }[]; check: string[]; consent: string[]; offen: string[] }
interface Session { job: StoredJob; chatId: string; ref: string; context: BrowserContext; page: Page; fields: Field[]; plan: Plan; files: Record<string, string[]>; timer: NodeJS.Timeout; extra: string }

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
  // Ein Bewerbungsformular hat einen Datei-Upload oder eine E-Mail plus weitere Felder. Ein einzelnes E-Mail-Feld ist meist ein Job-Alarm.
  for (const f of page.frames()) {
    const files = await f.locator('input[type=file]').count().catch(() => 0);
    const emails = await f.locator('input[type=email], input[name*=mail i]').count().catch(() => 0);
    const texts = await f.locator('input[type=text], input:not([type]), input[type=tel]').count().catch(() => 0);
    if (files > 0 || (emails > 0 && texts >= 2)) return true;
  }
  return false;
}

class LoginRequired extends Error {
  constructor(public portal: string, public registerUrl: string | null, public loginUrl: string, public failed = false) { super('Login nötig'); }
}

async function loginFrame(page: Page): Promise<Frame | null> {
  for (const f of page.frames()) {
    const pw = await f.locator('input[type=password]:visible').count().catch(() => 0);
    const files = await f.locator('input[type=file]').count().catch(() => 0);
    if (pw > 0 && files === 0) return f;
  }
  return null;
}

async function registerLink(f: Frame): Promise<string | null> {
  const links = f.locator('a, button').filter({ hasText: /registr|konto (erstellen|anlegen)|create (an )?account|sign up|neues konto|neu hier|konto eröffnen/i });
  const href = await links.first().getAttribute('href').catch(() => null);
  try { return href && !/^(javascript:|#)/.test(href) ? new URL(href, f.url()).toString() : null; } catch { return null; }
}

/** Auf einer Login-Seite mit gespeicherten Daten anmelden, sonst LoginRequired werfen (Martin legt das Konto an). */
async function handleLogin(store: Store, page: Page) {
  const f = await loginFrame(page);
  if (!f) return;
  const portal = portalKey(page.url());
  const cred = await getCredential(store, portal);
  if (!cred || cred.status !== 'aktiv') throw new LoginRequired(portal, await registerLink(f), page.url());
  const user = f.locator('input[type=email]:visible, input[type=text]:visible, input:not([type]):visible').first();
  await user.fill(cred.username, { timeout: 5000 }).catch(() => {});
  await f.locator('input[type=password]:visible').first().fill(cred.password, { timeout: 5000 });
  const submit = f.getByRole('button', { name: /anmelden|einloggen|log ?in|sign ?in|weiter|continue/i }).first();
  if (await submit.count()) await submit.click({ timeout: 5000 }).catch(() => {});
  else await f.locator('input[type=password]:visible').first().press('Enter').catch(() => {});
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(5000);
  await dismissCookies(page);
  if (await loginFrame(page)) throw new LoginRequired(portal, null, page.url(), true);
}

async function openForm(page: Page, url: string, store?: Store) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForTimeout(2500);
  await dismissCookies(page);
  if (store) await handleLogin(store, page);
  for (let round = 0; round < 2 && !(await hasForm(page)); round++) {
    const cands = page.locator('a, button');
    const n = Math.min(await cands.count(), 400);
    let clicked = false;
    for (let i = 0; i < n && !clicked; i++) {
      const el = cands.nth(i);
      const t = ((await el.innerText().catch(() => '')) || '').trim();
      if (t.length < 40 && APPLY.test(t) && !NOT_APPLY.test(t) && (await el.isVisible().catch(() => false))) {
        // Links direkt aufrufen: Knöpfe mit target=_blank öffnen sonst einen neuen Tab, und Cookie-Overlays fangen Klicks ab
        const rawHref = await el.getAttribute('href').catch(() => null);
        let href = '';
        try { href = rawHref && !/^(javascript:|#)/.test(rawHref) ? new URL(rawHref, page.url()).toString() : ''; } catch { /* kein Link */ }
        console.log(`Bewerben-Knopf: "${t}" → ${href || '(Klick)'}`);
        if (/^https?:/.test(href) && href.split('#')[0] !== page.url().split('#')[0]) {
          await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
        } else {
          await el.click({ timeout: 5000, force: true }).catch(() => {});
        }
        clicked = true;
      }
    }
    if (!clicked) break;
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(3000);
    await dismissCookies(page);
    if (store) await handleLogin(store, page);
  }
}

const COLLECT_SRC = `function (fi) {
  var res = [];
  var n = 0;
  var textOf = function (el) { return ((el && el.textContent) || '').replace(/\\s+/g, ' ').trim(); };
  // Alle Wurzeln einsammeln, auch gekapselte Web-Bausteine (Shadow-DOM, z.B. bei REWE)
  var roots = [document];
  for (var r = 0; r < roots.length && r < 400; r++) {
    roots[r].querySelectorAll('*').forEach(function (e) { if (e.shadowRoot) roots.push(e.shadowRoot); });
  }
  roots.forEach(function (root) {
    var labelFor = function (el) {
      var id = el.getAttribute('id');
      var byFor = id ? root.querySelector('label[for="' + CSS.escape(id) + '"]') : null;
      var lb = el.getAttribute('aria-labelledby');
      var fs = el.closest('fieldset');
      var host = root.host ? textOf(root.host.closest('[class*=upload], [class*=field], section') || root.host).slice(0, 160) : '';
      return [
        el.getAttribute('aria-label'), textOf(byFor),
        lb ? lb.split(' ').map(function (x) { return textOf(root.getElementById ? root.getElementById(x) : document.getElementById(x)); }).join(' ') : '',
        textOf(el.closest('label')), el.placeholder, el.getAttribute('name'),
        textOf(fs ? fs.querySelector('legend') : null),
        textOf(el.parentElement ? el.parentElement.previousElementSibling : null),
        host
      ].filter(Boolean).join(' | ').slice(0, 300);
    };
    root.querySelectorAll('input, select, textarea').forEach(function (el) {
      var type = (el.getAttribute('type') || el.tagName).toLowerCase();
      if (el.getAttribute('role') === 'combobox' || el.getAttribute('aria-autocomplete') === 'list') type = 'combobox';
      if (['hidden', 'submit', 'button', 'image', 'reset', 'search'].indexOf(type) >= 0) return;
      var visible = el.offsetParent !== null || getComputedStyle(el).position === 'fixed';
      if (!visible && type !== 'file' && type !== 'checkbox' && type !== 'radio') return;
      var id = 'f' + fi + '_' + (n++);
      el.setAttribute('data-jr', id);
      var options;
      if (el.tagName === 'SELECT') options = Array.prototype.map.call(el.options, function (o) { return o.text.trim(); }).filter(Boolean).slice(0, 60);
      // Bei Auswahlfeldern steht die eigentliche Frage oft als Text über der Gruppe
      var question = '';
      if (type === 'radio' || type === 'checkbox') {
        var a = el;
        for (var k = 0; k < 6 && !question; k++) {
          a = a.parentElement || (a.getRootNode && a.getRootNode().host) || null;
          if (!a) break;
          var prev = a.previousElementSibling;
          if (prev && textOf(prev).length > 12) question = 'Frage: ' + textOf(prev).slice(0, 200) + ' | ';
        }
      }
      res.push({ id: id, frame: fi, kind: type, label: question + labelFor(el) + ((type === 'radio' || type === 'checkbox') ? ' [Wert: ' + el.value + ']' : ''), required: el.required || el.getAttribute('aria-required') === 'true', options: options });
    });
  });
  return res;
}`;

/** Alle Eingabefelder in allen Frames einsammeln und markieren (data-jr). */
async function collectFields(page: Page): Promise<Field[]> {
  await dismissCookies(page);
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

async function planFill(job: StoredJob, fields: Field[], letter: string, extra: string, available: string[]): Promise<Plan> {
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

Dokumente zum Hochladen (nur diese gibt es): ${available.map((d) => `"${d}"`).join(', ')}.

Regeln:
- "fill": Textfelder und Auswahllisten (auch kind "combobox"). Bei Auswahllisten exakt einen Optionstext aus "options" als value. Für Herkunftsfragen (wie aufmerksam geworden) die Option für Website/Karriereseite/Internet/Jobbörse wählen, falls vorhanden. Telefon-Ländervorwahl: Deutschland/Germany (+49). Textfeld für Anschreiben/Nachricht/Motivation/Cover Letter: value = "__ANSCHREIBEN__".
- "files": Datei-Felder. Lebenslauf/CV/Resume -> "lebenslauf", Anschreiben/Cover Letter/Motivationsschreiben -> "anschreiben", Immatrikulation/Studienbescheinigung -> "immatrikulation", Zeugnisse/Transcript -> "zeugnis", Foto/Bild -> "foto", „Weitere Dokumente/Unterlagen/Anlagen“ -> "weitere". Gibt es nur ein Datei-Feld für alle Unterlagen: "lebenslauf". Nicht vorhandenes Dokument weglassen.
- "check": IDs von Radio-Buttons oder Checkboxen, die eine Sachfrage beantworten (z.B. Anrede, Studierender ja), nur wenn die Antwort sicher aus seinen Daten folgt.
- "consent": IDs von Einwilligungs-Checkboxen (Datenschutz, Speicherung, Talentpool nur wenn Pflicht). NICHT in "check" aufnehmen.
- "offen": Vollständige, verständliche Rückfragen direkt an Martin für jede Angabe, die du NICHT sicher beantworten kannst. Bewahre den konkreten Inhalt der Formularfrage, Einheiten (z.B. Jahresbrutto) und relevante Auswahlmöglichkeiten. Keine vagen Überschriften wie "Weitere Angaben (Ja/Nein)". Ist der Fragetext nicht erkennbar, sage ausdrücklich, welches Feld unlesbar ist; erfinde keine Frage. Bereits beantwortete Fragen nicht wiederholen. Starttermin und Verfügbarkeit nur dann getrennt fragen, wenn sie tatsächlich Unterschiedliches meinen. Frage nach jeder unbekannten Angabe (z.B. Gehaltsvorstellung, frühester Start, Wochenstunden, Staatsangehörigkeit/Arbeitserlaubnis, Notendurchschnitt, wie er auf die Stelle aufmerksam wurde). Raten ist verboten. Freiwillige unklare Felder einfach leer lassen.
- Felder mit Schlüssel "..._nur_wenn_pflicht" (Geburtsdatum, Geburtsort) nur ausfüllen, wenn das Feld Pflicht ist. "Vollzeitstudium/eingeschrieben?" = Ja (Vollzeitstudierender laut Bescheinigung).
- Feld "Titel" meint einen akademischen Titel (Dr., Prof.): leer lassen. "Wirtschaftsjurist (LL.B.)" ist KEIN Titel.
- Freitextfragen nur beantworten, wenn die Antwort sicher aus den Daten folgt; sonst in "offen" aufnehmen, auch wenn sie freiwillig sind, sofern sie für die Bewerbung wichtig wirken (Stunden, Wochentage, Starttermin, Gehalt, Vollzeitstudium).
- Felder wie Suche, Newsletter, Login, Passwort, Konto anlegen: ignorieren.

Format: {"fill":[{"id":"f0_1","value":"Martin"}],"files":[{"id":"f0_7","doc":"lebenslauf"}],"check":[],"consent":["f0_9"],"offen":["Welches Jahresbruttogehalt möchtest du angeben?"]}`,
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
    const tag = await el.evaluate((n) => n.tagName).catch(() => '');
    const ok = tag === 'SELECT'
      ? await el.selectOption({ label: v }, { timeout: 4000 }).then(() => true).catch(() => false)
      : await el.fill(v, { timeout: 4000 }).then(() => true).catch(() => false);
    if (ok) done.push(s.fields.find((f) => f.id === id)?.label.split(' | ')[0] || id);
  }
  for (const { id, doc } of s.plan.files) {
    const fr = frameOf(s, id); const path = s.files[doc]; if (!fr || !path?.length) continue;
    if (await fr.locator(`[data-jr="${id}"]`).setInputFiles(path, { timeout: 8000 }).then(() => true).catch(() => false)) done.push(`📎 ${doc}`);
  }
  // Fehlt ein Dokument, Upload-Kacheln über den Dateidialog versuchen
  const uploaded = new Set(done.filter((d) => d.startsWith('📎')).map((d) => d.slice(3)));
  if (!uploaded.has('lebenslauf') || !uploaded.has('anschreiben')) done.push(...(await uploadViaChooser(s, uploaded)));
  // Uploads laufen nach setInputFiles noch: warten, damit Screenshot und Absenden sie sehen
  if (done.some((d) => d.startsWith('📎'))) await s.page.waitForTimeout(5000);
  for (const id of s.plan.check) {
    const fr = frameOf(s, id); if (!fr) continue;
    await fr.locator(`[data-jr="${id}"]`).check({ timeout: 3000, force: true }).catch(() => {});
  }
  return done;
}

/** Upload-Kacheln ohne sichtbares Dateifeld (z.B. REWE): Kachel anklicken, Datei über den Dateidialog übergeben. */
async function uploadViaChooser(s: Session, already: Set<string>): Promise<string[]> {
  const done: string[] = [];
  for (const fr of s.page.frames()) {
    const tiles = fr.locator('button, a, label, [role=button], div').filter({ hasText: /^(\s*\S*\s*)?(lebenslauf|dokument|datei|anschreiben|unterlagen|cv|resume)?\s*(hochladen|upload|hinzufügen|auswählen)\s*$/i });
    const n = Math.min(await tiles.count().catch(() => 0), 8);
    for (let i = 0; i < n; i++) {
      const tile = tiles.nth(i);
      if (!(await tile.isVisible().catch(() => false))) continue;
      // Worum es geht, steht in der Kachel oder in der Überschrift davor
      const context = await tile.evaluate((e) => {
        let t = e.textContent || '';
        let p: Element | null = e;
        for (let k = 0; k < 3 && p; k++) { p = p.previousElementSibling || p.parentElement; if (p) t = (p.textContent || '').slice(0, 120) + ' ' + t; }
        return t;
      }).catch(() => '');
      const doc = /lebenslauf|\bcv\b|resume/i.test(context) && !already.has('lebenslauf') ? 'lebenslauf'
        : !already.has('anschreiben') && s.files.anschreiben?.length ? 'anschreiben'
        : /weitere|zeugnis|dokument|unterlagen/i.test(context) && !already.has('weitere') && s.files.weitere?.length ? 'weitere' : null;
      if (!doc || !s.files[doc]?.length) continue;
      const chooser = s.page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null);
      await tile.click({ timeout: 4000, force: true }).catch(() => {});
      const fc = await chooser;
      if (!fc) continue;
      await fc.setFiles(s.files[doc]);
      already.add(doc);
      done.push(`📎 ${doc}`);
      await s.page.waitForTimeout(2500);
    }
  }
  return done;
}

async function screenshot(s: Session, caption: string, markup?: unknown) {
  // Als Foto, damit es im Chat direkt sichtbar ist. Telegram erlaubt Breite + Höhe bis 10.000 px: sehr lange Seiten oben abschneiden
  const height = await s.page.evaluate(() => document.documentElement.scrollHeight).catch(() => 2000) as number;
  const img = height <= 8600
    ? await s.page.screenshot({ fullPage: true, type: 'jpeg', quality: 80, timeout: 20_000 })
    : await s.page.screenshot({ fullPage: true, type: 'jpeg', quality: 80, timeout: 20_000, clip: { x: 0, y: 0, width: 1280, height: 8600 } });
  const extra: Record<string, unknown> = { caption: caption.slice(0, 1000), parse_mode: 'HTML' };
  if (markup) extra.reply_markup = markup;
  return tgFile('sendPhoto', s.chatId, img, `Formular_${fileSafe(s.job.company)}.jpg`, extra);
}

function close(ref: string) {
  const s = sessions.get(ref);
  if (!s) return;
  clearTimeout(s.timer);
  void s.context.close().catch(() => {});
  sessions.delete(ref);
}

export interface FormResult { ok: boolean; offen: string[]; captcha: boolean; note?: string }

async function fillAndReport(store: Store, s: Session): Promise<FormResult> {
  const app = await store.getApplication(s.job.id);
  const letter = app?.letter ?? '';
  const standing = (await store.kvGet('answers')) ?? '';
  s.fields = await collectFields(s.page);
  if (!s.fields.length || !(await hasForm(s.page))) {
    await tg('sendMessage', { chat_id: s.chatId, text: `Auf der Seite finde ich kein Bewerbungsformular. Bewirb dich hier bitte direkt: ${s.page.url()}` });
    close(s.ref);
    return { ok: false, offen: [], captcha: false, note: 'kein Formular gefunden' };
  }
  s.plan = await planFill(s.job, s.fields, letter, [standing, s.extra].filter(Boolean).join('\n'), Object.keys(s.files).filter((k) => s.files[k].length));
  const done = await applyPlan(s, letter);
  const docs = done.filter((d) => d.startsWith('📎')).map((d) => d.slice(3));
  const captcha = (await s.page.locator('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"]').count()) > 0;
  // Kurz und menschlich: was drin ist, sieht Martin auf dem Bild. Nur sagen, was fehlt.
  const uploaded = docs.length === 2 ? 'beide PDFs sind drin' : docs.length === 1 ? `${docs[0] === 'lebenslauf' ? 'Lebenslauf' : 'Anschreiben'} ist drin` : 'PDFs gingen nicht rein, die musst du selbst hochladen';
  const text = [
    `Formular bei ${esc(s.job.company)} steht, ${uploaded}.`,
    s.plan.offen.length
      ? 'Ich frage dich gleich nach den fehlenden Angaben. Antworte einfach hier im Chat, ich fülle für dich weiter aus.'
      : docs.includes('lebenslauf') ? 'Kontrollblick drauf. Passt alles: Absenden.' : 'Der Lebenslauf-Upload hat nicht geklappt. Antworte hier, damit wir das klären können.',
    captcha ? 'Die Seite hat eine Captcha-Prüfung, das Absenden könnte deshalb scheitern.' : '',
  ].filter(Boolean).join('\n\n');
  // Absenden nur, wenn nichts offen ist UND der Lebenslauf wirklich drin ist (sonst ist es vermutlich das falsche Formular)
  const canSend = !s.plan.offen.length && docs.includes('lebenslauf');
  const rows = [[...(canSend ? [button('✅ Absenden', `send:${s.ref}`)] : []), button('❌ Abbrechen', `stop:${s.ref}`)], [{ text: '🔗 Im Browser neu ausfüllen', url: s.page.url() }]];
  await store.kvSet(`form_draft:${s.chatId}:${s.job.id}`, JSON.stringify({ extra: s.extra, questions: s.plan.offen }));
  const msg = await screenshot(s, text, { inline_keyboard: rows });
  await store.kvSet(`form_msg:${s.chatId}:${msg.message_id}`, s.ref);
  if (s.plan.offen.length) {
    const question = await tg('sendMessage', { chat_id: s.chatId, text: `Kamerad, für ${s.job.company}:\n\n${s.plan.offen.slice(0, 2).join('\n\n')}\n\nAntworte in deinen Worten hier im Chat. Ich trage es ein und frage danach nur noch nach dem, was fehlt.`, reply_markup: { force_reply: true, selective: true } });
    await store.kvSet(`form_msg:${s.chatId}:${question.message_id}`, s.ref);
  }
  return { ok: true, offen: s.plan.offen, captcha };
}

/** Portal verlangt ein Konto: Martin legt es mit einem vorgeschlagenen Passwort an, der Bot loggt sich danach selbst ein. */
async function askForAccount(store: Store, chatId: string, job: StoredJob, ref: string, e: LoginRequired): Promise<FormResult> {
  await store.kvSet(`pending_portal:${chatId}`, JSON.stringify({ portal: e.portal, jobId: job.id, ref }));
  if (e.failed) {
    await tg('sendMessage', {
      chat_id: chatId,
      text: `Die Anmeldung bei ${job.company} hat nicht geklappt. Hast du die Bestätigungsmail schon geklickt? Wenn du ein anderes Passwort benutzt, schreib mir einfach E-Mail und Passwort, ich speichere sie verschlüsselt und lösche deine Nachricht sofort.`,
      reply_markup: { inline_keyboard: [[button('🔄 Nochmal versuchen', `form:${ref}`)]] },
    });
    return { ok: false, offen: [], captcha: false, note: 'Login fehlgeschlagen, Martin wurde gefragt' };
  }
  let cred = await getCredential(store, e.portal);
  if (!cred) {
    cred = { portal: e.portal, username: CONTACT.email, password: generatePassword(), status: 'wartet' };
    await saveCredential(store, cred);
  }
  const msg = await tg('sendMessage', {
    chat_id: chatId,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    text: [
      `${esc(job.company.replace(/ (GmbH|AG|SE|KG|mbH).*$/, ''))} nimmt Bewerbungen nur über ein eigenes Bewerberkonto an. Leg es bitte einmal an, danach melde ich mich selbst an und fülle alles aus.`,
      '',
      `E-Mail: <code>${esc(cred.username)}</code>`,
      `Passwort: <code>${esc(cred.password)}</code> (antippen zum Kopieren)`,
      '',
      'Nach dem Anlegen die Bestätigungsmail klicken und dann hier tippen. Diese Nachricht lösche ich danach.',
    ].join('\n'),
    reply_markup: { inline_keyboard: [
      [{ text: '📝 Konto anlegen', url: e.registerUrl ?? e.loginUrl }],
      [button('✅ Konto ist angelegt', `acct:${ref}`)],
      [button('🔑 Ich habe schon ein Konto', `acctown:${ref}`)],
    ] },
  });
  await store.kvSet(`pending_portal_msg:${chatId}`, String(msg.message_id));
  return { ok: false, offen: [], captcha: false, note: 'Konto nötig, Martin hat Anleitung und Passwort bekommen' };
}

/** Knopf "Konto ist angelegt": Zugang freischalten, Nachricht mit Passwort löschen, Formular neu starten. */
export async function accountCreated(store: Store, chatId: string): Promise<{ jobId: string; ref: string } | null> {
  const pending = await store.kvGet(`pending_portal:${chatId}`);
  if (!pending) return null;
  const { portal, jobId, ref } = JSON.parse(pending);
  const cred = await getCredential(store, portal);
  if (cred) await saveCredential(store, { ...cred, status: 'aktiv' });
  const msgId = await store.kvGet(`pending_portal_msg:${chatId}`);
  if (msgId) await tg('deleteMessage', { chat_id: chatId, message_id: Number(msgId) }).catch(() => {});
  return { jobId, ref };
}

/** Martin nennt eigene Zugangsdaten (über den Chat): verschlüsselt speichern. */
export async function saveOwnAccount(store: Store, chatId: string, username: string, password: string, portal?: string): Promise<string | null> {
  const pending = await store.kvGet(`pending_portal:${chatId}`);
  const key = portal || (pending ? JSON.parse(pending).portal : null);
  if (!key) return null;
  await saveCredential(store, { portal: key, username, password, status: 'aktiv' });
  return key;
}

/** Mehrseitige Formulare (Workday, SuccessFactors): auf "Weiter" klicken und die nächste Seite ausfüllen. */
export async function nextFormPage(store: Store, chatId: string): Promise<FormResult | null> {
  const jobId = await store.kvGet(`active_job:${chatId}`);
  const s = [...sessions.values()].reverse().find((x) => x.chatId === chatId && (!jobId || x.job.id === jobId));
  if (!s) return null;
  const btn = s.page.getByRole('button', { name: /^(weiter|nächste|next|continue|fortfahren|speichern und weiter|save and continue)/i }).first();
  if (!(await btn.count())) return { ok: false, offen: s.plan.offen, captcha: false, note: 'kein Weiter-Knopf auf der Seite' };
  await btn.click({ timeout: 8000 });
  await s.page.waitForTimeout(4000);
  return fillAndReport(store, s);
}

/** Offenes Formular dieses Chats (das zuletzt geöffnete). */
export function activeForm(chatId: string, jobId?: string): { company: string; title: string; offen: string[]; filledWith: string } | null {
  const s = [...sessions.values()].reverse().find((x) => x.chatId === chatId && (!jobId || x.job.id === jobId));
  return s ? { company: s.job.company, title: s.job.title, offen: s.plan.offen, filledWith: s.extra } : null;
}

/** Angaben in natürlicher Sprache ins offene Formular übernehmen und neu ausfüllen (für den Chat-Agenten). */
export async function refillForm(store: Store, chatId: string, angaben: string): Promise<FormResult | null> {
  const jobId = await store.kvGet(`active_job:${chatId}`);
  const s = [...sessions.values()].reverse().find((x) => x.chatId === chatId && x.job.id === jobId);
  if (!s) return null;
  clearTimeout(s.timer);
  s.timer = setTimeout(() => close(s.ref), 20 * 60_000);
  s.extra = [s.extra, angaben].filter(Boolean).join('\n');
  await store.kvSet(`form_draft:${chatId}:${s.job.id}`, JSON.stringify({ extra: s.extra, questions: s.plan.offen }));
  return fillAndReport(store, s);
}

export async function startForm(store: Store, chatId: string, job: StoredJob, ref: string, extra = ''): Promise<FormResult | null> {
  for (const old of [...sessions.values()]) if (old.chatId === chatId) close(old.ref);
  await store.kvSet(`active_job:${chatId}`, job.id);
  const draft = JSON.parse((await store.kvGet(`form_draft:${chatId}:${job.id}`)) ?? '{}');
  extra = [draft.extra, extra].filter(Boolean).join('\n');
  await store.kvSet(`form_draft:${chatId}:${job.id}`, JSON.stringify({ ...draft, extra }));
  const wait = await tg('sendMessage', { chat_id: chatId, text: `⏳ Rücke aus zum Bewerbungsformular bei ${job.company}, dauert etwa eine Minute …` }).catch(() => null);
  const dropWait = () => (wait ? tg('deleteMessage', { chat_id: chatId, message_id: wait.message_id }).catch(() => {}) : undefined);
  let applyUrl = (await store.kvGet(`apply_url:${job.id}`)) ?? job.url;
  // Nie auf Seiten der Arbeitsagentur (Captcha) oder Konto-Portalen ausfüllen: erst die Original-Anzeige suchen
  if (/arbeitsagentur\.de/.test(applyUrl)) {
    applyUrl = (await findOriginalPosting(job)) ?? applyUrl;
    await store.kvSet(`apply_url:${job.id}`, applyUrl);
  }
  if (/arbeitsagentur\.de/i.test(applyUrl)) {
    if (wait) await tg('deleteMessage', { chat_id: chatId, message_id: wait.message_id }).catch(() => {});
    await tg('sendMessage', { chat_id: chatId, text: `Für diese Stelle finde ich keine eigene Online-Anzeige von ${job.company}, nur die der Arbeitsagentur. Dort steht der Bewerbungsweg hinter einer Sicherheitsabfrage, die musst du selbst lösen: ${applyUrl}` });
    return { ok: false, offen: [], captcha: false, note: 'nur Arbeitsagentur-Anzeige, Martin wurde informiert' };
  }
  const app = await store.getApplication(job.id);
  const dir = mkdtempSync(join(tmpdir(), 'bewerbung-'));
  const files = await materialize(store);
  if (app?.letter) { const p = join(dir, `Anschreiben_Martin_Spalevic.pdf`); writeFileSync(p, await letterPdf(app.letter, job)); files.anschreiben = [p]; }

  const browser = await getBrowser();
  const context = await browser.newContext({ locale: 'de-DE', viewport: { width: 1280, height: 900 }, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36' });
  const page = await context.newPage();
  const s: Session = { job, chatId, ref, context, page, fields: [], plan: { fill: [], files: [], check: [], consent: [], offen: [] }, files, extra, timer: setTimeout(() => close(ref), 20 * 60_000) };
  sessions.set(ref, s);
  try {
    await openForm(page, applyUrl, store);
    await dropWait();
    return await fillAndReport(store, s);
  } catch (e) {
    if (e instanceof LoginRequired) {
      await dropWait();
      close(ref);
      return askForAccount(store, chatId, job, ref, e);
    }
    await dropWait();
    await tg('sendMessage', { chat_id: chatId, text: `Das Formular konnte ich nicht ausfüllen (${(e as Error).message.slice(0, 120)}). Bitte bewirb dich direkt:\n${applyUrl}` });
    close(ref);
    return { ok: false, offen: [], captcha: false, note: (e as Error).message.slice(0, 120) };
  }
}

/** Antwort auf den Formular-Screenshot: fehlende Angaben übernehmen und neu ausfüllen. */
export async function submitForm(store: Store, chatId: string, ref: string): Promise<'ok' | 'unklar' | 'weg'> {
  const s = sessions.get(ref);
  if (!s) { await tg('sendMessage', { chat_id: chatId, text: 'Das Formular ist nicht mehr offen (nach 20 Minuten schließe ich es). Tipp nochmal auf 🤖 Für mich bewerben.' }); return 'weg'; }
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
  const files: Record<string, string[]> = { lebenslauf: [new URL('../data/docs/lebenslauf.pdf', import.meta.url).pathname] };
  files.anschreiben = [join(dir, 'Anschreiben_Martin_Spalevic.pdf')];
  writeFileSync(files.anschreiben[0], await letterPdf(letter, job));
  const browser = await getBrowser();
  const context = await browser.newContext({ locale: 'de-DE', viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const s: Session = { job, chatId: '', ref: 'test', context, page, fields: [], plan: { fill: [], files: [], check: [], consent: [], offen: [] }, files, extra: '', timer: setTimeout(() => {}, 0) };
  try {
    await openForm(page, job.url);
    s.fields = await collectFields(page);
    console.log(`Formular: ${page.url()}, Eingaben: ${await page.locator('input, textarea, select').count()}, erkannt: ${s.fields.length}`);
    s.plan = await planFill(job, s.fields, letter, '', Object.keys(s.files).filter((k) => s.files[k].length));
    const done = await applyPlan(s, letter);
    writeFileSync(outPng, await page.screenshot({ fullPage: true }));
    return { fields: s.fields.length, done, plan: s.plan };
  } finally {
    await context.close();
    await browser.close();
  }
}
