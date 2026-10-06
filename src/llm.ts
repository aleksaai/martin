// Haiku bewertet die Passung, Sonnet schreibt auf Wunsch einen Anschreiben-Entwurf.
import { readdirSync, readFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { cfg } from './config.ts';
import type { RawJob } from './types.ts';

const client = new Anthropic({ apiKey: cfg.anthropicKey });
export const PROFILE = readFileSync(new URL('../data/profile.md', import.meta.url), 'utf8');
const PHONE: string = JSON.parse(readFileSync(new URL('../data/contact.json', import.meta.url), 'utf8')).phone;

export interface Verdict { score: number; reason: string; machbar: boolean; mode: string }

const SCORE_SYSTEM = `Du bewertest Stellenanzeigen für einen Bewerber. Antworte ausschließlich mit einem JSON-Objekt, ohne Text davor oder danach.

Profil des Bewerbers:
${PROFILE}

Bewertungsskala "score" (0-10):
- 9-10: Werkstudent/studentische oder wissenschaftliche Mitarbeit direkt im Wunschbereich (Wirtschaftsrecht, Verträge, AGB, Datenschutz, Arbeitsrecht, Compliance, Legal Ops, Rechtsabteilung, Wirtschaftskanzlei, Legal Tech mit juristischer Arbeit).
- 6-8: angrenzend und karriereförderlich (Steuer, Regulatorik, Datenschutz-Beratung, Einkauf/Vertragsmanagement, HR mit Arbeitsrechtsbezug, Legal-Tech-Produkt).
- 3-5: Bürotätigkeit ohne erkennbaren juristischen Bezug.
- 0-2: fachfremd (Informatik-Entwicklung, Ingenieurwesen, Marketing, Gastronomie, Verkauf, Lager) oder keine Stelle für Studierende.

"machbar": false, wenn die Stelle für ihn praktisch nicht geht: Vollzeit ohne Studentenstatus, nur für Studierende anderer Fächer
(z.B. ausdrücklich Informatik), Arbeitsort vor Ort „außerhalb des Suchgebiets“ (steht bei Ort) ohne Vollremote, Remote nur im Ausland,
oder verlangt Sprachen/Qualifikationen, die er nicht hat. Sonst true.

"mode": "remote" | "hybrid" | "vor Ort" | "unbekannt", wie es in der Anzeige steht.

"reason": EIN kurzer Satz auf Deutsch, höchstens 25 Wörter, direkt an Martin gerichtet (du-Form): was er dort machen würde und welche seiner Erfahrungen dazu passt. Keine Ortsangabe (steht schon daneben), kein Gedankenstrich.

Format: {"score": 8, "machbar": true, "mode": "hybrid", "reason": "..."}`;

export async function scoreJob(job: RawJob, place: string, calibration: string, facts = ''): Promise<Verdict> {
  const text = [
    `Titel: ${job.title}`,
    `Arbeitgeber: ${job.company}`,
    `Ort: ${place}`,
    `Modus laut Quelle: ${job.mode}`,
    `Beschreibung:\n${(job.description ?? '(keine Beschreibung verfügbar, nur nach Titel urteilen)').slice(0, 6000)}`,
    calibration ? `\nSo hat Martin bisherige Vorschläge bewertet (zur Kalibrierung):\n${calibration}` : '',
    facts ? `\nMartins gespeicherte Angaben und Erkenntnisse (berücksichtigen):\n${facts}` : '',
  ].join('\n');
  const res = await client.messages.create({
    model: cfg.scoreModel,
    max_tokens: 300,
    system: SCORE_SYSTEM,
    messages: [{ role: 'user', content: text }],
  });
  const raw = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  const json = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
  return {
    score: Math.max(0, Math.min(10, Number(json.score) || 0)),
    reason: String(json.reason ?? '').replace(/\s*[—–]\s*/g, ', '),
    machbar: json.machbar !== false,
    mode: String(json.mode ?? job.mode),
  };
}

/** Martins eigene Anschreiben als Stilvorlage: Dateien in data/letters/ plus seine korrigierten Endfassungen. */
function styleBlock(extra: string[]): string {
  const dir = new URL('../data/letters/', import.meta.url);
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => /\.(txt|md)$/i.test(f)).map((f) => readFileSync(new URL(f, dir), 'utf8').trim());
  } catch { /* noch keine */ }
  const all = [...extra, ...files].filter(Boolean).slice(0, 6);
  if (!all.length) return '';
  return `\n\nSo schreibt Martin selbst. Übernimm seinen Ton, Satzbau, Einstieg und Schluss, nicht die Inhalte:\n${all
    .map((l, i) => `<beispiel ${i + 1}>\n${l.slice(0, 3000)}\n</beispiel ${i + 1}>`).join('\n')}`;
}

