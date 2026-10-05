# HANDOFF: Martins Jobradar (Stand 2026-10-05 abends, Mac mini)

### Was wurde in dieser Session gemacht (2026-10-05)
- Projekt von null gebaut, Repo `aleksaai/martin`, Railway-Projekt „martin“ mit Postgres, Bot bei BotFather angelegt, Variablen gesetzt, BA-Suche live.
- Aleksa als erster Abonnent angemeldet (14 Treffer bekommen). Fixes live: Einladungscode tolerant gegen Leerzeichen, neue Abonnenten bekommen Treffer der letzten 14 Tage nachgeliefert.
- Ausbau Stufe 1–3 geschrieben, liegt ungetestet auf Branch `ausbau` (Details unten). Session endete vor den Tests, weil Aleksa vom Mac mini weg musste.

## Was live läuft (Branch `main`, Railway-Projekt „martin“)
- Bot (Telegram, Name „Adolf“) sucht 3x täglich (7, 12, 17 Uhr Berlin) Werkstudentenstellen, **nur über die BA-Jobbörse**.
  Haiku bewertet gegen `data/profile.md`, Treffer ab 6/10 kommen mit 👍 / 👎 / ✍️ Anschreiben (nur Text).
- Railway: Service `martin` (GitHub-Repo, Branch main, Auto-Deploy) + `Postgres`. Variablen am Service:
  `TELEGRAM_BOT_TOKEN`, `INVITE_CODE=8fc929ae`, `ANTHROPIC_API_KEY`, `DATABASE_URL=${{Postgres.DATABASE_URL}}`.
- Angemeldet: nur Aleksa. **Martin meldet sich erst an, wenn Stufe 1–3 fertig sind** (Aleksas Entscheidung):
  Link `https://t.me/<botname>?start=8fc929ae`, oder im Chat `/start 8fc929ae`. Er bekommt dann die Treffer der
  letzten 14 Tage nachgeliefert (`sendBacklog`).
- Aleksa soll selbst kein 👍/👎 drücken, Feedback hängt an der Stelle, nicht an der Person (der Bot soll Martins Geschmack lernen).
- Erster Probelauf (BA): 237 Stellen bewertet, 13–14 Treffer, Top: REWE Legal Operations (9), EY Law Rechtsberatung (9),
  Sprint Sanierung Recht (8). Danach viele Steuerstellen mit 6/10. Aleksa will die Schwelle bei 6 lassen.

## In Arbeit (Branch `ausbau`, NICHT deployt, nur typgeprüft, NICHTS davon echt getestet)

### Stufe 1: mehr Stellen
- `data/companies.json`: 245 Firmen (57 Kanzlei, 53 Rechtsabteilung, 36 Legal Tech, 70 SaaS, 29 Beratung), 129 mit live
  geprüftem Feed, 116 als `html` (eigene Karriereseite). Recherche-Hinweise: Personio und Workable drosseln (429),
  SuccessFactors-RSS liefert nur 20 Einträge (deshalb Suche per `keywords=`), falsche Slugs wurden aussortiert.
  Bekannte Lücke: Orth Kluth, Grooterhorst, Michels.pmks, Mütze Korsch, LLS nur mit Startseite, Karriere-URL von Hand nachziehen.
  Bot-Sperre (403) bei White & Case, METRO, Ceconomy, AXA, Ford, WTS.
- `src/sources/ats.ts`: Leser für personio, greenhouse, lever(_eu), recruitee, smartrecruiters, ashby, workday,
  successfactors_rss, teamtailor, rss, workable, join, dvinci, softgarden, oracle_hcm.
- `src/sources/html.ts`: Karriereseiten ohne Feed. Seite holen, Links + Text an Haiku, Stellen als JSON. Haiku läuft nur,
  wenn sich der Seiten-Hash geändert hat (Cache in `kv`).
- `src/http.ts`: Wiederholung bei 429/503. `src/run.ts`: 90 s Zeitgrenze je Firma (`withTimeout`).
- ⚠️ Offener Befund: `scripts/check-feeds.ts` (alle Feeds ohne Modell abrufen) **hing beim ersten Versuch >15 Min.**
  Ursache noch nicht gefunden. Mit der neuen Zeitgrenze erneut laufen lassen und langsame Feeds (Ausgabe `LANGSAM`)
  rauswerfen oder reparieren:
  `cd ~/Desktop/Projects/martin && node --import tsx scripts/check-feeds.ts > /tmp/feeds.log 2>&1` (nicht in `| tail` pipen, sonst sieht man nichts bis zum Ende).

