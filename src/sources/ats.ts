// Öffentliche Feeds der Bewerbermanagement-Systeme. Eine Funktion je System,
// alle liefern RawJob. Unbekannte Systeme liefern nichts (später Firecrawl).
import { XMLParser } from 'fast-xml-parser';
import { fetchJson, fetchText, stripHtml } from '../http.ts';
import type { Company, RawJob, WorkMode } from '../types.ts';

const xml = new XMLParser({ ignoreAttributes: false, isArray: (n) => ['position', 'jobDescription', 'additionalOffice'].includes(n) });

function modeFrom(...texts: (string | undefined | null)[]): WorkMode {
  const t = texts.filter(Boolean).join(' ').toLowerCase();
  if (/hybrid/.test(t)) return 'hybrid';
  if (/remote|home ?office|mobiles? arbeit|ortsunabh|anywhere|fully distributed|deutschlandweit|bundesweit/.test(t)) return 'remote';
  if (/onsite|on-site|vor ort|in office/.test(t)) return 'vor Ort';
  return 'unbekannt';
}

const loc = (label: string | undefined | null) => (label ? [{ label }] : []);

async function personio(c: Company): Promise<RawJob[]> {
  const url = c.ats.feed_url ?? `https://${c.ats.slug}.jobs.personio.de/xml?language=de`;
  const doc = xml.parse(await fetchText(url));
  const positions: any[] = doc?.['workzag-jobs']?.position ?? [];
  const base = url.replace(/\/xml.*$/, '');
  return positions.map((p) => {
    const desc = (p.jobDescriptions?.jobDescription ?? []).map((d: any) => `${d.name ?? ''}\n${stripHtml(String(d.value ?? ''))}`).join('\n');
    const offices = [p.office, ...(p.additionalOffices?.office ?? [])].filter(Boolean).map(String);
    return {
      id: `personio:${c.ats.slug ?? base}:${p.id}`,
      source: 'personio',
      company: c.name,
      title: String(p.name ?? ''),
      locations: offices.map((o) => ({ label: o })),
      mode: modeFrom(p.name, offices.join(' '), p.schedule, desc.slice(0, 1500)),
      url: `${base}/job/${p.id}`,
      description: desc,
      published: p.createdAt,
    };
  });
}

async function greenhouse(c: Company): Promise<RawJob[]> {
  const r = await fetchJson<any>(`https://boards-api.greenhouse.io/v1/boards/${c.ats.slug}/jobs?content=true`);
  return (r.jobs ?? []).map((j: any) => {
    const desc = stripHtml(stripHtml(j.content)); // content ist doppelt escaped
    return {
      id: `greenhouse:${c.ats.slug}:${j.id}`,
      source: 'greenhouse',
      company: c.name,
      title: j.title,
      locations: loc(j.location?.name),
      mode: modeFrom(j.title, j.location?.name),
      url: j.absolute_url,
      description: desc,
      published: j.updated_at,
    };
  });
}

async function lever(c: Company, eu: boolean): Promise<RawJob[]> {
  const host = eu ? 'api.eu.lever.co' : 'api.lever.co';
  const r = await fetchJson<any[]>(`https://${host}/v0/postings/${c.ats.slug}?mode=json`);
  return r.map((j) => ({
    id: `lever:${c.ats.slug}:${j.id}`,
    source: 'lever',
    company: c.name,
    title: j.text,
    locations: (j.categories?.allLocations ?? [j.categories?.location]).filter(Boolean).map((l: string) => ({ label: l })),
    mode: j.workplaceType === 'remote' ? 'remote' : j.workplaceType === 'hybrid' ? 'hybrid' : modeFrom(j.text, j.categories?.location),
    url: j.hostedUrl,
    description: j.descriptionPlain ?? stripHtml(j.description),
    published: j.createdAt ? new Date(j.createdAt).toISOString() : undefined,
  }));
}

async function recruitee(c: Company): Promise<RawJob[]> {
  const r = await fetchJson<any>(`https://${c.ats.slug}.recruitee.com/api/offers/`);
  return (r.offers ?? []).map((j: any) => ({
    id: `recruitee:${c.ats.slug}:${j.id}`,
    source: 'recruitee',
    company: c.name,
    title: j.title,
    locations: (j.locations?.length ? j.locations : [{ city: j.city }]).map((l: any) => ({
      label: [l.city, l.country].filter(Boolean).join(', '),
    })),
    mode: j.remote ? 'remote' : j.hybrid ? 'hybrid' : modeFrom(j.title, j.location),
    url: j.careers_url,
    description: stripHtml(`${j.description ?? ''}\n${j.requirements ?? ''}`),
    published: j.published_at,
  }));
}