export interface JobText { title: string; company: string; description: string | null; url: string }

// Sonnet 5.5 denkt vor der Antwort nach, das zählt aufs Budget: großzügig bemessen, sonst bricht der Text ab
async function ask(model: string, system: string, user: string, maxTokens = 8000): Promise<string> {
  const res = await client.messages.create({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] });
  if (res.stop_reason !== 'end_turn') console.log(`Modell ${model} stoppte mit ${res.stop_reason} (${res.usage.output_tokens} Tokens)`, JSON.stringify(res.content.map((b) => b.type)));
  return res.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim().replace(/\s*[—–]\s*/g, ', ');
}

const jobBlock = (job: JobText) =>
  `Stelle: ${job.title}\nArbeitgeber: ${job.company}\nLink: ${job.url}\n\nAnzeige:\n${(job.description ?? '(keine Beschreibung gespeichert)').slice(0, 8000)}`;

async function draftLetter(job: JobText, examples: string[], answers: string): Promise<string> {
  return ask(cfg.letterModel, `Du schreibst einen Anschreiben-Entwurf für Martin Spalevic, so wie er selbst schreibt.${answers ? `\n\nMartins eigene Angaben zu Verfügbarkeit, Stunden usw. (gelten als belegt):\n${answers}` : ''}
Grundlage für Fakten ist ausschließlich sein Profil. Erfinde nichts: keine Noten, keine Zahlen, keine Tätigkeiten, keine Projekte,
die nicht im Profil stehen.

Profil:
${PROFILE}

Ausgabeformat: erste Zeile "Betreff: Bewerbung als <Stellenbezeichnung>" (grammatisch korrekt in der Einzahl für einen Mann, ohne (m/w/d), z.B. "Wissenschaftlicher Mitarbeiter im IT- und Datenrecht"), dann eine Leerzeile, dann das Anschreiben.

Aufbau wie in seinen eigenen Anschreiben:
1. Anrede (Ansprechperson aus der Anzeige, sonst "Sehr geehrte Damen und Herren,").
2. Einstieg: was ihn an genau dieser Aufgabe oder Schnittstelle reizt, mit konkretem Bezug auf Inhalte der Anzeige.
3. Studium: Bachelor Wirtschaftsrecht an der FH Aachen, jetzt Jura an der FernUniversität in Hagen mit dem Ziel des Staatsexamens.
4. Passender Schwerpunkt oder Erfahrung. Anders als in seinen alten Anschreiben hier zusätzlich ein bis zwei KONKRETE Belege aus
   seiner Werkstudentenpraxis, die zur Stelle passen (z.B. 120 Betriebsvereinbarungen geprüft, 31 Widersprüche gefunden,
   AGB und Auftragsverarbeitungsverträge entworfen, Musterklauselbibliothek). Bei Compliance/AML/Regulatorik die Bachelorarbeit.
5. "An <Firma> reizt mich besonders, ..." mit einem echten Detail aus der Anzeige.
6. Arbeitsweise in einem Absatz (strukturiert, sorgfältig, eigenständig, schnelle Einarbeitung), bei Fernstudium-Bezug zeitliche Flexibilität.
7. Schluss im Stil "Ich freue mich darauf, Sie in einem persönlichen Gespräch von meiner Motivation zu überzeugen." Dann
   "Mit freundlichen Grüßen" und "Martin Spalevic".

Stil: förmlich, Sie-Form, vollständige und eher längere Sätze wie in seinen Beispielen, 220 bis 290 Wörter (zählt hart, sonst passt es nicht auf eine Seite).
Behaupte KEINE Software-, Tool- oder Sprachkenntnisse und keine Erfahrungen, nur weil die Anzeige sie verlangt. Kenntnisse nur, wenn sie im Profil stehen (DATEV, KI-gestützte Vertragsanalyse, Englisch C2, Serbisch). Fehlt etwas Gefordertes, lass es weg.
Deutsch (Englisch nur, wenn die Anzeige englisch ist). Keine Gedankenstriche, keine Aufzählungszeichen.
Platzhalter in eckigen Klammern nur, wo Wissen wirklich fehlt (z.B. [frühester Starttermin]).
Danach nur das Anschreiben, ohne Briefkopf oder Kommentar.${styleBlock(examples)}`, jobBlock(job), 12000);
}

