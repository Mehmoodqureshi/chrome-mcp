/**
 * src/mcp/helpers.ts — the high-level tools composed SERVER-SIDE from executor
 * primitives. They never touch the wire directly: `extract_links` and
 * `read_as_markdown` read via primitives; `fill_form` sequences fill+click.
 * (Only `download_file` is privileged and lives on the executor.)
 */

import type { Executor, Target } from '../executor/types';
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
  args: { selector?: string; sameOriginOnly?: boolean; dedupe?: boolean; limit?: number; tabId?: string },
): Promise<{ links: LinkOut[] }> {
  const root = args.selector ? JSON.stringify(args.selector) : 'null';
  const expr = `(() => {
    const root = ${root} ? document.querySelector(${root}) : document;
    if (!root) return [];
    const here = location.origin;
    return [...root.querySelectorAll('a[href]')].map(a => ({
      href: a.href, text: (a.textContent || '').trim().slice(0, 200),
    })).filter(l => l.href && (${args.sameOriginOnly ? 'l.href.startsWith(here)' : 'true'}));
  })()`;

  let links: LinkOut[];
  const res = await ex.eval(expr, { tabId: args.tabId });
  if (res.ok && Array.isArray(res.value)) {
    links = res.value as LinkOut[];
  } else {
    // Fallback: parse hrefs out of the HTML (e.g. when eval is policy-denied).
    const { html } = await ex.getHtml(args.selector ? { selector: args.selector } : undefined, {
      tabId: args.tabId,
    });
    links = [];
    const re = /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      links.push({ href: m[1], text: m[2].replace(/<[^>]+>/g, '').trim().slice(0, 200) });
    }
  }
  return { links: refineLinks(links, args) };
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
  args: { selector?: string; tabId?: string },
): Promise<string> {
  const { html } = await ex.getHtml(args.selector ? { selector: args.selector } : undefined, {
    tabId: args.tabId,
  });
  return htmlToMarkdown(html);
}

/** Fill a set of fields (keyed by selector) and optionally submit. */
export async function fillForm(
  ex: Executor,
  args: { fields: Record<string, string | boolean>; submitSelector?: string; tabId?: string },
): Promise<{ filled: number; submitted: boolean }> {
  let filled = 0;
  for (const [selector, value] of Object.entries(args.fields)) {
    const target: Target = { selector };
    if (typeof value === 'boolean') {
      // Checkbox/radio: a click toggles it.
      await ex.click(target, { tabId: args.tabId });
    } else {
      await ex.fill(target, value, { tabId: args.tabId });
    }
    filled++;
  }
  let submitted = false;
  if (args.submitSelector) {
    await ex.click({ selector: args.submitSelector }, { tabId: args.tabId });
    submitted = true;
  }
  return { filled, submitted };
}
