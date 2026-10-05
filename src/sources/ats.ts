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


const rssParser = new XMLParser({ ignoreAttributes: false, isArray: (n) => ['item', 'tt:location'].includes(n) });

// RSS: SuccessFactors (gefiltert per keywords, sonst nur die 20 neuesten), Teamtailor, Talentsoft, eigene Feeds
async function rss(c: Company): Promise<RawJob[]> {
  const urls = c.ats.type === 'successfactors_rss'
    ? ['Werkstudent', 'Student', 'studentische', 'Working Student'].map((k) => c.ats.feed_url!.replace(/keywords=[^&]*/, `keywords=${encodeURIComponent(k)}`))
    : [c.ats.feed_url!];
  const out = new Map<string, RawJob>();
  for (const url of urls) {
    const doc = rssParser.parse(await fetchText(url));
    for (const it of doc?.rss?.channel?.item ?? []) {
      let title = String(it.title ?? '');
      let place = '';
      // SuccessFactors: "Titel (Ort, Land, PLZ)"
      const m = c.ats.type === 'successfactors_rss' ? title.match(/^(.*)\(([^()]*)\)\s*$/) : null;
      if (m) { title = m[1].trim(); place = m[2]; }
      const tt = (it['tt:locations']?.['tt:location'] ?? []).map((l: any) => [l['tt:city'], l['tt:country']].filter(Boolean).join(', '));
      const link = String(it.link ?? '');
      out.set(link, {
        id: `${c.ats.type}:${c.name}:${link}`,
        source: c.ats.type,
        company: c.name,
        title,
        locations: (tt.length ? tt : place ? [place] : c.city ? [c.city] : []).map((label: string) => ({ label })),
        mode: it.remoteStatus === 'fully' ? 'remote' : it.remoteStatus === 'hybrid' ? 'hybrid' : modeFrom(title, place),
        url: link,
        description: stripHtml(String(it.description ?? '')),
        published: it.pubDate,
      });
    }
  }
  return [...out.values()];
}

async function workable(c: Company): Promise<RawJob[]> {
  const r = await fetchJson<any>(c.ats.feed_url ?? `https://apply.workable.com/api/v1/widget/accounts/${c.ats.slug}`);
  return (r.jobs ?? []).map((j: any) => ({
    id: `workable:${c.ats.slug}:${j.shortcode}`,
    source: 'workable',
    company: c.name,
    title: j.title,
    locations: (j.locations?.length ? j.locations : [j]).map((l: any) => ({ label: [l.city, l.country].filter(Boolean).join(', ') })),
    mode: j.telecommuting ? 'remote' : modeFrom(j.title),
    url: j.url ?? j.application_url,
    published: j.published_on,
  }));
}

async function join(c: Company): Promise<RawJob[]> {
  const html = await fetchText(c.ats.feed_url ?? `https://join.com/companies/${c.ats.slug}`);
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return [];
  const items: any[] = JSON.parse(m[1])?.props?.pageProps?.initialState?.jobs?.items ?? [];
  return items.map((j) => ({
    id: `join:${c.ats.slug}:${j.idParam ?? j.id}`,
    source: 'join',
    company: c.name,
    title: j.title,
    locations: loc(j.city?.cityName),
    mode: /remote/i.test(j.workplaceType ?? '') ? 'remote' : /hybrid/i.test(j.workplaceType ?? '') ? 'hybrid' : modeFrom(j.title),
    url: `https://join.com/companies/${c.ats.slug}/${j.idParam ?? j.id}`,
    published: j.createdAt,
  }));
}

async function dvinci(c: Company): Promise<RawJob[]> {
  const r = await fetchJson<any[]>(c.ats.feed_url!);
  return r.map((j) => {
    const places = (j.jobOpening?.locations ?? j.locations ?? []).map((l: any) => l.city ?? l.name ?? String(l)).filter(Boolean);
    return {
      id: `dvinci:${c.ats.slug}:${j.id}`,
      source: 'dvinci',
      company: c.name,
      title: j.position ?? j.jobOpening?.name ?? '',
      locations: (places.length ? places : c.city ? [c.city] : []).map((label: string) => ({ label })),
      mode: modeFrom(j.position, places.join(' ')),
      url: j.jobPublicationURL,
      description: stripHtml([j.introduction, j.tasks, j.profile].filter(Boolean).join('\n')),
      published: j.startDate,
    };
  });
}

async function softgarden(c: Company): Promise<RawJob[]> {
  const r = await fetchJson<any>(c.ats.feed_url!);
  return (r.dataFeedElement ?? []).map((e: any) => {
    const j = e.item ?? e;
    const locs = [j.jobLocation].flat().filter(Boolean).map((l: any) => l?.address?.addressLocality ?? '').filter(Boolean);
    return {
      id: `softgarden:${c.name}:${j.url}`,
      source: 'softgarden',
      company: c.name,
      title: j.title,
      locations: locs.map((label: string) => ({ label })),
      mode: j.jobLocationType === 'TELECOMMUTE' ? 'remote' : modeFrom(j.title),
      url: j.url,
      description: stripHtml(j.description),
      published: j.datePosted,
    };
  });
}

async function oracle(c: Company): Promise<RawJob[]> {
  const r = await fetchJson<any>(c.ats.feed_url!);
  return (r.items?.[0]?.requisitionList ?? []).map((j: any) => ({
    id: `oracle:${c.ats.host}:${j.Id}`,
    source: 'oracle_hcm',
    company: c.name,
    title: j.Title,
    locations: loc(j.PrimaryLocation),
    mode: /remote/i.test(j.WorkplaceTypeCode ?? '') ? 'remote' : /hybrid/i.test(j.WorkplaceTypeCode ?? '') ? 'hybrid' : 'unbekannt',
    url: `https://${c.ats.host}/hcmUI/CandidateExperience/de/sites/${c.ats.site}/job/${j.Id}`,
    published: j.PostedDate,
  }));
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
    case 'successfactors_rss': case 'teamtailor': case 'rss': return rss(c);
    case 'workable': return workable(c);
    case 'join': return join(c);
    case 'dvinci': return dvinci(c);
    case 'softgarden': return softgarden(c);
    case 'oracle_hcm': return oracle(c);
    default: return [];
  }
}
