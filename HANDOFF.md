# HANDOFF: Martins Jobradar (Stand 2026-10-06 spät, enneo MacBook)

### Kliemt / HRworks nach Martins Screenshot um 22:42 (2026-10-06)
- Aleksa bestätigt: REWE funktioniert inzwischen. Kliemt zeigte dagegen nur die Stellenübersicht mit „Upload noch nicht bestätigt“. Ursache war die allgemeine Erkennung `E-Mail + zwei Textfelder`: das globale Kontaktformular wurde als Bewerbungsformular akzeptiert. Die gespeicherte HTML-Stelle enthielt außerdem nur die Listen-URL und keinen Standort/Einzeltext.
- Neuer `src/form-navigation.ts`: Nachweis von Bewerbungsunterlagen/Upload-Widgets statt beliebigem Kontaktformular; konkrete Einzelanzeige anhand Titel und Ort auflösen (bei fehlendem Ort eindeutiger nächster Treffer im gespeicherten Suchgebiet), eingeklappte Detail-Links nutzen, bis zu sechs navigierte Seiten mit Schleifenschutz. Informations-/Datenschutzlinks werden übersprungen; sichtbarkeitsabhängige Animationen verhindern das direkte Öffnen eines belegten Bewerben-Links nicht. Formular-Erkennung behält Shadow-DOM-Uploads und bereits vorhandene EY-Dokument-Widgets bei.
- HRworks: gemeinsame Dokumentenablage wird nacheinander mit CV, Anschreiben und ergänzenden Unterlagen bestückt; Pflichtfeld-Platzhalter und Form-Gruppenlabels erkannt. Finaler Absende-Link ohne `href`/Button-Rolle wird gezielt geprüft und erst nach Freigabe geklickt. Fehlende Uploads/technische Readback-Fehler lösen eine interne Korrekturrunde und danach ggf. Sitzungswiederaufbau aus, statt mit `ok=true` ohne Folgeschritt hängen zu bleiben. Ergebniszustände unterscheiden Freigabe, echte Rückfragen und Blockade.
- `sources/html.ts` liest die strukturierten Kliemt-Jobkarten direkt inklusive Einzel-URL und Ort. Die echte Kölner Ausschreibung fordert bereits ein erstes Staatsexamen; Martins LL.B. ersetzt das nicht. Live-Modellbewertung mit Einzeltext: `machbar=false`, Score 0. Bestehende Bewerbung darf mit ehrlichen Angaben nach ausdrücklicher informierter Entscheidung fortgesetzt werden (`requirement_ack:<chat>:<job>`); keine solche Entscheidung produktiv vorwegnehmen.
- Abnahme: echte Kliemt-Kette Übersicht → Kölner Einzelanzeige → HRworks-Anzeige → Formular mit 15 Feldern, drei Unterlagen und erkannter Absendeaktion. Isolierte Testangaben inkl. bewusster Examens-Ausnahme, keine reale Bewerbung versendet. REWE (32 Felder) und EY (100 Felder) erneut bis zur geprüften Freigabe getestet. `test-form-navigation.ts` prüft falsche Kontaktformulare, zusammengeklappte Links, Orte/Mehrdeutigkeit und Kartenextraktion; `test-application-e2e.ts` enthält nun denselben mehrstufigen Weg, ein gemeinsames Upload-Feld und einen finalen Link-Button. Private Belege `kliemt-*`, `rewe-kliemt-regression.log`, `ey-kliemt-regression.log` im bestehenden privaten Testordner.
- Auch mit echtem Chat-Modell getestet: zunächst gezielte Rückfragen, dann natürliche Antwort mit Test-Bestätigung der ehrlichen Bewerbung trotz fehlendem Examen plus Eintrittstermin/Gehalt → `ready=true`, keine Feldfehler. Die Bestätigung blieb ausschließlich im isolierten Test-Store. Regressionstest erzwingt außerdem einen fehlgeschlagenen Schreibversuch und prüft automatische Reparatur bzw. echte Fehlerweitergabe statt stillem Warten.

