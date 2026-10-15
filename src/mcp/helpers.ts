/**
 * src/mcp/helpers.ts — the high-level tools composed SERVER-SIDE from executor
 * primitives. They never touch the wire directly: `extract_links` and
 * `read_as_markdown` read via primitives; `fill_form` batches its field writes
 * when the backend can (else sequences fill+click).
 * (Only `download_file` is privileged and lives on the executor.)
 */

import { Parser } from 'htmlparser2';
import { ExecutorError, type Executor, type FrameOpts, type Target } from '../executor/types';
import { htmlToMarkdown } from './markdown-extract';

export interface LinkOut {
  href: string;
  text: string;
  ref?: string;
}

/**
 * Collect anchors from the page (or a subtree). Implemented as a single page
 * eval so it is one round-trip; falls back to parsing getHtml if eval is denied.
 *
 * `dedupe` collapses anchors that share an href (nav/footer repetition is common
 * noise when crawling); `limit` caps the number of links returned. Both are
 * applied server-side after collection, so they work on either code path.
 */
export async function extractLinks(
  ex: Executor,
  args: { selector?: string; sameOriginOnly?: boolean; dedupe?: boolean; limit?: number; tabId?: string } & FrameOpts,
): Promise<{ links: LinkOut[] }> {
  const root = args.selector ? JSON.stringify(args.selector) : 'null';
  const expr = `(() => {
    const root = ${root} ? document.querySelector(${root}) : document;
    if (!root) return [];
    const here = location.origin;
    return [...root.querySelectorAll('a[href]')].filter(a => {
      const raw = (a.getAttribute('href') || '').trim();
      if (!raw || raw.startsWith('#')) return false;
      try {
        const url = new URL(a.href);
        return !['javascript:', 'data:', 'blob:'].includes(url.protocol) &&
          (${args.sameOriginOnly ? 'url.origin === here' : 'true'});
      } catch { return false; }
    }).map(a => ({ href: a.href, text: (a.textContent || '').trim().slice(0, 200) }));
  })()`;

  const frames: FrameOpts = { frameId: args.frameId, allFrames: args.allFrames };
  let links: LinkOut[] | undefined;
  try {
    const res = await ex.eval(expr, { tabId: args.tabId, ...frames });
    if (res.ok && Array.isArray(res.value)) links = res.value as LinkOut[];
  } catch (err) {
    if (!(err instanceof ExecutorError) || err.code !== 'POLICY_DENIED') throw err;
  }
  if (!links) {
    // Fallback: parse hrefs out of the HTML (e.g. when eval is policy-denied).
    const result = await ex.getHtml(args.selector ? { selector: args.selector } : undefined, {
      tabId: args.tabId,
      ...frames,
    });
    const tabs = await ex.tabsList();
    const tab = args.tabId ? tabs.find(t => t.tabId === args.tabId) : tabs.find(t => t.active);
    let pageUrl = tab?.url;
    const frameId = result.frameId ?? args.frameId;
    if (frameId !== undefined && frameId !== 0) {
      pageUrl = (await ex.framesList?.({ tabId: args.tabId }))?.find(f => f.frameId === frameId)?.url;
    }
    if (!pageUrl) throw new ExecutorError('TARGET_GONE', 'could not resolve the page URL for link extraction');
    links = linksFromHtml(result.html, pageUrl, args.sameOriginOnly);
  }
  return { links: refineLinks(links, args) };
}

/** Parse serialized HTML without executing page code; the parser decodes entities. */
function linksFromHtml(html: string, pageUrl: string, sameOriginOnly = false): LinkOut[] {
  const raw: LinkOut[] = [];
  let current: LinkOut | undefined;
  let baseHref: string | undefined;
  let skippedDepth = 0;
  new Parser({
    onopentag(name, attrs) {
      if (skippedDepth || ['script', 'style', 'template'].includes(name)) { skippedDepth++; return; }
      if (name === 'base' && baseHref === undefined && attrs.href !== undefined) baseHref = attrs.href;
      if (name === 'a' && attrs.href !== undefined) {
        current = { href: attrs.href.trim(), text: '' };
        raw.push(current);
      }
    },
    ontext(text) { if (current && !skippedDepth) current.text += text; },
    onclosetag(name) {
      if (skippedDepth) { skippedDepth--; return; }
      if (name === 'a') current = undefined;
    },
  }, { decodeEntities: true }).end(html);
  const here = new URL(pageUrl);
  let base = here.href;
  try { if (baseHref !== undefined) base = new URL(baseHref, here).href; } catch { /* ignore invalid base */ }
  return raw.flatMap(link => {
    if (!link.href || link.href.startsWith('#')) return [];
    try {
      const url = new URL(link.href, base);
      if (['javascript:', 'data:', 'blob:'].includes(url.protocol)) return [];
      if (sameOriginOnly && url.origin !== here.origin) return [];
      return [{ href: /^[a-z][a-z\d+.-]*:/i.test(link.href) ? link.href : url.href, text: link.text.trim().slice(0, 200) }];
    } catch { return []; }
  });
}

/**
 * Collapse links that share an href (keeping the first, but preferring a
 * non-empty label) when `dedupe` is set, then cap to `limit`. Order is
 * preserved so the first occurrence of each href wins.
 */
function refineLinks(links: LinkOut[], opts: { dedupe?: boolean; limit?: number }): LinkOut[] {
  let out = links;
  if (opts.dedupe) {
    const byHref = new Map<string, LinkOut>();
    for (const l of links) {
      const existing = byHref.get(l.href);
      if (!existing) byHref.set(l.href, { ...l });
      else if (!existing.text && l.text) existing.text = l.text;
    }
    out = [...byHref.values()];
  }
  if (opts.limit !== undefined && out.length > opts.limit) out = out.slice(0, opts.limit);
  return out;
}

/** Read a page (or subtree) as readable markdown. */
export async function readAsMarkdown(
  ex: Executor,
  args: { selector?: string; tabId?: string } & FrameOpts,
): Promise<string> {
  const { html } = await ex.getHtml(args.selector ? { selector: args.selector } : undefined, {
    tabId: args.tabId,
    frameId: args.frameId,
    allFrames: args.allFrames,
  });
  return htmlToMarkdown(html);
}

/**
 * Fill a set of fields (keyed by selector) and optionally submit. All writes go
 * out as ONE executor call when the backend can batch them; otherwise (older
 * extension, CDP) they fall back to one fill/click per field. Either way the
 * first failing field throws, and submit is a separate click after the fills.
 */
export async function fillForm(
  ex: Executor,
  args: { fields: Record<string, string | boolean>; submitSelector?: string; tabId?: string } & FrameOpts,
): Promise<{ filled: number; submitted: boolean }> {
  const opts = { tabId: args.tabId, frameId: args.frameId, allFrames: args.allFrames };
  const ops = Object.entries(args.fields).map(([selector, value]) => ({ selector, value }));
  const batched = ops.length > 0 && ex.fillFields ? await ex.fillFields(ops, opts) : null;
  let filled = batched?.filled ?? 0;
  if (!batched) {
    for (const { selector, value } of ops) {
      const target: Target = { selector };
      if (typeof value === 'boolean') {
        // Checkbox/radio: a click toggles it.
        await ex.click(target, opts);
      } else {
        await ex.fill(target, value, opts);
      }
      filled++;
    }
  }
  let submitted = false;
  if (args.submitSelector) {
    await ex.click({ selector: args.submitSelector }, opts);
    submitted = true;
  }
  return { filled, submitted };
}
