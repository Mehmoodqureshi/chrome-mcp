/**
 * extension/src/sw/tab-border.ts — draws a border around every tab chrome-mcp
 * is working in, so you can see at a glance which tabs the agent is driving.
 *
 * The border is a user stylesheet (`chrome.scripting.insertCSS` on
 * `html::after`), not a DOM node: page reads (get_html, get_text, snapshot)
 * never see it, and page CSS cannot hide it. Its colour follows the page's
 * theme (see shared/tab-border.ts): the site's theme-color when it stands out,
 * otherwise blue, lighter on dark pages.
 *
 * Marked tabs live in chrome.storage.session (tabId -> the CSS injected there)
 * so a service-worker restart does not forget them. The border is taken down
 * for screenshots and PDFs, when the tab leaves the allowed sites, when the
 * server disconnects, and when the user turns it off in Options.
 */

import { evaluatePolicy } from '../../../shared/policy';
import type { WirePolicy } from '../../../shared/protocol';
import { borderCss, pickBorderColor, type PageTheme } from '../../../shared/tab-border';
import { KeyedMutex } from '../../../shared/mutex';

const KEY = 'borderTabs';

type Marked = Record<string, string>;

async function loadMarked(): Promise<Marked> {
  const got = await chrome.storage.session.get(KEY).catch(() => ({}) as Record<string, unknown>);
  const v = got[KEY];
  return v && typeof v === 'object' ? { ...(v as Marked) } : {};
}

const saveMarked = (m: Marked): Promise<void> => chrome.storage.session.set({ [KEY]: m }).catch(() => undefined);

async function enabled(): Promise<boolean> {
  const { tabBorder } = await chrome.storage.local.get('tabBorder');
  return tabBorder !== false; // on unless turned off in Options
}

/** Runs in the page (isolated world): read the theme colours, normalised
 *  through a canvas so any CSS colour syntax comes back as hex or rgba(). */
function readPageTheme(): PageTheme {
  const ctx = document.createElement('canvas').getContext('2d');
  const norm = (v: string): string => {
    if (!ctx || !v) return '';
    ctx.fillStyle = '#010203';
    ctx.fillStyle = v; // an invalid colour leaves the sentinel in place
    const out = String(ctx.fillStyle);
    return out === '#010203' ? '' : out;
  };
  const meta = Array.from(document.querySelectorAll('meta[name="theme-color"]')).find((m) => {
    const media = m.getAttribute('media');
    try {
      return !media || matchMedia(media).matches;
    } catch {
      return false;
    }
  });
  const clear = (v: string): boolean => !v || v === 'transparent' || /,\s*0\)$/.test(v);
  let bg = document.body ? getComputedStyle(document.body).backgroundColor : '';
  if (clear(bg)) bg = getComputedStyle(document.documentElement).backgroundColor;
  return {
    themeColor: norm(meta?.getAttribute('content') ?? ''),
    background: clear(bg) ? '' : norm(bg),
    prefersDark: matchMedia('(prefers-color-scheme: dark)').matches,
  };
}

async function tabAllowed(tabId: number, policy: WirePolicy | null): Promise<boolean> {
  if (!policy) return false;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  return !!tab?.url && evaluatePolicy(tab.url, 'get_text', policy).ok;
}

/** Read the theme and inject the border. Returns the CSS, or '' if the page
 *  cannot be injected yet (still loading, or a chrome:// page). */
async function paint(tabId: number): Promise<string> {
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: readPageTheme });
    const css = borderCss(pickBorderColor((res?.result as PageTheme | undefined) ?? { themeColor: '', background: '', prefersDark: false }));
    await chrome.scripting.insertCSS({ target: { tabId }, css, origin: 'USER' });
    return css;
  } catch {
    return '';
  }
}

async function unpaint(tabId: number, css: string): Promise<void> {
  if (css) await chrome.scripting.removeCSS({ target: { tabId }, css, origin: 'USER' }).catch(() => undefined);
}

export class TabBorder {
  /** One lock for all border state: parallel batch ops touching the same tab
   *  must not both inject (removeCSS takes out one copy, not both). */
  private readonly lock = new KeyedMutex();
  /** Captures in flight per tab: the border comes back after the last one. */
  private readonly capturing = new Map<number, number>();

  constructor(private readonly getPolicy: () => WirePolicy | null) {}

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    return this.lock.run('border', fn);
  }

  /** A command just ran in `tabId`: border it if it isn't already. */
  async used(tabId: number): Promise<void> {
    return this.locked(async () => {
      if (!(await enabled()) || !(await tabAllowed(tabId, this.getPolicy()))) return;
      const marked = await loadMarked();
      if (marked[tabId]) return;
      marked[tabId] = await paint(tabId); // '' = pending; the next page load paints it
      await saveMarked(marked);
    });
  }

  /** A tab opened by tab_new: remember it, and paint once it loads. */
  async opened(tabId: number): Promise<void> {
    return this.locked(async () => {
      if (!(await enabled())) return;
      const marked = await loadMarked();
      marked[tabId] = marked[tabId] ?? '';
      await saveMarked(marked);
    });
  }

  /** A marked tab finished loading a page: the old document took its CSS with
   *  it, so repaint (the new page may have another theme), or drop the tab if
   *  it left the allowed sites. */
  async loaded(tabId: number): Promise<void> {
    return this.locked(async () => {
      const marked = await loadMarked();
      if (!(tabId in marked)) return;
      if (!(await enabled()) || !(await tabAllowed(tabId, this.getPolicy()))) {
        await unpaint(tabId, marked[tabId]);
        delete marked[tabId];
      } else {
        await unpaint(tabId, marked[tabId]); // same-document loads keep the old CSS
        marked[tabId] = await paint(tabId);
      }
      await saveMarked(marked);
    });
  }

  async closed(tabId: number): Promise<void> {
    return this.locked(async () => {
      const marked = await loadMarked();
      if (!(tabId in marked)) return;
      delete marked[tabId];
      await saveMarked(marked);
    });
  }

  /** Take the border down for a capture (screenshot, PDF) and put it back after. */
  async aroundCapture<T>(tabId: number | null, fn: () => Promise<T>): Promise<T> {
    if (tabId === null) return fn();
    const css = await this.locked(async () => {
      const c = (await loadMarked())[tabId] ?? '';
      if (c) this.capturing.set(tabId, (this.capturing.get(tabId) ?? 0) + 1);
      await unpaint(tabId, c);
      return c;
    });
    if (!css) return fn();
    try {
      return await fn();
    } finally {
      await this.locked(async () => {
        const left = (this.capturing.get(tabId) ?? 1) - 1;
        if (left > 0) return void this.capturing.set(tabId, left);
        this.capturing.delete(tabId);
        // Only restore if nothing cleared or repainted the tab meanwhile.
        if ((await loadMarked())[tabId] !== css) return;
        await chrome.scripting.insertCSS({ target: { tabId }, css, origin: 'USER' }).catch(() => undefined);
      });
    }
  }

  /** Server gone or border switched off: clear every tab. */
  async clearAll(): Promise<void> {
    return this.locked(async () => {
      const marked = await loadMarked();
      await Promise.all(Object.entries(marked).map(([id, css]) => unpaint(Number(id), css)));
      await saveMarked({});
    });
  }
}