async function smartrecruiters(c: Company): Promise<RawJob[]> {
  const out: RawJob[] = [];
  for (let offset = 0; offset < 1000; offset += 100) {
    const r = await fetchJson<any>(`https://api.smartrecruiters.com/v1/companies/${c.ats.slug}/postings?limit=100&offset=${offset}`);
    for (const j of r.content ?? []) {
      out.push({
        id: `smartrecruiters:${c.ats.slug}:${j.id}`,
        source: 'smartrecruiters',
        company: c.name,
        title: j.name,
        locations: [{
          label: [j.location?.city, j.location?.country].filter(Boolean).join(', '),
          lat: j.location?.latitude ? Number(j.location.latitude) : undefined,
          lon: j.location?.longitude ? Number(j.location.longitude) : undefined,
        }],
        mode: j.location?.remote ? 'remote' : j.location?.hybrid ? 'hybrid' : modeFrom(j.name),
        url: `https://jobs.smartrecruiters.com/${c.ats.slug}/${j.id}`,
        published: j.releasedDate,
      });
    }
    if ((r.content ?? []).length < 100) break;
  }
  return out;
}

async function ashby(c: Company): Promise<RawJob[]> {
  const r = await fetchJson<any>(`https://api.ashbyhq.com/posting-api/job-board/${c.ats.slug}`);
  return (r.jobs ?? []).map((j: any) => ({
    id: `ashby:${c.ats.slug}:${j.id}`,
    source: 'ashby',
    company: c.name,
    title: j.title,
    locations: [j.location, ...(j.secondaryLocations ?? []).map((s: any) => s.location)].filter(Boolean).map((l: string) => ({ label: l })),
    mode: j.isRemote || j.workplaceType === 'Remote' ? 'remote' : j.workplaceType === 'Hybrid' ? 'hybrid' : modeFrom(j.title, j.location),
    url: j.jobUrl,
    description: j.descriptionPlain ?? stripHtml(j.descriptionHtml),
    published: j.publishedAt,
  }));
}

// Workday hat bei Konzernen tausende Stellen: nur gezielt nach Studentenrollen suchen.
async function workday(c: Company): Promise<RawJob[]> {
  const { host, slug: tenant, site } = c.ats;
  const base = `https://${host}/wday/cxs/${tenant}/${site}`;
  const out = new Map<string, RawJob>();
  for (const searchText of ['Werkstudent', 'Working Student', 'studentische', 'Student']) {
    const r = await fetchJson<any>(`${base}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ limit: 20, offset: 0, searchText, appliedFacets: {} }),
    });
    for (const j of r.jobPostings ?? []) {
      if (!j.externalPath) continue;
      out.set(j.externalPath, {
        id: `workday:${tenant}:${j.externalPath}`,
        source: 'workday',
        company: c.name,
        title: j.title,
        locations: loc(j.locationsText),
        mode: modeFrom(j.title, j.locationsText, j.remoteType),
        url: `https://${host}/${site}${j.externalPath}`,
        published: j.postedOn,
      });
    }
  }
  return [...out.values()];
}

/** Beschreibung für Quellen nachladen, deren Liste keine enthält. */
export async function enrichAts(job: RawJob, c: Company): Promise<RawJob> {
  try {
    if (job.source === 'workday') {
      const path = job.id.split(':').slice(2).join(':');
      const d = await fetchJson<any>(`https://${c.ats.host}/wday/cxs/${c.ats.slug}/${c.ats.site}${path}`, { headers: { Accept: 'application/json' } });
      const info = d.jobPostingInfo ?? {};
      return { ...job, description: stripHtml(info.jobDescription), mode: job.mode === 'unbekannt' ? modeFrom(info.remoteType, info.location) : job.mode };
    }
    if (job.source === 'smartrecruiters') {
      const id = job.id.split(':').pop();
      const d = await fetchJson<any>(`https://api.smartrecruiters.com/v1/companies/${c.ats.slug}/postings/${id}`);
      const s = d.jobAd?.sections ?? {};
      return { ...job, description: stripHtml([s.jobDescription?.text, s.qualifications?.text].join('\n')) };
    }
  } catch {
    /* ohne Beschreibung weiter */
  }
  return job;
}

export async function listCompany(c: Company): Promise<RawJob[]> {
  switch (c.ats.type) {
    case 'personio': return personio(c);
    case 'greenhouse': return greenhouse(c);
    case 'lever': return lever(c, false);
    case 'lever_eu': return lever(c, true);
    case 'recruitee': return recruitee(c);
    case 'smartrecruiters': return smartrecruiters(c);
    case 'ashby': return ashby(c);
    case 'workday': return workday(c);
    default: return [];
  }
}