### Aktueller Einstieg nach dieser Session
- Martin ist angemeldet. Bestehende Bewerbung über eine Antwort auf ihren Formular-Screenshot fortsetzen; keinen neuen `/start` verlangen. Adolf meldet sich durch ein Deployment nicht von selbst mit einer Erklärung.
- Code `7ec93ba` ist auf GitHub und wurde mit Railway-Deployment `b7a37801-dad5-45ca-8e6e-4dc316cd3f81` erfolgreich gestartet. Browser-Lifecycle- und vollständiger isolierter Versand-/Tracking-Test liefen zusätzlich im produktiven Linux-Container erfolgreich. Der kurzzeitige Telegram-Polling-Konflikt trat beim Wechsel der Instanzen auf; die alte Instanz wurde entfernt.
- Aleksas bestätigte Angabe „keine weitere Tätigkeit“ wurde ausschließlich im bestehenden EY-Bewerbungs-Draft ergänzt, mit Versionsprüfung. Die Modell-/Browser-Tests liefen mit isoliertem Store; reale Arbeitgeber-Bewerbungen und Telegram-Testnachrichten wurden nicht versendet.
- **Zurückgestellt:** automatische Entdeckung weiterer Firmen und ausgewogenere Verteilung der Vorschläge. Aktuell Dedupe über Anzeigen-ID/Firma+Titel; BA-Suche findet Firmen außerhalb der festen Liste. Direkte Karriereseiten bleiben feste Liste plus Chat-Ergänzungen, Sortierung nach Passung ohne Firmenquote. Einmalige 24-h-Erinnerung ist kein neuer Treffer. Aleksa wollte zuerst zuverlässiges Bewerben; diesen Ausbau noch nicht starten.
- Private Testbelege und Runtime-Dateien liegen nur auf dieser Maschine unter `~/.codex/backups/martin-form-2026-10-06/`. Der vorübergehend registrierte Railway-SSH-Schlüssel `martin-form-diagnostic` wurde nach der Diagnose wieder entfernt. HTTPS-Push dieses Repos lieferte 403; Push über `git@github.com:aleksaai/martin.git` funktionierte.

### Bewerbungs-Reparatur nach Martins REWE-/EY-Fehlern (2026-10-06 spät)
- **Ursachen real reproduziert:** konkurrierende Telegram-Klicks schließen gegenseitig Formular-Kontexte; PDF- und Formular-Browser teilten einen unvollständigen Idle-Zähler. REWE-Lebenslauf-Upload öffnet einen Parsing-Dialog, der Texteingaben blockiert. EY-Upload läuft über ein Plus-Symbol → Quelldialog → Dateifeld; eingeklappte Abschnitte und ARIA-Radios wurden bisher übersehen.
- **Umsetzung:** `browser.ts` mit getrennten Browser-Pools/Leases und gemeinsamem Launch-Promise. `telegram.ts` serialisiert alle Aktionen je Chat (auch Buttons). `form-portals.ts` erweitert EY-Abschnitte, bedient REWE-/EY-Uploads, lehnt REWE-CV-Parsing ab und kontrolliert sichtbare Dateinamen. `apply.ts` erfasst ARIA-Radios und Pflichtkennzeichnungen, prüft Werte/Auswahlen nach dem Eintragen, deaktiviert Idle-Schließen während der Arbeit und baut fehlerhafte Sitzungen einmal neu auf.
- **Absenden:** nur nach vollständiger Prüfung plus passender aktueller Freigabe. Wiederholte/stale/fremde Klicks blockiert; `form_delivery:<chat>:<job>` verhindert erneutes Senden nach begonnener oder bestätigter Übermittlung. Unklarer Eingang bleibt ungeklärt, wird nicht als beworben eingetragen und nicht blind erneut gesendet. Bei technischen Fehlern bleibt die Bewerbung offen mit `form_issue` und erneuter Prüfung, keine Aufforderung mehr, alles manuell auszufüllen.
- **Reale Portal-Abnahme:** REWE 32 Felder, gespeicherte echte Angaben, CV/Anschreiben/Immatrikulation hochgeladen, keine offenen Fragen oder Readback-Fehler, bereit zur Freigabe. EY 100 Felder inklusive ARIA-Radios, Login, Uploads und natürliche Chat-Antwort getestet; danach keine offenen Fragen oder Readback-Fehler, bereit zur Freigabe. Aleksa bestätigt für EY: keine Nebentätigkeit. Keine echte Bewerbung abgeschickt, kein Save/Apply auf EY ausgelöst, keine Telegram-Testnachricht, keine produktiven Bewerbungs-/Tracking-Testeinträge.
- **Tests:** `npm run check`; `node scripts/test-form-conversation.cjs`; `node --import tsx scripts/test-browser-lifecycle.ts`; `node --import tsx scripts/test-application-e2e.ts` (echter Chromium + lokale Arbeitgeber-/Modell-/Telegram-Fixtures, inklusive Doppelklick, natürlicher Chat-Antwort, Freigabe, einmaligem Versand, Tracking, stale/fremder Freigabe und unbestätigtem Versand). `scripts/test-live-application.ts` nutzt echten Browser + echtes Modell mit isoliertem Store und abgefangenem Telegram, ruft NIE submitForm auf. Private Belege unter `~/.codex/backups/martin-form-2026-10-06/` auf der enneo MacBook, nicht committen.
- **Grenzen:** Live-Abnahme reicht bis zur geprüften Freigabe; der tatsächliche Arbeitgeber-Eingang ist erst nach Martins Absenden belegbar. Andere Portale/Captchas und mehrseitige Workday-Abläufe sind damit nicht pauschal abgenommen. Ungeklärte persönliche Angaben weiter erfragen, nie erfinden. Modelltests und lokale Fixtures sind kein Ersatz für den echten Portal-Readback.


