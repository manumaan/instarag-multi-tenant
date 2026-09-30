'use client';

import { sourceLabel, type Plan, type Source } from './api';
import { frameKey } from './frames';

/*
 * A plan as a PDF, shared through the browser — the web half of the mobile
 * app's Share PDF (mobile/src/lib/pdf.ts), with the same layout: title,
 * "Curated by Reel Lens app", overview, and each tip beside its keyframe.
 *
 * Rendered from HTML by the browser itself (html2pdf.js: html2canvas + jsPDF)
 * rather than drawn with jsPDF's text API, because jsPDF's standard fonts are
 * Latin-1: real plans contain "DERE İSKELESİ" and creators named "Elvira🦋",
 * which would come out garbled. The browser renders whatever it can display.
 * The trade-off is that the PDF's text is an image, not selectable.
 *
 * html2canvas supports neither `object-fit` nor flex `gap` reliably, so
 * pictures are background images and rows are a table. It also lays text out
 * word by word and mis-measures Apple's system font (SF Pro): with
 * `-apple-system` first in the stack, a real PDF came out with the spaces
 * between words squeezed shut. Helvetica/Arial measure correctly.
 *
 * Class names are prefixed: this markup is rendered inside the page, so the
 * site's own `.cite` pill style reached in and drew borders on the citations.
 */

const SUBTITLE = 'Curated by Reel Lens app';

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const creatorName = (uploader?: string) => uploader?.split(/[|·•]/)[0].trim() || undefined;

/**
 * Pictures are read into data URLs first: the canvas would otherwise be
 * "tainted" by cross-origin images and refuse to export. The media bucket's
 * CORS rule already allows GET from the site's origins.
 */
async function inline(url: string): Promise<string | undefined> {
  try {
    // `no-store`: the page has usually shown this frame already through a plain
    // <img>, and S3 answers a request without an Origin header with no CORS
    // headers — a cached copy of that response then fails the CORS check here.
    const response = await fetch(url, { cache: 'no-store', mode: 'cors', credentials: 'omit' });
    if (!response.ok) return undefined;
    const blob = await response.blob();
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => resolve(undefined);
      reader.readAsDataURL(blob);
    });
  } catch {
    return undefined; // a missing picture should not stop the PDF
  }
}

function planElement(plan: Plan, sources: Source[], images: Map<string, string>): HTMLElement {
  const sourceOf = (id: string) => sources.find((s) => s.media_id === id);
  const creators = [...new Set(sources.map((s) => creatorName(s.uploader)).filter((n): n is string => Boolean(n)))];

  const sections = plan.sections
    .map((section) => {
      const rows = section.items
        .map((item) => {
          const first = item.citations[0];
          const img = first ? images.get(frameKey(first)) : undefined;
          const cites = item.citations.map((c) => escape(sourceLabel(sourceOf(c.media_id), c.ts_ms))).join(' · ');
          return `<table class="rl-item"><tr>
            <td class="rl-pic"><div class="rl-img" style="${img ? `background-image:url('${img}')` : ''}"></div></td>
            <td class="rl-body"><p>${escape(item.text)}</p>${cites ? `<p class="rl-cite">${cites}</p>` : ''}</td>
          </tr></table>`;
        })
        .join('');
      return `<h2>${escape(section.heading)}</h2>${rows}`;
    })
    .join('');

  const gaps = plan.gaps.length
    ? `<div class="rl-gaps"><h3>Not covered by your clips</h3><ul>${plan.gaps.map((g) => `<li>${escape(g)}</li>`).join('')}</ul></div>`
    : '';

  const el = document.createElement('div');
  el.innerHTML = `<style>
    .rl-pdf { width: 700px; font-family: Helvetica, Arial, sans-serif; word-spacing: normal; letter-spacing: normal; color: #1b1b1a; font-size: 14px; line-height: 1.45; background: #fff; }
    .rl-pdf header { border-bottom: 2px solid #3b5bdb; padding-bottom: 10px; margin-bottom: 14px; }
    .rl-pdf h1 { font-size: 28px; margin: 0; }
    .rl-pdf .rl-subtitle { color: #3b5bdb; font-size: 14px; margin: 4px 0 0; }
    .rl-pdf .rl-overview { color: #444; margin: 0 0 6px; }
    .rl-pdf .rl-from { color: #777; font-size: 12px; margin: 0 0 8px; }
    .rl-pdf h2 { font-size: 16px; margin: 18px 0 8px; text-transform: uppercase; letter-spacing: .04em; color: #3b5bdb; }
    .rl-pdf .rl-item { width: 100%; border-collapse: collapse; margin: 0 0 10px; }
    .rl-pdf .rl-pic { width: 92px; vertical-align: top; padding: 0 12px 0 0; }
    .rl-pdf .rl-img { width: 80px; height: 106px; border-radius: 6px; background: #eee center / cover no-repeat; }
    .rl-pdf .rl-body { vertical-align: top; }
    .rl-pdf .rl-body p { margin: 0; }
    .rl-pdf .rl-cite { color: #888; font-size: 11px; margin-top: 4px !important; }
    .rl-pdf .rl-gaps { margin-top: 18px; padding: 10px 14px; border: 1px solid #e3e3de; border-radius: 8px; background: #fafaf8; }
    .rl-pdf .rl-gaps h3 { font-size: 14px; margin: 0 0 4px; }
    .rl-pdf .rl-gaps ul { margin: 0; padding-left: 18px; }
    .rl-pdf footer { margin-top: 22px; color: #999; font-size: 11px; text-align: center; }
  </style>
  <div class="rl-pdf">
    <header><h1>${escape(plan.title)}</h1><p class="rl-subtitle">${SUBTITLE}</p></header>
    ${plan.overview ? `<p class="rl-overview">${escape(plan.overview)}</p>` : ''}
    ${creators.length ? `<p class="rl-from">From clips by ${escape(creators.join(', '))}</p>` : ''}
    ${sections}
    ${gaps}
    <footer>${SUBTITLE} · ${new Date().toLocaleDateString()}</footer>
  </div>`;
  return el;
}

