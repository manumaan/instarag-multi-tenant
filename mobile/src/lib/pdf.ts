import { File, Paths } from 'expo-file-system';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { creatorName, sourceLabel, type Plan, type Source } from './api';
import { frameKey } from './frames';

/*
 * A plan as a PDF, handed to the share sheet.
 *
 * Built on the phone from the plan already on screen: no server, and what is
 * shared is what the user was looking at. The share sheet picks the recipient
 * (Mail, WhatsApp, Messages, AirDrop), so the app never sends anything in
 * anyone's name.
 */

const SUBTITLE = 'Curated by Reel Lens app';
/** A4 at 72 dpi. */
const PAGE = { width: 595, height: 842 };

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * iOS prints HTML through WKWebView, which will not load remote or local image
 * URLs while printing (expo-print's own docs), so every picture is inlined. The
 * download is cached by frame, so sharing the same plan twice is cheap.
 */
async function inline(url: string, key: string): Promise<string | undefined> {
  try {
    const file = new File(Paths.cache, `frame-${key.replace(/[^A-Za-z0-9_-]/g, '_')}.jpg`);
    const local = file.exists ? file : await File.downloadFileAsync(url, file);
    return `data:image/jpeg;base64,${await local.base64()}`;
  } catch {
    return undefined; // a missing picture should not stop the PDF
  }
}

async function inlineAll(pictures: Map<string, string>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const entries = [...pictures];
  // A few at a time: a thirty-tip plan is thirty downloads.
  for (let i = 0; i < entries.length; i += 6) {
    await Promise.all(
      entries.slice(i, i + 6).map(async ([key, url]) => {
        const data = await inline(url, key);
        if (data) out.set(key, data);
      }),
    );
  }
  return out;
}

export function planHtml(plan: Plan, sources: Source[], images: Map<string, string>): string {
  const sourceOf = (id: string) => sources.find((s) => s.media_id === id);

  const sections = plan.sections
    .map((section) => {
      const items = section.items
        .map((item) => {
          const first = item.citations[0];
          const img = first ? images.get(frameKey(first)) : undefined;
          const cites = item.citations.map((c) => escape(sourceLabel(sourceOf(c.media_id), c.ts_ms))).join(' · ');
          return `<div class="item">
            ${img ? `<img src="${img}" />` : '<div class="noimg"></div>'}
            <div class="body"><p>${escape(item.text)}</p>${cites ? `<p class="cite">${cites}</p>` : ''}</div>
          </div>`;
        })
        .join('');
      return `<h2>${escape(section.heading)}</h2>${items}`;
    })
    .join('');

  const gaps = plan.gaps.length
    ? `<div class="gaps"><h3>Not covered by your clips</h3><ul>${plan.gaps.map((g) => `<li>${escape(g)}</li>`).join('')}</ul></div>`
    : '';

  // Deduplicated by creator: two clips by one person read as a repeat.
  const creators = [...new Set(sources.map((s) => creatorName(s.uploader)).filter((n): n is string => Boolean(n)))];

  return `<!doctype html><html><head><meta charset="utf-8" />
<style>
  @page { margin: 36px 40px; }
  body { font-family: -apple-system, 'Helvetica Neue', Roboto, Arial, sans-serif; color: #1b1b1a; font-size: 11pt; line-height: 1.45; }
  header { border-bottom: 2px solid #3b5bdb; padding-bottom: 10px; margin-bottom: 14px; }
  h1 { font-size: 22pt; margin: 0; }
  .subtitle { color: #3b5bdb; font-size: 11pt; margin: 4px 0 0; letter-spacing: .02em; }
  .overview { color: #444; margin: 0 0 6px; }
  .from { color: #777; font-size: 9pt; margin: 0 0 8px; }
  h2 { font-size: 13pt; margin: 18px 0 8px; text-transform: uppercase; letter-spacing: .04em; color: #3b5bdb; }
  .item { display: flex; gap: 12px; margin: 0 0 10px; page-break-inside: avoid; }
  .item img, .noimg { width: 78px; height: 104px; object-fit: cover; border-radius: 6px; flex: none; background: #eee; }
  .body p { margin: 0; }
  .cite { color: #888; font-size: 8.5pt; margin-top: 4px !important; }
  .gaps { margin-top: 18px; padding: 10px 14px; border: 1px solid #e3e3de; border-radius: 8px; background: #fafaf8; page-break-inside: avoid; }
  .gaps h3 { font-size: 11pt; margin: 0 0 4px; }
  .gaps ul { margin: 0; padding-left: 18px; }
  footer { margin-top: 22px; color: #999; font-size: 8.5pt; text-align: center; }
</style></head><body>
<header><h1>${escape(plan.title)}</h1><p class="subtitle">${SUBTITLE}</p></header>
${plan.overview ? `<p class="overview">${escape(plan.overview)}</p>` : ''}
${creators.length ? `<p class="from">From clips by ${escape(creators.join(', '))}</p>` : ''}
${sections}
${gaps}
<footer>${SUBTITLE} · ${new Date().toLocaleDateString()}</footer>
</body></html>`;
}

/** Render the plan to a PDF and open the share sheet with it. */
export async function sharePlanPdf(plan: Plan, sources: Source[], pictures: Map<string, string>): Promise<void> {
  const images = await inlineAll(pictures);
  const { uri } = await Print.printToFileAsync({ html: planHtml(plan, sources, images), ...PAGE });

  // printToFileAsync names the file with a UUID; the recipient sees the name.
  const slug = plan.title.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'Reel-Lens-plan';
  const named = new File(Paths.cache, `${slug}.pdf`);
  if (named.exists) named.delete();
  const printed = new File(uri);
  await printed.move(named);

  if (!(await Sharing.isAvailableAsync())) throw new Error('Sharing is not available on this device');
  await Sharing.shareAsync(printed.uri, {
    mimeType: 'application/pdf',
    UTI: 'com.adobe.pdf',
    dialogTitle: plan.title,
  });
}
