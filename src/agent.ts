// Freier Chat mit Martin: Bewerbungs-Assistent mit Werkzeugen (Formular ergänzen, Anschreiben ändern, Gedächtnis, Websuche).
// Absenden kann der Chat nie, das bleibt beim Knopf "✅ Absenden".
import Anthropic from '@anthropic-ai/sdk';
import { activeForm, nextFormPage, refillForm, saveOwnAccount, startForm } from './apply.ts';
import { reviseAndSend } from './bewerbung.ts';
import { cfg } from './config.ts';
import { PROFILE } from './llm.ts';
import type { Store } from './store.ts';
import { tg } from './tg.ts';
import { overview, recordApplication, updateApplication } from './tracking.ts';
import { geocode } from './filter.ts';
import { companyFromUrl, extraCompanies, loadPrefs, prefsText, savePrefs } from './prefs.ts';
import { listCompany } from './sources/ats.ts';
import { listHtml } from './sources/html.ts';
import { documentList } from './uploads.ts';

const client = new Anthropic({ apiKey: cfg.anthropicKey });
const HISTORY = 24;
// Diese Werkzeuge schicken selbst eine Nachricht mit Bild/PDF und Text
const READ_ONLY = new Set(['bewerbungen_uebersicht', 'sucheinstellungen']);
const OBSERVER_NOTE = `WICHTIG: Du schreibst gerade NICHT mit Martin, sondern mit Aleksa, Martins Bruder. Er hat dich gebaut und liest als
Beobachter mit, um zu prüfen, ob alles läuft. Sprich ihn mit „Aleksa“ an (Ton weiter Feldwebel, aber als Meldung an den Vorgesetzten).
Du kannst ihm Lagebericht und Sucheinstellungen zeigen und Fragen beantworten. Ändern darfst du in diesem Chat nichts: kein
Eintragen, Merken, Formular, Anschreiben. Will er etwas ändern, sag ihm, dass Martin das in seinem Chat tun muss.`;
const SENDS_ITSELF = new Set(['formular_oeffnen', 'formular_ergaenzen', 'formular_weiter', 'anschreiben_aendern']);