/** Faktenprüfung: Haiku sucht Aussagen, die das Profil nicht hergibt. Gefundene werden in einem zweiten Durchgang entfernt. */
async function unsupportedClaims(letter: string, answers: string): Promise<string[]> {
  const raw = await ask(cfg.scoreModel, `Du prüfst ein Bewerbungsanschreiben gegen das Profil des Bewerbers. Liste jede Aussage über den Bewerber
(Kenntnisse, Tools, Software, Erfahrungen, Zahlen, Tätigkeiten, Abschlüsse, Sprachen), die NICHT durch das Profil belegt ist.
Meinungen, Motivation, Interesse an der Stelle und Aussagen über den Arbeitgeber sind KEINE Behauptungen und zählen nicht.
Antworte nur mit JSON: {"unbelegt": ["wörtliches Zitat aus dem Anschreiben", ...]}, leer wenn alles belegt ist.

Profil:
${PROFILE}

Zusätzliche Angaben von Martin (gelten als belegt):
${answers || '(keine)'}`, letter, 4000);
  try {
    return JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)).unbelegt ?? [];
  } catch {
    return [];
  }
}

// Betreff-Zeile zählt nicht mit
const words = (t: string) => t.replace(/^Betreff:.*\n/i, '').trim().split(/\s+/).length;

export async function writeLetter(job: JobText, examples: string[] = [], answers = '', onStep: (s: string) => unknown = () => {}): Promise<string> {
  let letter = await draftLetter(job, examples, answers);
  await onStep('Prüfe jede Aussage gegen deinen Lebenslauf …');
  const issues = await unsupportedClaims(letter, answers);
  if (issues.length) {
    console.log('Anschreiben: unbelegte Aussagen entfernt:', issues);
    letter = await ask(cfg.letterModel, `Überarbeite das Anschreiben minimal: Entferne oder entschärfe genau diese Aussagen, weil sie nicht belegt sind,
und lass alles andere wörtlich stehen. Keine neuen Fakten hinzufügen. Keine Gedankenstriche. Nur das überarbeitete Anschreiben ausgeben.

Unbelegt:
${issues.map((i) => `- ${i}`).join('\n')}`, letter, 12000);
  }
  // Eine Seite ist Pflicht: zu lange Fassungen einmal straffen
  if (words(letter) > 300) {
    await onStep('Kürze auf eine Seite …');
    letter = await ask(cfg.letterModel, `Kürze dieses Anschreiben auf höchstens 280 Wörter. Behalte Aufbau, Ton, Anrede, Grußformel und alle
konkreten Belege, streiche Wiederholungen und allgemeine Sätze. Keine neuen Fakten, keine Gedankenstriche. Die Betreff-Zeile oben unverändert lassen. Nur das Anschreiben ausgeben.`, letter, 12000);
  }
  return letter;
}