const fileName = (plan: Plan) =>
  `${plan.title.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'Reel-Lens-plan'}.pdf`;

/** Render the plan to a PDF. Separate from sharing so it can be tested on its own. */
export async function planPdf(
  plan: Plan,
  sources: Source[],
  pictures: Map<string, string>,
): Promise<{ file: File; missingPictures: number }> {
  const images = new Map<string, string>();
  const entries = [...pictures];
  for (let i = 0; i < entries.length; i += 6) {
    await Promise.all(
      entries.slice(i, i + 6).map(async ([key, url]) => {
        const data = await inline(url);
        if (data) images.set(key, data);
      }),
    );
  }

  // Loaded on demand: ~400 KB that nobody needs until they share.
  const html2pdf = (await import('html2pdf.js')).default;
  const blob: Blob = await html2pdf()
    .set({
      margin: [12, 12, 14, 12],
      filename: fileName(plan),
      image: { type: 'jpeg', quality: 0.92 },
      html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff' },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
      // Not in the package's types, but supported: keep a tip, a heading or the
      // gaps panel from being cut across two pages.
      ...({ pagebreak: { mode: ['css', 'legacy'], avoid: ['.rl-item', '.rl-gaps', 'h2'] } } as object),
    })
    .from(planElement(plan, sources, images))
    .outputPdf('blob');

  return {
    file: new File([blob], fileName(plan), { type: 'application/pdf' }),
    missingPictures: pictures.size - images.size,
  };
}

/**
 * Share where the browser can (the system share sheet: Mail, Messages,
 * AirDrop, WhatsApp — the user picks the recipient), download where it can't.
 * Desktop Chrome on macOS is the common case that falls back to a download.
 */
export async function sharePlanPdf(
  plan: Plan,
  sources: Source[],
  pictures: Map<string, string>,
): Promise<{ how: 'shared' | 'downloaded'; missingPictures: number }> {
  const { file, missingPictures } = await planPdf(plan, sources, pictures);

  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: plan.title });
      return { how: 'shared', missingPictures };
    } catch (err) {
      // Closing the share sheet is a choice, not a failure.
      if ((err as Error).name === 'AbortError') return { how: 'shared', missingPictures };
      // Anything else falls through to a download.
    }
  }

  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return { how: 'downloaded', missingPictures };
}