### Stufe 2: Bewerbung per Knopf
- Knopf unter jeder Stelle heißt jetzt **📨 Bewerben** (`bew:<ref>`, alte `brief:`-Knöpfe gehen weiter).
- `src/bewerbung.ts` → `prepareApplication`: Anschreiben (Sonnet, `LETTER_MODEL`, nur aus dem Profil, keine erfundenen Fakten)
  als Text + PDF (`src/documents.ts`, Look wie Martins Lebenslauf: Poppins, NAME dünn+fett, grauer Rand), dazu
  `data/docs/lebenslauf.pdf`. Weg zur Bewerbung: Mailadresse in der Anzeige → Mailtext (`writeMail`), sonst
  🤖 Formular ausfüllen, bei BA/Workday/SuccessFactors/Oracle nur Link.
- **Stil lernen:** Martin antwortet auf die Anschreiben-Nachricht mit seiner Fassung → gespeichert in `letter_examples`,
  PDF neu. Zusätzlich gehen Dateien aus `data/letters/*.txt|md` als Beispiele mit (max. 6). **Dort fehlen noch Martins
  echte alte Anschreiben** (3–5 Stück, am besten erfolgreiche).
- Nachverfolgung (`applications`-Tabelle): ✅ Ich habe mich beworben → Nachfrage nach 10 Tagen, dann noch zweimal wöchentlich
  (📅 Einladung / ❌ Absage / ⏳ Noch nichts). Einladung → Gesprächsvorbereitung (`interviewPrep`). `/bewerbungen` zeigt den Stand.
- `data/contact.json`: Adresse, Telefon, Mail aus dem Lebenslauf. Staatsangehörigkeit/Arbeitserlaubnis bewusst NICHT drin.

### Stufe 3: Formular ausfüllen (`src/apply.ts`)
- Playwright-Chromium (`src/browser.ts`), Dockerfile auf `mcr.microsoft.com/playwright:v1.63.0-noble`, `railway.json` baut per Dockerfile.
- Ablauf: Anzeige öffnen, Cookie-Banner ablehnen, „Bewerben“ klicken bis ein Formular da ist, alle Felder in allen Frames
  einsammeln (`data-jr`), Sonnet plant die Belegung (nur sichere Daten; Unklares → „offen“), ausfüllen, Lebenslauf/
  Anschreiben hochladen, Screenshot an Martin.
- Offene Pflichtangaben: Martin antwortet auf den Screenshot (z.B. „Start 1.11., 20 Std/Woche, 15 €/h“) → wird eingetragen
  und unter `kv.answers` für spätere Formulare gemerkt.
- **Abgeschickt wird nur nach Klick auf ✅ Absenden**: dann erst Datenschutz-Häkchen setzen, Absende-Knopf klicken,
  Erfolgstext suchen, Screenshot. Captcha wird nie umgangen, dann bewirbt Martin sich selbst über den Link.
- Sitzung bleibt 20 Min. offen.

## Nächste Schritte (in dieser Reihenfolge)
1. Laptop: `cd ~/Desktop/Projects && git clone https://github.com/aleksaai/martin` (bzw. `git fetch && git checkout ausbau`),
   `npm install`, `npx playwright install chromium`.
2. Feed-Test (siehe oben) bis er sauber durchläuft.
3. Lokal ein kompletter Suchlauf: `ANTHROPIC_API_KEY=… npm run once` (ohne `DATABASE_URL` → `data/state.json`).
4. Stufe 2 lokal testen: `letterPdf` ein PDF erzeugen lassen und anschauen.
5. Stufe 3 an einem echten Personio- und einem Greenhouse-Formular testen, **ohne abzusenden** (nur bis zum Screenshot).
   Wichtig: Aleksas Einwand vom 05.10.: Stufe 3 ist nur sinnvoll, wenn sie zuverlässig ist. Wenn die Tests wackeln,
   lieber ohne Stufe 3 live gehen (Knopf `form:` ausblenden über `canFillForm` in `bewerbung.ts`).
6. `ausbau` nach `main` mergen und pushen → Railway baut neu (erster Build mit Playwright-Image dauert länger).
   Danach in Railway-Logs prüfen: `jobradar läuft …` und `Suchlauf fertig …`.
7. Martin anmelden lassen (Link oben). Er soll seine alten Anschreiben nach `data/letters/` liefern
   (über iCloud Drive > Downloads) und seine Immatrikulationsbescheinigung als `data/docs/immatrikulation.pdf`.

## Offene Fragen an Aleksa
- Umkreis 40 km lässt Düsseldorf und Aachen (je ~47 km) knapp raus, dort sitzen viele Kanzleien. Auf 50 km erhöhen? (`MAX_KM`)
