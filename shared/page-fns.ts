/**
 * shared/page-fns.ts — the ONE function that runs inside a page for every
 * DOM-touching command.
 *
 * MUST be self-contained: `chrome.scripting.executeScript` serializes it to
 * source, so it may not close over anything from this module. That constraint is
 * exactly why every op lives in one function instead of ten — the shared
 * helpers below (`deepQuery` above all) can then be written once and are
 * automatically used by every op.
 *
 * `deepQuery` is the reason this file exists. `snapshot` deliberately walks open
 * shadow roots and stamps `data-mcp-ref` on what it finds there, but every
 * action used to resolve that ref with a plain `document.querySelector`, which
 * cannot cross a shadow boundary. So the snapshot advertised elements that no
 * click could ever reach — a structural dead end on every web-component site.
 * One resolver, used by every op, is what closes it.
 */

/** Ops the page-side dispatcher understands. */
export type PageOpName =
  | 'probe'
  | 'text'
  | 'html'
  | 'click'
  | 'type'
  | 'focus'
  | 'point'
  | 'hover'
  | 'select'
  | 'measure'
  | 'scroll'
  | 'storage'
  | 'waitSelector'
  | 'waitFor';

export interface PageOpArgs {
  op: PageOpName;
  selector?: string | null;
  text?: string;
  clear?: boolean;
  outer?: boolean;
  values?: string[];
  x?: number | null;
  y?: number | null;
  deltaX?: number | null;
  deltaY?: number | null;
  storageOp?: string;
  key?: string | null;
  value?: string | null;
  session?: boolean;
  textContains?: string | null;
  gone?: boolean;
  timeoutMs?: number;
  interval?: number;
}

/**
 * Runs IN THE PAGE (or in one frame of it). Returns a plain JSON-able object;
 * `found: false` means the selector matched nothing, which the caller renders as
 * SELECTOR_NOT_FOUND. Never throws across the boundary — a page that blows up
 * inside an op is reported as `{ ok: false, error }`.
 */
