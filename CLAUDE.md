# jobradar: Werkstudenten-Alarm für Martin Spalevic

Repo `aleksaai/martin`, lokal `~/Desktop/Projects/martin/`. Railway: eigenes Projekt, ein Service + Postgres, **genau eine Instanz** (zwei würden sich beim Telegram-Polling gegenseitig stören).

Telegram-Bot, der mehrmals am Tag Werkstudentenstellen für Martin (Aleksas Bruder, Wirtschaftsjurist LL.B., Jurastudium
FernUni Hagen, wohnt in Erftstadt) sucht, mit Haiku nach Passung bewertet und Treffer meldet. Bewusst **getrennt von
claude-team**: eigenes Repo, eigenes Railway-Projekt, eigene Datenbank, eigener Bot. Martin sieht nichts von Aleksas System.

## Ablauf
1. **Quellen** (`src/sources/`)
   - `ba.ts`: Jobbörse der Bundesagentur. Liste über `pc/v6/jobs` (Header `X-API-Key: jobboerse-jobsuche`), Details nur über
     `pc/v4/jobdetails/<base64(refnr)>` (v6 gibt dort 403). Umkreissuche 50 km um Erftstadt mit breiten Begriffen plus
     bundesweite Suche mit Rechtsbezug (für Remote).
   - `ats.ts`: öffentliche Feeds der Bewerbermanagement-Systeme der Firmen aus `data/companies.json` (Personio-XML, Greenhouse,
     Lever, Recruitee, SmartRecruiters, Ashby, Workday-cxs). `ats.type: "html"` = kein Feed, wird derzeit übersprungen.
2. **Vorfilter ohne Modell** (`src/filter.ts`): Titel muss eine Studentenrolle sein, Ort bis `MAX_KM` um Erftstadt oder remote in
   Deutschland. Ortsnamen ohne Koordinaten über eine kleine Tabelle, sonst Nominatim (1 Anfrage/s, gecacht in `kv`). Weit entfernte
   Stellen kommen nur weiter, wenn die Beschreibung echtes Vollremote nennt (`REMOTE_HINT` in `run.ts`).
3. **Bewertung** (`src/llm.ts`): Haiku gibt `score` 0-10, `machbar`, `mode`, einen Satz Begründung. Treffer = machbar und
   `score >= MIN_SCORE`. Martins 👍/👎 der letzten 15 Meldungen gehen als Kalibrierung mit.
4. **Telegram** (`src/telegram.ts`): Long Polling, kein Webhook. Anmeldung nur per `/start <INVITE_CODE>`
   (Link `https://t.me/<bot>?start=<code>`). Knöpfe 👍/👎/✍️; ✍️ schreibt mit Sonnet einen Anschreiben-Entwurf nur aus
   `data/profile.md`. Höchstens `MAX_PER_RUN` Meldungen je Lauf, Rest beim nächsten Lauf.
5. **Zeitplan** (`src/index.ts`): Prüft alle 5 Min., läuft zu den vollen Stunden in `RUN_HOURS` (Berlin). Erster Lauf direkt
   nach dem ersten Start.

## Ablage
Postgres auf Railway über `DATABASE_URL` (Tabellen legt der Dienst selbst an: `jobs`, `subscribers`, `kv`). Ohne
`DATABASE_URL` eine JSON-Datei `data/state.json` (nur lokal zum Testen, gitignored). Jede gesehene Stelle wird gespeichert,
auch verworfene (`status` skipped/low/match), damit nichts doppelt bewertet wird.

## Umgebungsvariablen
Siehe `.env.example`. Pflicht: `TELEGRAM_BOT_TOKEN`, `INVITE_CODE`, `ANTHROPIC_API_KEY`, `DATABASE_URL`.

## Lokal
```bash
npm install
ANTHROPIC_API_KEY=... npm run once     # ein Suchlauf ohne Telegram, druckt die Treffer
npm run check                          # Typprüfung
```

## Regeln
- Martins Profil (`data/profile.md`) ist die einzige Quelle für Anschreiben. Keine erfundenen Fakten.
- Kein automatischer Bewerbungsversand ohne ausdrückliche Entscheidung von Aleksa und Martin.
- Railway startet mit `node --import tsx src/index.ts` direkt (kein `sh -c`), damit SIGTERM ankommt.


## Bewerbungsablauf testen (06.10.2026)
`src/browser.ts` trennt PDF- und Formular-Browser über Leases. `src/form-portals.ts` behandelt geprüfte REWE-/EY-Upload- und Aufklappdialoge. Telegram-Aktionen je Chat seriell; keine konkurrierenden Starts. `apply.ts` speichert Fragen/Angaben pro Bewerbung und prüft Formularwerte, Pflichtfelder und Uploads, bevor ein versionierter Absenden-Knopf erscheint. `form_delivery` schützt gegen Doppelsenden und hält unklare Übermittlungen separat.
Vor Veröffentlichung: Typprüfung plus `test-form-conversation.cjs`, `test-browser-lifecycle.ts`, `test-application-e2e.ts`. Bei Portaländerungen zusätzlich echten isolierten Browserlauf mit `test-live-application.ts`; dafür private Runtime-/Snapshot-Dateien über `MARTIN_TEST_DIR`, niemals ins Repo. Der Live-Test sendet keine Bewerbung oder Telegram-Nachricht. Keine generischen Erfolgsmeldungen ohne Readback und keine Rückgabe der kompletten Ausfüllarbeit an Martin.

Seit dem Kliemt-Fix zusätzlich `src/form-navigation.ts` und `scripts/test-form-navigation.ts`: Kontakt-/Newsletterformulare zählen nicht als Bewerbung. Listen müssen zur konkreten Anzeige und ihrem Formular weiterverfolgt werden, einschließlich Portal-Zwischenseite. Titel, Ort und Anforderungen aus dem Einzeltext erhalten; bei Mehrdeutigkeit keine fremde Stelle wählen. HRworks verwendet ein gemeinsames Upload-Feld und einen finalen Anchor-Button. Echte Qualifikationsabweichungen erklären und nur nach informierter Entscheidung ehrlich fortsetzen; nie ein Staatsexamen erfinden.