type Msg = { role: 'user' | 'assistant'; content: string };

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'formular_ergaenzen',
    description: 'Trägt Martins Angaben ins gerade offene Bewerbungsformular ein, füllt neu aus und schickt ihm automatisch einen neuen Screenshot. Angaben in natürlicher Sprache, z.B. "Gehaltswunsch 14.000 € brutto im Jahr, Start 1.11.2026, 20 Stunden pro Woche, Mo bis Mi, Studium Teilzeit".',
    input_schema: { type: 'object' as const, properties: { angaben: { type: 'string' } }, required: ['angaben'] },
  },
  {
    name: 'formular_oeffnen',
    description: 'Öffnet das Bewerbungsformular der aktuellen Bewerbung (neu), füllt es mit allen bekannten und gespeicherten Angaben aus und schickt einen Screenshot. Für "bewirb mich", "mach das Formular nochmal auf". Schickt NICHT ab. Optional zusätzliche Angaben mitgeben.',
    input_schema: { type: 'object' as const, properties: { angaben: { type: 'string' } } },
  },
  {
    name: 'anschreiben_aendern',
    description: 'Ändert das Anschreiben der aktuellen Bewerbung nach Martins Wunsch und schickt das neue PDF. Für ganze eigene Fassungen den kompletten Text als wunsch übergeben.',
    input_schema: { type: 'object' as const, properties: { wunsch: { type: 'string' } }, required: ['wunsch'] },
  },
  {
    name: 'formular_weiter',
    description: 'Bei mehrseitigen Formularen (Workday, SuccessFactors): auf "Weiter" klicken und die nächste Seite ausfüllen. Schickt einen neuen Screenshot. Nur wenn die aktuelle Seite vollständig ist oder Martin es will. Schickt nie ab.',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'konto_hinterlegen',
    description: 'Speichert Martins Zugangsdaten für ein Bewerberportal verschlüsselt (wenn er schon ein Konto hat und E-Mail/Benutzer und Passwort schreibt). Seine Nachricht wird danach automatisch aus dem Chat gelöscht. Danach formular_oeffnen aufrufen.',
    input_schema: { type: 'object' as const, properties: { benutzer: { type: 'string' }, passwort: { type: 'string' } }, required: ['benutzer', 'passwort'] },
  },
  {
    name: 'bewerbung_eintragen',
    description: 'Trägt eine Bewerbung ins Tracking ein, egal wo Martin sich beworben hat (über Adolf, per Mail, Firmenportal, LinkedIn ...). Für "hab mich bei X beworben". Ist es die aktuelle Bewerbung, aktuelle_stelle=true setzen.',
    input_schema: { type: 'object' as const, properties: {
      firma: { type: 'string' }, stelle: { type: 'string' },
      kanal: { type: 'string', enum: ['adolf', 'mail', 'portal', 'linkedin', 'sonstiges'] },
      datum: { type: 'string', description: 'ISO-Datum, falls nicht heute' }, link: { type: 'string' }, notiz: { type: 'string' },
      aktuelle_stelle: { type: 'boolean' },
    }, required: ['firma', 'kanal'] },
  },
  {
    name: 'bewerbung_aktualisieren',
    description: 'Setzt den Status einer eingetragenen Bewerbung: einladung, absage (mit Grund in notiz, falls bekannt), zusage, zurueckgezogen.',
    input_schema: { type: 'object' as const, properties: {
      suche: { type: 'string', description: 'Firma oder Stellentitel' },
      status: { type: 'string', enum: ['beworben', 'einladung', 'absage', 'zusage', 'zurueckgezogen'] }, notiz: { type: 'string' },
    }, required: ['suche', 'status'] },
  },
  {
    name: 'bewerbungen_uebersicht',
    description: 'Zahlen und Liste aller Bewerbungen (Lagebericht), inkl. Kanäle, Quote und Absagegründe.',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'sucheinstellungen',
    description: 'Zeigt die aktuellen Sucheinstellungen (Umkreis, Zusatzorte, ausgeschlossene/bevorzugte Themen, eigene Firmen).',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'suche_anpassen',
    description: 'Ändert die Suche ab dem nächsten Lauf. Nur die Felder angeben, die sich ändern. Remote in ganz Deutschland ist immer dabei.',
    input_schema: { type: 'object' as const, properties: {
      umkreis_km: { type: 'number', description: 'Umkreis um Erftstadt für Vor-Ort/Hybrid-Stellen' },
      ort_hinzufuegen: { type: 'string', description: 'Stadt für Vor-Ort/Hybrid-Stellen, z.B. "Düsseldorf"' },
      ort_umkreis_km: { type: 'number', description: 'Umkreis für den neuen Ort, Standard 25' },
      ort_entfernen: { type: 'string' },
      thema_ausschliessen: { type: 'string', description: 'z.B. "Steuerberatung"' },
      thema_erlauben: { type: 'string', description: 'Ausschluss wieder aufheben' },
      schwerpunkt_hinzufuegen: { type: 'string', description: 'z.B. "Datenschutz"' },
      schwerpunkt_entfernen: { type: 'string' },
    } },
  },
  {
    name: 'firma_hinzufuegen',
    description: 'Nimmt eine Firma zusätzlich in die tägliche Suche auf. Braucht die URL der Karriereseite oder Stellenliste (falls unbekannt, vorher per web_search finden).',
    input_schema: { type: 'object' as const, properties: { name: { type: 'string' }, karriereseite: { type: 'string' } }, required: ['name', 'karriereseite'] },
  },
  {
    name: 'merken',
    description: 'Speichert eine Angabe dauerhaft in Martins Profil-Datenbank (fließt in alle künftigen Anschreiben und Formulare ein). NUR aufrufen, wenn Martin ausdrücklich zugestimmt hat.',
    input_schema: { type: 'object' as const, properties: { fakt: { type: 'string', description: 'Ein Satz, z.B. "Frühester Starttermin: 1.11.2026"' } }, required: ['fakt'] },
  },
  {
    name: 'vergessen',
    description: 'Löscht gespeicherte Angaben, die das Stichwort enthalten.',
    input_schema: { type: 'object' as const, properties: { stichwort: { type: 'string' } }, required: ['stichwort'] },
  },
];