export function pageOp(a: PageOpArgs): unknown {
  // -- shared helpers (must stay INSIDE: this function is serialized alone) --

  /** querySelector that descends into open shadow roots, breadth-ish first. */
  const deepQuery = (sel: string): Element | null => {
    const roots: Array<Document | ShadowRoot> = [document];
    const seen = new Set<Document | ShadowRoot>();
    while (roots.length > 0) {
      const root = roots.shift() as Document | ShadowRoot;
      if (seen.has(root)) continue;
      seen.add(root);
      let hit: Element | null = null;
      try {
        hit = root.querySelector(sel);
      } catch {
        return null; // malformed selector — same answer for every root
      }
      if (hit) return hit;
      let hosts: Element[] = [];
      try {
        hosts = Array.from(root.querySelectorAll('*'));
      } catch {
        hosts = [];
      }
      for (const host of hosts) {
        const sr = (host as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
        if (sr && !seen.has(sr)) roots.push(sr);
      }
    }
    return null;
  };

  /**
   * Where this frame sits inside the TOP document, so a CDP mouse event (which
   * is dispatched in top-viewport coordinates) lands on an element that lives in
   * an iframe. `window.frameElement` is readable only when the parent is
   * same-origin, so a cross-origin ancestor yields `exact: false` and the caller
   * falls back to a synthetic click rather than clicking the wrong pixel.
   */
  const frameOffset = (): { dx: number; dy: number; exact: boolean; scrollX: number; scrollY: number } => {
    let dx = 0;
    let dy = 0;
    let win: Window = window;
    try {
      while (win.parent && win.parent !== win) {
        const fe = win.frameElement as HTMLElement | null;
        if (!fe) return { dx, dy, exact: false, scrollX: window.scrollX, scrollY: window.scrollY };
        const r = fe.getBoundingClientRect();
        dx += r.left;
        dy += r.top;
        win = win.parent;
      }
    } catch {
      return { dx, dy, exact: false, scrollX: window.scrollX, scrollY: window.scrollY };
    }
    return { dx, dy, exact: true, scrollX: win.scrollX, scrollY: win.scrollY };
  };

  const sel = typeof a.selector === 'string' && a.selector.length > 0 ? a.selector : null;
  const el = sel ? (deepQuery(sel) as HTMLElement | null) : null;
  const missing = sel !== null && el === null;

  /** Set a value the way React/Vue see it (they patch the instance setter). */
  const setValue = (node: HTMLInputElement | HTMLTextAreaElement, next: string): void => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), 'value')?.set;
    if (setter) setter.call(node, next);
    else node.value = next;
    node.dispatchEvent(new Event('input', { bubbles: true }));
  };

  switch (a.op) {
    case 'probe':
      return { found: true, url: location.href, title: document.title };

    case 'text': {
      if (missing) return { found: false };
      const root = el ?? document.body;
      return { found: true, text: root ? (root as HTMLElement).innerText ?? '' : '' };
    }

    case 'html': {
      if (missing) return { found: false };
      const root = el ?? document.documentElement;
      if (!root) return { found: true, html: '' };
      const outer = a.outer === true || !sel;
      return { found: true, html: outer ? root.outerHTML : (root as HTMLElement).innerHTML };
    }

    case 'click': {
      if (!el) return { found: false };
      el.scrollIntoView({ block: 'center' });
      el.click();
      return { found: true };
    }

    case 'type': {
      const node = el as HTMLInputElement | HTMLTextAreaElement | null;
      if (!node) return { found: false };
      node.focus();
      const next = (a.clear ? '' : node.value ?? '') + (a.text ?? '');
      setValue(node, next);
      node.dispatchEvent(new Event('change', { bubbles: true }));
      return { found: true };
    }

    case 'focus': {
      const node = el as HTMLInputElement | HTMLTextAreaElement | null;
      if (!node) return { found: false };
      node.focus();
      if (a.clear) setValue(node, '');
      return { found: true };
    }

    case 'point': {
      if (!el) return { found: false };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      const off = frameOffset();
      return {
        found: true,
        x: r.left + r.width / 2 + off.dx,
        y: r.top + r.height / 2 + off.dy,
        // false => this frame's coordinates cannot be mapped to the top viewport.
        exact: off.exact,
      };
    }

    case 'hover': {
      if (!el) return { found: false };
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      return { found: true };
    }

    case 'select': {
      const node = el as unknown as HTMLSelectElement | null;
      if (!node || !node.options) return { found: false };
      const want = new Set(a.values ?? []);
      let matched = false;
      for (const opt of Array.from(node.options)) {
        const on = want.has(opt.value) || want.has(opt.label) || want.has(opt.text);
        opt.selected = on;
        if (on) matched = true;
      }
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
      return { found: true, matched };
    }

    case 'measure': {
      const d = document.documentElement;
      const dims = {
        w: window.innerWidth,
        h: window.innerHeight,
        fullW: Math.max(d.scrollWidth, d.clientWidth),
        fullH: Math.max(d.scrollHeight, d.clientHeight),
      };
      if (!sel) return { found: true, dims, element: null, missing: false };
      if (!el) return { found: true, dims, element: null, missing: true };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      const off = frameOffset();
      // viewport rect + this frame's offset + the TOP document's scroll ->
      // document coordinates of the page the screenshot actually captures.
      return {
        found: true,
        dims,
        element: {
          x: r.left + off.dx + off.scrollX,
          y: r.top + off.dy + off.scrollY,
          w: r.width,
          h: r.height,
        },
        missing: false,
        exact: off.exact,
      };
    }

    case 'scroll': {
      if (el) el.scrollIntoView({ block: 'center' });
      else if (a.x != null || a.y != null) window.scrollTo(a.x ?? 0, a.y ?? 0);
      else window.scrollBy(a.deltaX ?? 0, a.deltaY ?? 0);
      return { found: !missing };
    }

    case 'storage': {
      const store = a.session ? window.sessionStorage : window.localStorage;
      const op = a.storageOp;
      if (op === 'set') {
        store.setItem(String(a.key), String(a.value ?? ''));
        return { found: true, ok: true };
      }
      if (op === 'remove') {
        store.removeItem(String(a.key));
        return { found: true, ok: true };
      }
      if (op === 'clear') {
        store.clear();
        return { found: true, ok: true };
      }
      if (a.key) return { found: true, ok: true, value: store.getItem(a.key) };
      const entries: Record<string, string> = {};
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (k) entries[k] = store.getItem(k) ?? '';
      }
      return { found: true, ok: true, entries };
    }

    // -- the two polling ops: one injection that resolves in-page, rather than
    //    one executeScript round-trip per tick --
    case 'waitSelector': {
      const deadline = Date.now() + (a.timeoutMs ?? 5_000);
      const every = a.interval ?? 120;
      return new Promise<unknown>((resolve) => {
        const tick = (): void => {
          if (sel && deepQuery(sel)) return resolve({ found: true });
          if (Date.now() > deadline) return resolve({ found: false });
          setTimeout(tick, every);
        };
        tick();
      });
    }

    case 'waitFor': {
      const deadline = Date.now() + (a.timeoutMs ?? 30_000);
      const every = a.interval ?? 150;
      const want = typeof a.textContains === 'string' && a.textContains.length > 0 ? a.textContains : null;
      const gone = a.gone === true;
      return new Promise<unknown>((resolve) => {
        const hit = (): boolean => {
          let present: boolean;
          if (sel) present = !!deepQuery(sel);
          else if (want) present = (document.body?.innerText ?? '').includes(want);
          else present = true;
          return gone ? !present : present;
        };
        const tick = (): void => {
          if (hit()) return resolve({ found: true, matched: true });
          if (Date.now() > deadline) return resolve({ found: true, matched: false });
          setTimeout(tick, every);
        };
        tick();
      });
    }

    default:
      return { found: false, error: `unknown page op: ${String(a.op)}` };
  }
}
