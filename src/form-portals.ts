import { basename } from 'node:path';
import type { Page } from 'playwright';

/** Expand sections before reading fields. Hidden EY sections contain most required questions. */
export async function expandFormSections(page: Page) {
  for (const frame of page.frames()) {
    const expand = frame.getByRole('button', { name: /^(expand all sections|alle abschnitte (aufklappen|erweitern))$/i });
    if (await expand.count() && await expand.first().isVisible()) {
      await expand.first().click({ timeout: 5000 });
      await page.waitForTimeout(500);
    }
  }
}

export async function displayedFilename(page: Page, paths: string[]): Promise<boolean> {
  for (const path of paths) {
    let found = false;
    for (const frame of page.frames()) {
      // Rendered filename after server processing, including shadow DOM.
      const text = frame.getByText(basename(path), { exact: false }).filter({ visible: true });
      if (await text.count()) { found = true; break; }
    }
    if (!found) return false;
  }
  return paths.length > 0;
}

async function waitForFilename(page: Page, path: string) {
  for (let i = 0; i < 40; i++) {
    if (await displayedFilename(page, [path])) return;
    await page.waitForTimeout(500);
  }
  throw new Error(`Das Portal bestätigt den Upload von ${basename(path)} noch nicht`);
}

/** Portal adapters only attach documents. They never click Save, Apply or consent. */
export async function uploadPortalDocuments(page: Page, files: Record<string, string[]>) {
  const host = new URL(page.url()).hostname;
  if (/rewe-group\.com$/.test(host)) {
    const groups = page.locator('rewe-upload-renderer');
    for (const [doc, paths] of Object.entries({ lebenslauf: files.lebenslauf ?? [], weitere: [...(files.anschreiben ?? []), ...(files.weitere ?? [])] })) {
      const group = groups.filter({ has: page.locator('label').filter({ hasText: doc === 'lebenslauf' ? /^Lebenslauf/ : /Weitere Dokumente/ }) }).first();
      for (const path of paths) {
        if (await displayedFilename(page, [path])) continue;
        await group.locator('input[type=file]').setInputFiles(path, { timeout: 10_000 });
        await waitForFilename(page, path);
        // CV upload opens a modal asking whether the portal should parse/overwrite
        // all fields. Decline parsing: our verified profile is filled by the agent.
        const parseDialog = page.locator('csb-dialog-form').filter({hasText:/Sollen die nachfolgenden Felder automatisch/});
        const decline = parseDialog.locator('.do-dialog-abort');
        if (await decline.isVisible().catch(()=>false)) await decline.click({timeout:5000});
      }
    }
  } else if (/successfactors\./.test(host)) {
    for (const [doc, pattern] of [['lebenslauf', /Resume.*Upload a CV.*dialogue/i], ['anschreiben', /Cover letter.*Attach a Cover Letter.*dialogue/i], ['weitere', /Additional documents.*Add a Document.*dialogue/i]] as const) {
      for (const path of files[doc] ?? []) {
        if (await displayedFilename(page, [path])) continue;
        const trigger = page.getByRole('button', { name: pattern });
        if (!(await trigger.count())) throw new Error(`Upload-Schaltfläche für ${doc} im Portal nicht gefunden`);
        await trigger.first().click({ timeout: 8000 });
        // SuccessFactors first opens a source dialog, then an input appears.
        const input = page.locator('input[type=file]').filter({ visible: true }).first();
        await input.setInputFiles(path, { timeout: 10_000 });
        await waitForFilename(page, path);
      }
    }
  }
}