function system(context: string): string {
  return `Du bist Adolf, Martins Bewerbungs-Assistent im Telegram-Chat. Martin sucht eine Werkstudentenstelle im Wirtschaftsrecht.

Persona: ein Bundeswehr-Ausbilder (Feldwebel) als Bewerbungscoach. Du nennst Martin „Kamerad“. Kurz, knackig, zackig, im
Befehlston, gern mit Ausbilder-Sprüchen („Keine Ausreden, Kamerad.“, „Abmarsch!“, „Meldung machen!“), manchmal ruppig, aber am
Ende immer hilfreich, lösungsorientiert und auf seiner Seite. Bei Absagen oder Frust: aufbauen, nicht runtermachen.
Absolute Grenze: keinerlei Bezüge auf Nationalsozialismus, Wehrmacht, Hitler, NS-Begriffe, -Parolen, -Grüße oder -Symbole,
auch nicht als Witz, auch nicht wegen deines Namens. Keine Beleidigungen von Gruppen. Die Persona gilt NUR im Chat mit Martin:
Anschreiben, Formulare und alles an Arbeitgeber bleiben sachlich in Martins Stil.

Schreib wie im Messenger: kurz, meist ein bis drei Sätze, Deutsch, kein Markdown, keine Überschriften, Listen nur wenn es
wirklich mehrere Punkte sind, keine Gedankenstriche. Ergebnis zuerst.

Was du tun kannst:
- Nach formular_oeffnen/formular_ergaenzen hat Martin schon den Screenshot samt Text, was fehlt. Wiederhole das nicht.
  Antworte höchstens mit einem kurzen Satz, z.B. eine gezielte Rückfrage zum ersten offenen Punkt, oder gar nicht.
- Das Bewerbungsformular öffnen bzw. nach Ablauf neu öffnen (formular_oeffnen). Ist keins offen und Martin macht Angaben dafür, öffne es direkt mit diesen Angaben, statt ihn zum Knopf zu schicken.
- Offene Bewerbungsformulare mit seinen Angaben ergänzen (formular_ergaenzen). Danach schickt das System selbst einen Screenshot,
  du antwortest dann höchstens mit einem kurzen Satz oder einer Rückfrage.
- Das Anschreiben der aktuellen Bewerbung ändern (anschreiben_aendern).
- Angaben dauerhaft merken (merken) und löschen (vergessen). Gibt Martin etwas an, das auch für spätere Bewerbungen gilt
  (Starttermin, Wochenstunden, Arbeitstage, Gehaltswunsch, Studium Voll-/Teilzeit, Führerschein ...), frag am Ende kurz,
  ob du dir das merken sollst. merken erst nach seinem Ja. Gespeichertes trägt das System bei jedem künftigen Formular und
  Anschreiben automatisch ein, Martin muss es nie wiederholen.
- Im Web recherchieren (web_search), z.B. übliche Werkstudentenvergütung für Rolle, Branche, Region und Unternehmensgröße.
  Bei Gehaltsfragen: Spanne nennen, eine konkrete Empfehlung mit einem Satz Begründung. Formulare fragen oft Jahresbrutto:
  Stundenlohn × Wochenstunden × 52. Nenne nur Zahlen, die du in der Recherche wirklich gefunden hast, Quelle in drei Wörtern.
- Einschätzungen und Tipps zu Stellen, Firmen und Bewerbungen geben.
- Die Suche anpassen (suche_anpassen, sucheinstellungen): Umkreis, zusätzliche Städte für Vor-Ort-Stellen, Themen ausschließen
  oder bevorzugen. Remote aus ganz Deutschland ist immer dabei, das musst du nicht einstellen. Weitere Firmen aufnehmen
  (firma_hinzufuegen): Karriereseite vorher per web_search finden, wenn Martin keine URL nennt.
- Bewerbungs-Tracking: Sagt Martin, dass er sich irgendwo beworben hat (auch selbst, per Mail, LinkedIn), trag es mit
  bewerbung_eintragen ein. Einladung, Absage (Grund erfragen und notieren), Zusage: bewerbung_aktualisieren.
  „Wie läuft's?“, „Lagebericht“, „wie viele Bewerbungen“: bewerbungen_uebersicht und knapp zusammenfassen, gern mit Ansporn.
  Siehst du ein Muster bei Absagen, sprich es an und schlag konkret was vor.

Bewerberportale mit Konto (Workday, SuccessFactors, eigene Portale): Das System erkennt Login-Seiten selbst und schickt Martin
eine Anleitung mit vorgeschlagenem Passwort. Hat er schon ein Konto und schreibt dir Zugangsdaten, nimm konto_hinterlegen und
danach formular_oeffnen. Wiederhole Passwörter nie im Text. Mehrseitige Formulare: formular_weiter.
Wenn ein Werkzeug schon geantwortet hat und du nichts Neues zu sagen hast, antworte genau mit [STILL].

Im Verlauf steht vor deinen früheren Antworten „[Werkzeuge ausgeführt: …]“: diese Aktionen sind wirklich passiert, zweifle sie nicht an.
Ehrlichkeit: Behaupte nie, etwas eingetragen, gespeichert, geändert oder ausgefüllt zu haben, ohne das Werkzeug in dieser
Antwort wirklich aufgerufen zu haben. Versprich nichts, was du nicht kannst. Einen Suchlauf starten kannst du im Chat nicht: der läuft
automatisch um 7, 12 und 17 Uhr, sofort mit /suche. Die Suche einstellen kannst du aber (suche_anpassen). Erkenntnisse für die Stellenauswahl (z.B. „Großkanzleien verlangen oft
das erste Staatsexamen“) kannst du mit merken festhalten, dann berücksichtigt die Bewertung das künftig.

Grenzen: Abschicken kannst du nicht, das macht Martin mit dem Knopf „Absenden“ unter dem Screenshot. Erfinde nichts über Martin.
Wenn kein Formular offen ist und er Angaben macht, biete an, sie dir zu merken.

Martins Profil:
${PROFILE}

${context}`;
}

