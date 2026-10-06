import type { Page } from 'playwright';
import type { Store } from './store.ts';
import type { StoredJob } from './types.ts';
import { distanceKm, geocode } from './filter.ts';
import { cfg } from './config.ts';
import { loadPrefs, origins } from './prefs.ts';

/** Contact/newsletter fields alone are never sufficient evidence of an application. */
export async function hasApplicationForm(page: Page): Promise<boolean> {
  for (const frame of page.frames()) {
    const visible = await frame.locator('input:not([type=hidden]):not([type=file]), select, textarea').filter({visible:true}).count();
    const file = await frame.locator('input[type=file]').count();
    const documentControl = await frame.getByRole('button', {name:/upload.*cv|attach.*cover letter|lebenslauf.*hochladen|dokument.*hochladen/i}).filter({visible:true}).count();
    const existingDocumentWidget = await frame.locator('.attachmentField').filter({visible:true}).count();
    const documentText = await frame.getByText(/lebenslauf|resume|\bcv\b|anschreiben|application (form|documents)|bewerbungs(unterlagen|formular)/i).filter({visible:true}).count();
    if ((file && visible >= 2 && documentText) || documentControl > 0 || existingDocumentWidget > 0) return true;
  }
  return false;
}

const norm = (text: string) => text.toLowerCase().replace(/\([^)]*\)|[^a-zäöüß0-9 ]/g,' ').replace(/\s+/g,' ').trim();
export interface PostingLink { title: string; location: string; url: string }

/** Read actual detail links, including collapsed job cards, without clicking arbitrary actions. */
export async function postingLinks(page: Page): Promise<PostingLink[]> {
  return page.evaluate(`(() => {
    const cards = [...document.querySelectorAll('.job-item, article, tr, [data-job-id], .job-listing, .job-card')];
    const result = [];
    for (const card of cards) {
      const title = card.querySelector('.job-item-titel, [data-job-title], h2, h3, .job-title')?.textContent?.trim();
      const location = card.querySelector('.job-item-standort, [data-job-location], .job-location')?.textContent?.trim() || '';
      const a = [...card.querySelectorAll('a[href]')].find(a => /mehr erfahren|details|view job|learn more/i.test(a.textContent || '') || /\\/jobs?\\//.test(a.href));
      if (title && a && /^https?:/.test(a.href)) result.push({title,location,url:a.href});
    }
    for (const a of document.querySelectorAll('a[href]')) {
      const title=(a.textContent||'').replace(/\\s+/g,' ').trim();
      if(title.length>10 && title.length<180 && /\\/jobs?\\//.test(a.href)) result.push({title,location:'',url:a.href});
    }
    return result;
  })()`) as Promise<PostingLink[]>;
}

export async function choosePosting(candidates: PostingLink[], job: StoredJob, store?: Store): Promise<PostingLink | null> {
  const words = norm(job.title).split(' ').filter(w=>w.length>3 && !['unser','unserem','unseren','büro'].includes(w));
  const unique = new Map<string, PostingLink>();
  for (const c of candidates) if (!unique.has(c.url)) unique.set(c.url,c);
  const matches = [...unique.values()].map(c=>({c,score:words.filter(w=>norm(c.title).includes(w)).length/Math.max(1,words.length)})).filter(x=>x.score>=0.8);
  if (!matches.length) return null;
  const exactCity = norm(job.location||'');
  const knownLocation = exactCity && !/nicht angegeben|unbekannt|ohne ort/.test(exactCity);
  const searchPlaces = store ? origins(await loadPrefs(store)) : [{...cfg.home,km:cfg.maxKm}];
  const ranked=[];
  for (const item of matches) {
    if (knownLocation && item.c.location && !exactCity.includes(norm(item.c.location))) continue;
    const geo=store && item.c.location ? await geocode(item.c.location,store):null;
    if(!knownLocation && geo && !searchPlaces.some(place=>distanceKm(place,geo)<=place.km))continue;
    ranked.push({...item,distance:geo?distanceKm(cfg.home,geo):Infinity});
  }
  ranked.sort((a,b)=>b.score-a.score || a.distance-b.distance);
  if(!ranked.length)return null;
  // Do not silently choose between equally plausible locations or unrelated roles.
  if(ranked.length>1 && ranked[0].score===ranked[1].score && ranked[0].distance===ranked[1].distance) return null;
  return ranked[0].c;
}

export async function followPosting(page: Page, job?: StoredJob, store?: Store): Promise<boolean> {
  if(!job)return false;
  const candidates=await postingLinks(page);
  const chosen=await choosePosting(candidates,job,store);
  console.log('Stellenauswahl',candidates.length,chosen?.title??'keine eindeutige Einzelanzeige',chosen?.location??'');
  if(!chosen || chosen.url===page.url())return false;
  await page.goto(chosen.url,{waitUntil:'domcontentloaded',timeout:45000});
  if(chosen.location) job.location=chosen.location;
  job.url=chosen.url;
  await page.waitForTimeout(700);
  const main=page.locator('main, article, .entry-content').first();
  job.description=await (await main.count()? main : page.locator('body')).innerText().catch(()=>job.description??'');
  return true;
}
