// Alle Einstellungen kommen aus Umgebungsvariablen (Railway). Lokal: .env per `node --env-file`.

const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

export const cfg = {
  telegramToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
  // Wer /start <code> schickt, wird angemeldet. Ohne Code nimmt der Bot niemanden an.
  inviteCode: process.env.INVITE_CODE ?? '',
  anthropicKey: process.env.ANTHROPIC_API_KEY ?? '',
  scoreModel: process.env.SCORE_MODEL ?? 'claude-haiku-4-5-20251001',
  letterModel: process.env.LETTER_MODEL ?? 'claude-sonnet-5-5',
  databaseUrl: process.env.DATABASE_URL ?? '',
  // Wohnort Erftstadt
  home: { lat: 50.7965, lon: 6.769 },
  maxKm: Number(process.env.MAX_KM ?? 40),
  minScore: Number(process.env.MIN_SCORE ?? 6),
  maxPerRun: Number(process.env.MAX_PER_RUN ?? 15),
  // Volle Stunden (Berliner Zeit), zu denen gesucht wird
  runHours: list(process.env.RUN_HOURS ?? '7,12,17').map(Number),
  // Quellen abschalten, z.B. SOURCES_OFF=workday
  sourcesOff: list(process.env.SOURCES_OFF),
};

export const UA = 'jobradar/1.0 (Werkstudenten-Alarm; kontakt info@aleksa.ai)';