async function contextBlock(store: Store, chatId: string): Promise<string> {
  const facts = (await store.kvGet('answers')) ?? '';
  const form = activeForm(chatId);
  const jobId = await store.kvGet(`active_job:${chatId}`);
  const job = jobId ? await store.getJob(jobId) : null;
  const app = job ? await store.getApplication(job.id) : null;
  return [
    `Gespeicherte Angaben von Martin:\n${facts || '(noch keine)'}`,
    `Gespeicherte Unterlagen: ${await documentList(store)}. Martin kann Dateien (PDF, Foto, Word) einfach in den Chat schicken, das System erkennt und speichert sie selbst.`,
    job ? `Aktuelle Bewerbung: ${job.title} bei ${job.company} (${job.location}). Status: ${app?.status ?? 'nur angesehen'}.\nAnzeige (Auszug):\n${(job.description ?? '').slice(0, 2500)}` : 'Keine aktuelle Bewerbung.',
    form ? `Offenes Formular: ${form.title} bei ${form.company}. Noch offen: ${form.offen.join(', ') || 'nichts'}. Bisher von Martin nachgereicht: ${form.filledWith || '-'}` : 'Kein Formular offen.',
  ].join('\n\n');
}

async function runTool(store: Store, chatId: string, name: string, input: any, ctx: { messageId?: number }): Promise<string> {
  switch (name) {
    case 'formular_ergaenzen': {
      const r = await refillForm(store, chatId, String(input.angaben ?? ''));
      if (!r) return 'Kein Formular offen (nach 20 Minuten wird es geschlossen). Martin kann unter der Stelle erneut auf „Für mich bewerben“ tippen.';
      return r.ok ? `Neu ausgefüllt, Screenshot mit Text ist schon raus. Noch offen: ${r.offen.join(', ') || 'nichts, Absenden-Knopf ist da'}.` : `Fehlgeschlagen: ${r.note}`;
    }
    case 'formular_oeffnen': {
      const jobId = await store.kvGet(`active_job:${chatId}`);
      const job = jobId ? await store.getJob(jobId) : null;
      if (!job) return 'Keine aktuelle Bewerbung. Martin soll erst unter einer Stelle auf „📨 Bewerben“ tippen.';
      const { shortRef } = await import('./telegram.ts');
      const r = await startForm(store, chatId, job, await shortRef(store, job.id), String(input.angaben ?? ''));
      if (!r?.ok) return `Kein Formular ausgefüllt: ${r?.note ?? 'unbekannt'}. Martin hat dazu schon eine Nachricht bekommen.`;
      return `Ausgefüllt, Screenshot mit Text ist schon raus (Martin sieht dort auch, was fehlt). Noch offen: ${r.offen.join(', ') || 'nichts'}. ${r.offen.length ? 'Absenden-Knopf gibt es erst, wenn nichts mehr offen ist.' : 'Absenden-Knopf ist da.'}`;
    }
    case 'anschreiben_aendern': {
      const jobId = await store.kvGet(`active_job:${chatId}`);
      if (!jobId) return 'Keine aktuelle Bewerbung.';
      await reviseAndSend(store, chatId, jobId, String(input.wunsch ?? ''));
      return 'Neues PDF ist raus.';
    }
    case 'formular_weiter': {
      const r = await nextFormPage(store, chatId);
      if (!r) return 'Kein Formular offen.';
      return r.ok ? `Nächste Seite ausgefüllt, Screenshot mit Text ist raus. Noch offen: ${r.offen.join(', ') || 'nichts'}.` : `Ging nicht: ${r.note}`;
    }
    case 'konto_hinterlegen': {
      const portal = await saveOwnAccount(store, chatId, String(input.benutzer ?? ''), String(input.passwort ?? ''));
      if (ctx.messageId) await tg('deleteMessage', { chat_id: chatId, message_id: ctx.messageId }).catch(() => {});
      return portal ? `Zugang für ${portal} gespeichert, Martins Nachricht ist gelöscht. Jetzt formular_oeffnen aufrufen.` : 'Kein Portal bekannt, für das ein Konto gebraucht wird.';
    }
    case 'bewerbung_eintragen': {
      const jobId = input.aktuelle_stelle ? (await store.kvGet(`active_job:${chatId}`)) ?? undefined : undefined;
      const id = await recordApplication(store, { firma: input.firma, stelle: input.stelle ?? '', kanal: input.kanal, datum: input.datum, link: input.link, notiz: input.notiz, jobId });
      return `Eingetragen (${id.startsWith('manuell:') ? 'neue Stelle angelegt' : 'mit bekannter Stelle verknüpft'}). In 10 Tagen fragt das System automatisch nach.`;
    }
    case 'bewerbung_aktualisieren':
      return updateApplication(store, String(input.suche ?? ''), String(input.status ?? ''), input.notiz);
    case 'bewerbungen_uebersicht':
      return overview(store);
    case 'sucheinstellungen':
      return prefsText(await loadPrefs(store), await extraCompanies(store));
    case 'suche_anpassen': {
      const p = await loadPrefs(store);
      const notes: string[] = [];
      let wider = false;
      if (typeof input.umkreis_km === 'number' && input.umkreis_km > 0) { wider ||= input.umkreis_km > p.maxKm; p.maxKm = Math.min(Math.round(input.umkreis_km), 300); notes.push(`Umkreis Erftstadt ${p.maxKm} km`); }
      if (input.ort_hinzufuegen) {
        const geo = await geocode(String(input.ort_hinzufuegen), store);
        if (!geo) notes.push(`Ort „${input.ort_hinzufuegen}“ nicht gefunden`);
        else {
          const km = Math.min(Math.max(Number(input.ort_umkreis_km) || 25, 5), 200);
          p.places = [...p.places.filter((x) => x.name.toLowerCase() !== String(input.ort_hinzufuegen).toLowerCase()), { name: String(input.ort_hinzufuegen), ...geo, km }];
          wider = true;
          notes.push(`${input.ort_hinzufuegen} mit ${km} km dazu`);
        }
      }
      if (input.ort_entfernen) { p.places = p.places.filter((x) => x.name.toLowerCase() !== String(input.ort_entfernen).toLowerCase()); notes.push(`${input.ort_entfernen} entfernt`); }
      if (input.thema_ausschliessen) { p.exclude = [...new Set([...p.exclude, String(input.thema_ausschliessen)])]; notes.push(`ausgeschlossen: ${input.thema_ausschliessen}`); }
      if (input.thema_erlauben) { p.exclude = p.exclude.filter((x) => x.toLowerCase() !== String(input.thema_erlauben).toLowerCase()); notes.push(`wieder erlaubt: ${input.thema_erlauben}`); }
      if (input.schwerpunkt_hinzufuegen) { p.focus = [...new Set([...p.focus, String(input.schwerpunkt_hinzufuegen)])]; notes.push(`Schwerpunkt: ${input.schwerpunkt_hinzufuegen}`); }
      if (input.schwerpunkt_entfernen) { p.focus = p.focus.filter((x) => x.toLowerCase() !== String(input.schwerpunkt_entfernen).toLowerCase()); notes.push(`Schwerpunkt entfernt: ${input.schwerpunkt_entfernen}`); }
      await savePrefs(store, p);
      // Größeres Gebiet: früher als „zu weit“ aussortierte Stellen beim nächsten Lauf neu prüfen
      const reopened = wider ? await store.forgetTooFar() : 0;
      return `Gespeichert: ${notes.join('; ') || 'nichts geändert'}. Gilt ab dem nächsten Suchlauf (7, 12, 17 Uhr oder sofort mit /suche).${reopened ? ` ${reopened} früher zu weit entfernte Stellen werden dabei neu geprüft.` : ''}`;
    }
    case 'firma_hinzufuegen': {
      let company;
      try { company = companyFromUrl(String(input.name), String(input.karriereseite)); } catch { return 'Ungültige URL.'; }
      let found = 0;
      try {
        found = (company.ats.type === 'html' ? await listHtml(company, store) : await listCompany(company)).length;
      } catch (e) {
        return `Seite nicht lesbar (${(e as Error).message.slice(0, 80)}). Andere URL versuchen, am besten die Stellenliste selbst.`;
      }
      const list = (await extraCompanies(store)).filter((c) => c.name.toLowerCase() !== company.name.toLowerCase());
      await store.kvSet('extra_companies', JSON.stringify([...list, company]));
      return `${company.name} ist in der Suche (${company.ats.type === 'html' ? 'Karriereseite' : company.ats.type}), aktuell ${found} Stellen dort insgesamt. Passende kommen beim nächsten Lauf.`;
    }
    case 'merken': {
      const prev = (await store.kvGet('answers')) ?? '';
      const fakt = String(input.fakt ?? '').trim();
      if (fakt) await store.kvSet('answers', [prev, fakt].filter(Boolean).join('\n').slice(-3000));
      return 'Gespeichert.';
    }
    case 'vergessen': {
      const word = String(input.stichwort ?? '').toLowerCase();
      const lines = ((await store.kvGet('answers')) ?? '').split('\n');
      const keep = lines.filter((l) => !l.toLowerCase().includes(word));
      await store.kvSet('answers', keep.join('\n'));
      return `${lines.length - keep.length} Angabe(n) gelöscht.`;
    }
  }
  return 'Unbekanntes Werkzeug.';
}