### Historie: erste Formular-Rückfragen-Korrektur (2026-10-06, durch spätere Reparatur ergänzt)
- `fillAndReport` stellt nach jedem Formularbericht bis zu zwei vollständige offene Fragen als eigene Telegram-Nachricht mit Antwortfunktion. Die Vier-Wörter-Kürzung entfällt; Frageinhalt, Einheiten und Optionen sollen erhalten bleiben. Unlesbare Fragen dürfen nicht geraten werden.
- Natürliche Teilantworten werden über `formular_ergaenzen` übernommen. Fehlende Sitzung führt automatisch zu `formular_oeffnen`; `form_draft:<chat>:<job>` sichert die bewerbungsbezogenen Angaben und offenen Fragen in Postgres-kv. Das ist kein globales Profil-Merken. Browserzustand selbst wird nicht gespeichert; ein abgelaufenes Formular wird neu aufgebaut (mehrseitige Portale können erneut Navigation verlangen).
- Antworten auf Formularbilder/Rückfragen werden innerhalb der Chat-Warteschlange über `form_msg` der richtigen Bewerbung zugeordnet. Ausfüll- und Weiter-Werkzeuge berücksichtigen die aktive Bewerbung. Beim Öffnen wird eine vorherige Browsersitzung dieses Chats geschlossen.
- Der Link wurde zunächst „Im Browser neu ausfüllen“ genannt; die spätere Reparatur entfernt diesen Ausweichweg aus dem Formularbericht. Abschicken bleibt ausschließlich beim Bestätigungsknopf.
- Damals geprüft: `npm run check`, `node scripts/test-form-conversation.cjs` mit simuliertem Modell/Browser/Telegram. Diese Prüfung reichte nicht aus. Die reale REWE-/EY-Abnahme erfolgte erst mit der oben beschriebenen Reparatur.