/** Martins Änderungswunsch zu einem Anschreiben umsetzen (z.B. "kürzer", "erwähne die Bachelorarbeit"). */
export async function reviseLetter(letter: string, wish: string, answers = ''): Promise<string> {
  const revised = await ask(cfg.letterModel, `Überarbeite das Anschreiben nach Martins Wunsch. Erste Zeile "Betreff: …" beibehalten (nur ändern, wenn er es will).
Fakten nur aus seinem Profil, nichts erfinden, keine Gedankenstriche, höchstens 290 Wörter. Nur das Anschreiben ausgeben.

Profil:
${PROFILE}${answers ? `\n\nSeine Zusatzangaben:\n${answers}` : ''}

Martins Wunsch: ${wish}`, letter, 12000);
  return revised;
}

/**
 * Stellen aus der Jobbörse der Arbeitsagentur verstecken den Bewerbungsweg hinter einem Captcha.
 * Deshalb die Original-Anzeige beim Arbeitgeber per Websuche finden (ca. 2 Cent).
 */
export async function findOriginalPosting(job: { title: string; company: string; location?: string | null; description?: string | null }): Promise<string | null> {
  const ids = (job.description ?? '').match(/(job[- ]?id|referenz(nummer)?|kennziffer|stellen[- ]?id)\s*:?\s*([A-Za-z0-9\-_.]{3,})/i);
  try {
    const res = await client.messages.create({
      model: cfg.scoreModel,
      max_tokens: 1500,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 } as never],
      system: 'Finde die Original-Stellenanzeige auf der Karriereseite oder im Bewerberportal des Arbeitgebers (nicht Arbeitsagentur, Indeed, Stepstone, LinkedIn, XING, Kimeta, Jobware). Antworte am Ende nur mit JSON: {"url":"…"} oder {"url":null}, wenn du dir nicht sicher bist, dass es genau diese Stelle ist.',
      messages: [{ role: 'user', content: `Titel: ${job.title}\nArbeitgeber: ${job.company}\nOrt: ${job.location ?? ''}${ids ? `\nKennung: ${ids[3]}` : ''}` }],
    });
    const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    const url = JSON.parse(text.slice(text.lastIndexOf('{'), text.lastIndexOf('}') + 1)).url;
    return typeof url === 'string' && /^https?:\/\//.test(url) && !/arbeitsagentur|indeed|stepstone|linkedin|xing/i.test(url) ? url : null;
  } catch (e) {
    console.error('Original-Anzeige nicht gefunden:', (e as Error).message.slice(0, 120));
    return null;
  }
}

/** Kurze Begleitmail, wenn die Anzeige eine Bewerbungsadresse nennt. */
export async function writeMail(job: JobText): Promise<string> {
  return ask(cfg.letterModel, `Schreibe eine kurze Bewerbungs-E-Mail von Martin Spalevic (Profil unten). Anschreiben und Lebenslauf hängen als PDF an.
Format: erste Zeile "Betreff: ...", Leerzeile, dann 3 bis 5 Sätze, Grußformel, Name, Telefon ${PHONE}. Sie-Form, keine Floskeln, keine Gedankenstriche.
Ansprechperson aus der Anzeige übernehmen, wenn genannt.

Profil:
${PROFILE}`, jobBlock(job), 6000);
}

/** Vorbereitung, sobald eine Einladung zum Gespräch da ist. */
export async function interviewPrep(job: JobText): Promise<string> {
  return ask(cfg.letterModel, `Martin Spalevic (Profil unten) hat eine Einladung zum Vorstellungsgespräch für die Stelle unten.
Schreibe ihm eine kompakte Vorbereitung auf Deutsch, du-Form, für Telegram (kein Markdown, keine Tabellen, Aufzählungen mit •):
1. Worum es in der Stelle wirklich geht (2 Sätze).
2. Die 5 wahrscheinlichsten Fragen, je mit einem Antwortansatz aus seiner echten Erfahrung.
3. Eine kurze juristische Fachfrage, die zur Stelle passt, mit Lösungsskizze (Normen nennen).
4. Drei kluge Rückfragen, die er stellen kann.
Nichts erfinden, was nicht im Profil oder der Anzeige steht. Keine Gedankenstriche.

Profil:
${PROFILE}`, jobBlock(job), 12000);
}