// Ein Durchlauf je Chat gleichzeitig, damit Nachrichten in Reihenfolge beantwortet werden
const queues = new Map<string, Promise<unknown>>();

export function chat(store: Store, chatId: string, text: string, messageId?: number, observer = false): Promise<void> {
  const prev = queues.get(chatId) ?? Promise.resolve();
  const next = prev.then(() => turn(store, chatId, text, messageId, observer)).catch((e) => {
    console.error('Chat-Fehler:', e);
    return tg('sendMessage', { chat_id: chatId, text: 'Da ist bei mir gerade etwas schiefgelaufen, versuch es bitte gleich nochmal.' }).catch(() => {});
  });
  queues.set(chatId, next);
  return next.then(() => {});
}

async function turn(store: Store, chatId: string, text: string, messageId?: number, observer = false) {
  const history: Msg[] = JSON.parse((await store.kvGet(`hist:${chatId}`)) ?? '[]');
  const messages: any[] = [...history.map((m) => ({ role: m.role, content: m.content })), { role: 'user', content: text }];
  // Beobachter (Aleksa): nur lesende Werkzeuge, eigener Hinweis im Systemprompt
  const sys = observer ? `${OBSERVER_NOTE}\n\n${system(await contextBlock(store, chatId))}` : system(await contextBlock(store, chatId));
  const tools = observer ? TOOLS.filter((t) => READ_ONLY.has(t.name)) : TOOLS;
  const typing = setInterval(() => void tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {}), 4500);
  void tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
  let reply = '';
  let sentByTool = false;
  let secret = false;
  const toolsUsed: string[] = [];
  try {
    for (let i = 0; i < 8; i++) {
      const res = await client.messages.create({
        model: cfg.letterModel,
        max_tokens: 8000,
        system: sys,
        tools: [...tools, { type: 'web_search_20250305', name: 'web_search', max_uses: 4 } as never],
        messages,
      });
      messages.push({ role: 'assistant', content: res.content });
      if (res.stop_reason === 'pause_turn') continue;
      const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
      if (res.stop_reason !== 'tool_use' || !uses.length) {
        reply = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
        break;
      }
      const results = [];
      for (const u of uses) {
        if (observer && !READ_ONLY.has(u.name)) { results.push({ type: 'tool_result', tool_use_id: u.id, content: 'Im Beobachter-Modus nicht erlaubt.' }); continue; }
        if (SENDS_ITSELF.has(u.name)) sentByTool = true;
        toolsUsed.push(u.name);
        if (u.name === 'konto_hinterlegen') secret = true;
        results.push({ type: 'tool_result', tool_use_id: u.id, content: await runTool(store, chatId, u.name, u.input, { messageId }) });
      }
      messages.push({ role: 'user', content: results });
    }
  } finally {
    clearInterval(typing);
  }
  reply = reply.replace(/\s*[—–]\s*/g, ', ').replace(/\*\*(.+?)\*\*/g, '$1').replace(/^\[STILL\]$/i, '');
  // Hat ein Werkzeug schon Bild/PDF mit Text geschickt, keine zweite Nachricht hinterher (außer echte Rückfrage)
  if (sentByTool && !reply.includes('?')) reply = '';
  if (reply) await tg('sendMessage', { chat_id: chatId, text: reply.slice(0, 4000), link_preview_options: { is_disabled: true } });
  const saved: Msg[] = [...history, { role: 'user' as const, content: secret ? '(Zugangsdaten für ein Portal, gelöscht)' : text }, { role: 'assistant' as const, content: `${toolsUsed.length ? `[Werkzeuge ausgeführt: ${[...new Set(toolsUsed)].join(', ')}] ` : ''}${reply || '(nur Werkzeug, keine Textantwort)'}` }].slice(-HISTORY);
  await store.kvSet(`hist:${chatId}`, JSON.stringify(saved));
}