### Historie vor Martins Anmeldung (2026-10-06, inzwischen überholt)
1. Aleksa schreibt in seinem Adolf-Chat `/beobachter` (VOR Martins Start, sonst wird er beim Wechsel pausiert).
2. Martin: `/start 8fc929ae` (bzw. `t.me/<bot>?start=8fc929ae`) → Testdaten werden gelöscht, er bekommt alle Treffer der letzten 14 Tage.
3. Martin nennt Adolf einmal Starttermin, Wochenstunden, Arbeitstage, Gehaltswunsch und sagt „merk dir das“.
Startpaket im Repo: Lebenslauf, Immatrikulationsbescheinigung WS 2026/27 (Vollzeitstudierender, 3. FS, 8. HS, Matrikelnr. in `data/contact.json`),
Staatsangehörigkeit deutsch, Logo, 4 Stil-Anschreiben. Railway-Variablen: `TELEGRAM_BOT_TOKEN`, `INVITE_CODE`, `ANTHROPIC_API_KEY`, `DATABASE_URL`, `VAULT_KEY`.
Noch nie echt erprobt: ein echtes Absenden, Login + Formular hinter einem Portal-Konto (EY/SuccessFactors), Workday mehrseitig.

### Was wurde in dieser Session gemacht (2026-10-06)
- **Ausbau Stufe 1–3 getestet und nach `main` gemergt = live** (Railway baut ab jetzt per Dockerfile mit Playwright-Image).
- Martins vier echte Anschreiben (fino, Vestlane, Lawfit, Louco) liegen als Stilvorlagen in `data/letters/`. Neu im Profil: Bachelorarbeit
  zu Pflichten/Haftung des Geldwäschebeauftragten + künftiger EU-Geldwäscherecht, Einblicke Vertrieb/Rechnungswesen/Controlling, Ziel Staatsexamen.
