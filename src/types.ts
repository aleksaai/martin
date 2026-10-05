export type WorkMode = 'remote' | 'hybrid' | 'vor Ort' | 'unbekannt';

export interface RawJob {
  id: string; // <quelle>:<id der Quelle>
  source: string;
  company: string;
  title: string;
  locations: { label: string; lat?: number; lon?: number }[];
  mode: WorkMode;
  url: string;
  description?: string;
  published?: string;
}

export interface Company {
  name: string;
  category: string;
  city?: string;
  ats: { type: string; slug?: string; host?: string; site?: string; feed_url?: string };
  verified?: boolean;
}

export type JobStatus = 'skipped' | 'low' | 'match';

export interface StoredJob {
  id: string;
  source: string;
  company: string;
  title: string;
  location: string;
  distance_km: number | null;
  mode: WorkMode;
  url: string;
  description: string | null;
  status: JobStatus;
  skip_reason: string | null;
  score: number | null;
  reason: string | null;
  first_seen: string;
  notified_at: string | null;
  feedback: string | null;
}
