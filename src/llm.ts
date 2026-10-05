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
(z.B. ausdrücklich Informatik), Arbeitsort vor Ort außerhalb von ca. ${cfg.maxKm} km um Erftstadt ohne Vollremote, Remote nur im Ausland,
oder verlangt Sprachen/Qualifikationen, die er nicht hat. Sonst true.

"mode": "remote" | "hybrid" | "vor Ort" | "unbekannt", wie es in der Anzeige steht.

"reason": EIN kurzer Satz auf Deutsch, höchstens 25 Wörter, direkt an Martin gerichtet (du-Form): was er dort machen würde und welche seiner Erfahrungen dazu passt. Keine Ortsangabe (steht schon daneben), kein Gedankenstrich.

Format: {"score": 8, "machbar": true, "mode": "hybrid", "reason": "..."}`;

export async function scoreJob(job: RawJob, place: string, calibration: string): Promise<Verdict> {
  const text = [
    `Titel: ${job.title}`,
    `Arbeitgeber: ${job.company}`,
    `Ort: ${place}`,
    `Modus laut Quelle: ${job.mode}`,
    `Beschreibung:\n${(job.description ?? '(keine Beschreibung verfügbar, nur nach Titel urteilen)').slice(0, 6000)}`,
    calibration ? `\nSo hat Martin bisherige Vorschläge bewertet (zur Kalibrierung):\n${calibration}` : '',
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

async function ask(model: string, system: string, user: string, maxTokens = 1500): Promise<string> {
  const res = await client.messages.create({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] });
  return res.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim().replace(/\s*[—–]\s*/g, ', ');
}

const jobBlock = (job: JobText) =>
  `Stelle: ${job.title}\nArbeitgeber: ${job.company}\nLink: ${job.url}\n\nAnzeige:\n${(job.description ?? '(keine Beschreibung gespeichert)').slice(0, 8000)}`;

export async function writeLetter(job: JobText, examples: string[] = []): Promise<string> {
  return ask(cfg.letterModel, `Du schreibst einen Anschreiben-Entwurf für Martin Spalevic. Grundlage ist ausschließlich sein Profil. Erfinde nichts dazu:
keine Noten, keine Zahlen, keine Tätigkeiten, die nicht im Profil stehen.

Profil:
${PROFILE}

Regeln:
- Deutsch (Englisch nur, wenn die Anzeige englisch ist), Sie-Form gegenüber dem Arbeitgeber, ehrlich und konkret, keine Bewerbungsfloskeln ("hiermit bewerbe ich mich", "mit großem Interesse").
- Höchstens 220 Wörter Fließtext. Einstieg mit dem stärksten Bezug zwischen seiner Erfahrung und der Stelle.
- Zwei bis drei konkrete Belege aus seinem Profil, die zur Anzeige passen.
- Nenne die zeitliche Flexibilität durch das Fernstudium, wenn es zur Stelle passt.
- Keine Gedankenstriche. Normale Satzzeichen.
- Platzhalter in eckigen Klammern nur, wo Wissen wirklich fehlt (z.B. [frühester Starttermin], [Stunden pro Woche]). Ansprechperson aus der Anzeige übernehmen, sonst "Sehr geehrte Damen und Herren".
- Nur das Anschreiben ausgeben: Anrede, Text, Grußformel, Name. Kein Briefkopf, kein Betreff, kein Kommentar.${styleBlock(examples)}`, jobBlock(job));
}

/** Kurze Begleitmail, wenn die Anzeige eine Bewerbungsadresse nennt. */
export async function writeMail(job: JobText): Promise<string> {
  return ask(cfg.letterModel, `Schreibe eine kurze Bewerbungs-E-Mail von Martin Spalevic (Profil unten). Anschreiben und Lebenslauf hängen als PDF an.
Format: erste Zeile "Betreff: ...", Leerzeile, dann 3 bis 5 Sätze, Grußformel, Name, Telefon ${PHONE}. Sie-Form, keine Floskeln, keine Gedankenstriche.
Ansprechperson aus der Anzeige übernehmen, wenn genannt.

Profil:
${PROFILE}`, jobBlock(job), 600);
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
${PROFILE}`, jobBlock(job), 2000);
}