- **Anschreiben-PDF neu als DIN-5008-Geschäftsbrief** mit Martins Logo (`data/docs/logo.png`, Navy #0D1625): Kopf wie Lebenslauf,
  Rücksendezeile, Empfänger (+ „z. Hd.“ aus der Anrede), Ort/Datum, Betreff (vom Modell grammatisch korrekt, erste Zeile `Betreff: …`),
  Grußformel, Anlage. Passt immer auf eine Seite (Schrift ≥ 9 pt, sonst kürzt der Bot den Text auf ≤ 280 Wörter). Aleksa: „Genauso formatiert muss das sein.“
- **Faktenprüfung:** Haiku gleicht jedes Anschreiben mit dem Profil ab, unbelegte Aussagen werden entfernt (Anlass: Testbrief behauptete „Microsoft 365“).
- **Sonnet 5.5 denkt vor der Antwort** und verbraucht dabei Tokens: Budgets in `llm.ts`/`apply.ts` auf 8–16k erhöht, vorher brachen Briefe mitten im Satz ab.
- **Feed-Abruf:** alle 129 Feeds laufen (7.449 Stellen, 321 Studentenrollen). Gestriges „Hängen“ war nur die Ausgabe-Umleitung. Abruf jetzt als
  Pool mit 10 parallel, 45 s je Firma. Erster Gesamtlauf lokal: 9 neue Treffer, u.a. Oppenhoff IT- & Datenrecht, Kliemt, YPOG, Meilicke Hoffmann, KPMG Law.
  16 Kanzlei-/Konzernseiten scheitern (403 oder nicht erreichbar, Liste im Lauf-Log), ist hingenommen.
- **Formular-Trockenlauf** (`scripts/test-form.ts`, schickt NIE ab) an GÖRG/Personio und IONOS/Greenhouse erfolgreich. Behoben: Knopftext
  „Auf diese Stelle bewerben“ wurde nicht erkannt; tsx baut `__name` in Funktionen ein, die per `page.evaluate` im Browser laufen sollen → Erfassungs-Skript
  jetzt als Text (`COLLECT_SRC`); selbstgebaute Aufklapplisten (role=combobox) werden geöffnet und ihre Optionen gelesen; nach Uploads 5 s warten.
- **Knöpfe:** nur noch 📨 Bewerben (zählt als „passt“) und 👎 Passt nicht (Aleksas Wunsch).
- **Nach Aleksas erstem Test (06.10. nachmittags):** Statuszeile „⏳ …“ mit Schritten statt stummem Warten (`statusLine` in `bewerbung.ts`),
  Anschreiben nur noch als PDF (Antwort auf das PDF = Änderungswunsch per `reviseLetter`, ab 120 Wörtern oder „Sehr geehrte…“ = eigene Fassung → Stilvorlage),
  Knopf heißt „🤖 Für mich bewerben“. **BA-Stellen:** Bewerbungsweg liegt bei der Arbeitsagentur hinter einem Captcha (wird nie umgangen) → `findOriginalPosting`
  sucht per Haiku + `web_search_20250305` die Original-Anzeige beim Arbeitgeber (REWE, EY gefunden; Sprint nicht → Hinweis auf die BA-Sicherheitsabfrage).
  Gefundene URL in `kv apply_url:<jobId>`. Formular-Fixes: Bewerben-Links werden direkt aufgerufen (target=_blank), Formular erst bei Datei-Upload oder
  Mail + weitere Felder, Felder auch im Shadow-DOM (REWE), Cookie-Banner vor dem Erfassen nochmal schließen, „Titel“ = akademischer Titel bleibt leer.
  REWE-Formular im Trockenlauf komplett: Daten, Lebenslauf, Anschreiben; offen nur echte Fragen (Gehalt, Stunden, Wochentage, Start).
- **Chat-Assistent (06.10. abends, `src/agent.ts`):** Jede Nicht-Befehl-Nachricht geht an Sonnet mit Werkzeugen `formular_oeffnen`,
  `formular_ergaenzen`, `anschreiben_aendern`, `merken`, `vergessen` + Server-Websuche (Gehaltsberatung). Verlauf in `kv hist:<chat>` (24 Nachrichten),
  aktive Bewerbung in `kv active_job:<chat>`, Gedächtnis = `kv answers` (fließt in Anschreiben und Formulare). Merken nur nach Martins Ja.
  Absenden kann der Chat nie, nur der Knopf. Formular-Bericht kurz („ausgefüllt, beide PDFs drin, mir fehlt noch …“), Screenshot als Foto.
  **Sicherungen:** nie auf arbeitsagentur.de oder Konto-Portalen ausfüllen (erst Original-Anzeige suchen), Formular nur bei Upload/E-Mail+Feldern,
  Absenden-Knopf nur ohne offene Punkte UND mit hochgeladenem Lebenslauf (Anlass: lokaler Test füllte das BA-Captcha-Feld und bot Absenden an).
  Test-Skripte: `scripts/test-chat.ts` (Telegram auf Konsole umgeleitet), `test-form.ts`, `test-letter.ts`, `test-original.ts`, `check-feeds.ts`.
- **Konten bei Bewerberportalen (06.10. abends, `src/vault.ts`):** Login-Seite (Passwortfeld ohne Upload) → mit gespeichertem Zugang anmelden,
  sonst `askForAccount`: Martin bekommt Knopf „📝 Konto anlegen“ + E-Mail + vorgeschlagenes Passwort (`generatePassword`), legt das Konto selbst an
  (Bestätigungsmail, Captcha, AGB = seine Zustimmung), tippt „✅ Konto ist angelegt“ → Nachricht mit Passwort wird gelöscht, Bot loggt sich ein.
  Eigene Zugangsdaten im Chat → Werkzeug `konto_hinterlegen`, seine Nachricht wird gelöscht, Passwort nie im Verlauf. Verschlüsselt (AES-256-GCM)
  in `kv cred:<portal>`, Schlüssel aus `VAULT_KEY` oder ersatzweise dem Bot-Token. Portal-Schlüssel = Host (bei SuccessFactors + `company`).
  Getestet bis zur Konto-Anleitung bei EY (SuccessFactors `EYHRISPRD1`). Login + Formular nach dem Login noch NICHT echt getestet.
  Mehrseitige Formulare: Werkzeug `formular_weiter`. Außerdem: 👀-Reaktion auf jede Nachricht, keine zweite Chat-Nachricht nach Bild/PDF
  (`SENDS_ITSELF`, `[STILL]`), Knopf „🤖 Mit diesem Anschreiben bewerben“ unter jeder überarbeiteten Fassung.
- **Tracking + Persona (06.10. abends, `src/tracking.ts`):** Bewerbungen aus jedem Kanal (adolf/mail/portal/linkedin/sonstiges) per Chat
  („hab mich bei X beworben“) → `recordApplication` verknüpft mit bekannter Stelle oder legt Stelle mit `status='manuell'` an.
  `applications` hat neu `channel` + `notes` (Absagegründe). `/bewerbungen` und Chat „Lagebericht“ → `overview` (Zahlen, Quote, Kanäle, Liste).
  `nudgeUndecided`: gemeldete Treffer ohne 👎/Bewerbung nach 24 h einmal gebündelt nachfassen (`kv nudged:<id>`), läuft mit jedem Suchlauf.
  **Persona „Adolf“:** Bundeswehr-Ausbilder, sagt „Kamerad“, zackig, mal ruppig, aber hilfreich; harte Regel gegen jede NS-Anspielung.
  Gilt nur im Chat und in Bot-Texten, Anschreiben/Formulare bleiben in Martins Stil. Gemerkte Erkenntnisse (`kv answers`) fließen auch in die Stellenbewertung.
  Railway-Variable `VAULT_KEY` ist seit 06.10. gesetzt (Aleksa).
- **Sucheinstellungen im Chat (06.10. abends, `src/prefs.ts`):** `kv search_prefs` = Umkreis um Erftstadt (Start: `MAX_KM`), Zusatzorte mit
  eigenem Umkreis (BA-Umkreissuche + Ortsprüfung je Ort), ausgeschlossene/bevorzugte Themen (fließen in die Haiku-Bewertung),
  `kv extra_companies` = von Martin genannte Firmen (`companyFromUrl` erkennt Personio, Greenhouse, Lever, Recruitee, Ashby, Workday, Teamtailor,
  sonst Karriereseite). Größeres Suchgebiet → `forgetTooFar` löscht „zu weit“-Aussortierte, damit der nächste Lauf sie neu prüft.
  Chat-Verlauf trägt jetzt „[Werkzeuge ausgeführt: …]“, sonst zweifelte Adolf eigene Aktionen an. Zeitplan läuft im Dienst selbst (kein Railway-Cron),
  `RUN_HOURS` (Standard 7,12,17). Lokale Testläufe (`npm run once`) beenden sich jetzt selbst.
- **Testbetrieb → echter Betrieb (06.10.):** Aleksa war nur Testnutzer. Die erste `/start <code>`-Anmeldung ohne `kv live_since` löscht einmalig
  Testdaten (`resetTestData`: Feedback, Bewerbungen, Stilvorlagen aus der DB, Gedächtnis, Sucheinstellungen, Chatverläufe, Konten), pausiert alle
  anderen Abonnenten (Aleksa bekommt eine Hinweisnachricht, `/weiter` holt ihn zurück) und setzt `live_since`. Martin bekommt alle Treffer der
  letzten 14 Tage (max. 30) als neu (`touchNotified`, 24-h-Nachfassen zählt ab seinem Start). Bewertete Stellen bleiben, nichts wird neu bezahlt.
  ⚠️ Danach meldet sich niemand mehr „zum Test“ mit dem Code an, das würde nichts löschen, aber mitlesen.
- **Beobachter-Modus (06.10., Aleksas Wunsch):** `/beobachter` setzt `kv role:<chat>=beobachter` und entpausiert. Beobachter bekommen
  dieselben automatischen Meldungen, Stellenkarten mit 👁 und ohne Knöpfe; Knopf-Klicks werden abgewiesen; der Chat-Agent weiß, dass es
  Aleksa ist, hat nur `bewerbungen_uebersicht` + `sucheinstellungen` + Websuche und ändert nichts. Martins Start pausiert Beobachter nicht.
  Martins eigene Chats werden bewusst NICHT gespiegelt. `/pause` / `/weiter` wie gehabt.
- **Dateien im Chat (06.10. abends, `src/uploads.ts`):** PDF/Foto/Word → `getFile`-Download (max. 20 MB) → Haiku liest PDF/Bild und ordnet ein
  (lebenslauf, immatrikulation, zeugnis, foto, anschreiben, sonstiges; Word nur nach Dateiname, sonst Rückfrage-Knöpfe `dk:<n>:<art>`).
  Ablage in Postgres-Tabelle `documents` (bytea), nicht im Container. Lebenslauf/Immatrikulation/Foto je einmal (ersetzen), Zeugnisse mehrere.
  Anschreiben → Text wird Stilvorlage. `materialize()` stellt alles als Dateien bereit (Lebenslauf fällt auf `data/docs/lebenslauf.pdf` zurück),
  Formular-Dokumente: lebenslauf, anschreiben, immatrikulation, zeugnis, foto, weitere (= Immatrikulation + Zeugnisse). „sonstiges“ wird NIE
  automatisch hochgeladen, Bilder ohne Bewerbungsbezug werden gar nicht abgelegt. Beobachter können keine Dateien ablegen.
- Offen (Stand Mittag, inzwischen erledigt: Railway-Build mit Playwright lief, Immatrikulation im Startpaket): Martin anmelden, Martin nennt einmal Starttermin/Stunden (Antwort auf einen Formular-Screenshot
  landet in `kv.answers` und fließt danach auch in die Anschreiben), Immatrikulationsbescheinigung schickt Martin einfach in den Chat.

### Was wurde in dieser Session gemacht (2026-10-05)
- Projekt von null gebaut, Repo `aleksaai/martin`, Railway-Projekt „martin“ mit Postgres, Bot bei BotFather angelegt, Variablen gesetzt, BA-Suche live.
- Aleksa als erster Abonnent angemeldet (14 Treffer bekommen). Fixes live: Einladungscode tolerant gegen Leerzeichen, neue Abonnenten bekommen Treffer der letzten 14 Tage nachgeliefert.
- Ausbau Stufe 1–3 geschrieben, liegt ungetestet auf Branch `ausbau` (Details unten). Session endete vor den Tests, weil Aleksa vom Mac mini weg musste.

## Was live läuft (Branch `main`, Railway-Projekt „martin“)
- Bot (Telegram, Name „Adolf“) sucht 3x täglich (7, 12, 17 Uhr Berlin) Werkstudentenstellen, **nur über die BA-Jobbörse**.
  Haiku bewertet gegen `data/profile.md`, Treffer ab 6/10 kommen mit 👍 / 👎 / ✍️ Anschreiben (nur Text).
- Railway: Service `martin` (GitHub-Repo, Branch main, Auto-Deploy) + `Postgres`. Variablen am Service:
  `TELEGRAM_BOT_TOKEN`, `INVITE_CODE=8fc929ae`, `ANTHROPIC_API_KEY`, `DATABASE_URL=${{Postgres.DATABASE_URL}}`.
- Angemeldet bis zum Start: nur Aleksa (Testnutzer). Martins erste Anmeldung schaltet auf echten Betrieb um (siehe unten):
  Link `https://t.me/<botname>?start=8fc929ae`, oder im Chat `/start 8fc929ae`. Er bekommt dann die Treffer der
  letzten 14 Tage nachgeliefert (`sendBacklog`).
- Aleksa soll selbst kein 👍/👎 drücken, Feedback hängt an der Stelle, nicht an der Person (der Bot soll Martins Geschmack lernen).
- Erster Probelauf (BA): 237 Stellen bewertet, 13–14 Treffer, Top: REWE Legal Operations (9), EY Law Rechtsberatung (9),
  Sprint Sanierung Recht (8). Danach viele Steuerstellen mit 6/10. Aleksa will die Schwelle bei 6 lassen.

## Ausbau (seit 2026-10-06 live auf `main`; Details zum Bau, Stand 05.10.)

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
   (über iCloud Drive > Downloads) und seine Immatrikulationsbescheinigung schickt Martin einfach in den Chat.

## Offene Fragen an Aleksa
- Umkreis 40 km lässt Düsseldorf und Aachen (je ~47 km) knapp raus, dort sitzen viele Kanzleien. Auf 50 km erhöhen? (`MAX_KM`)
