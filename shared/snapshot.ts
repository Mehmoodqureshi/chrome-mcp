/**
 * shared/snapshot.ts — the page-injected accessibility walk, shared VERBATIM by
 * both backends (CDP `page.evaluate` and the extension's `chrome.scripting`).
 *
 * MUST be self-contained: it is serialized to source and runs in the PAGE
 * context, so it may not close over anything from this module. It tags each
 * returned element with a stable `data-mcp-ref` so a later click/type can target
 * it by `ref` (resolved to `[data-mcp-ref="..."]`). Refs live until navigation.
 */

export interface RawSnapshotNode {
  ref: string;
  role: string;
  name: string;
  tag: string;
  value?: string;
  disabled?: boolean;
  checked?: boolean;
  /** A password field. `value` is never populated for one. */
  secret?: boolean;
}

export interface RawSnapshot {
  url: string;
  title: string;
  nodes: RawSnapshotNode[];
  truncated: boolean;
  /** Locator mode, nothing matched: up to 8 "role \"name\"" strings of the
   *  same role, so the caller can say what WAS there without a second read. */
  nearby?: string[];
}

/** A role/name query resolved IN the page (see `collectSnapshot`). */
export interface SnapshotLocator {
  role?: string;
  name?: string;
}

/**
 * Runs IN THE PAGE. Returns interactive (and optionally landmark) elements with
 * fresh refs.
 *
 * With a `locator`, the walk is the same but the SCORING happens here: only the
 * strongest-tier matches come back (and only they get a ref), so resolving
 * "the Sign in button" ships a handful of nodes instead of the whole tree and
 * touches one or two DOM attributes instead of hundreds. The tiers mirror
 * `src/mcp/locate.ts` exactly (exact, case-insensitive, prefix, contains), and
 * the server re-scores what it receives, so both ends always agree.
 *
 * Reads (visibility, names, values) all happen BEFORE the ref attributes are
 * written: interleaving them made every `innerText` after a `setAttribute`
 * re-run style, which on a big page is most of the snapshot's cost.
 */
export function collectSnapshot(interactiveOnly = true, max = 200, locator: SnapshotLocator | null = null): RawSnapshot {
  const INTERACTIVE = 'a[href],button,input,select,textarea,[role=button],[role=link],[role=tab],[role=checkbox],[role=radio],[role=menuitem],[role=option],[role=switch],[contenteditable=true],[onclick]';
  const LANDMARK = 'h1,h2,h3,[role=heading],nav,main,header,footer,[role=navigation]';
  const sel = interactiveOnly ? INTERACTIVE : `${INTERACTIVE},${LANDMARK}`;

  const visible = (el: Element): boolean => {
    const h = el as HTMLElement & { checkVisibility?: (opts?: object) => boolean };
    // The native check covers display:none / visibility:hidden on the element
    // AND its ancestors plus content-visibility, in one call and without a
    // getComputedStyle. Only a zero-size box needs the (cheap) rect on top.
    if (typeof h.checkVisibility === 'function') {
      try {
        if (!h.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })) return false;
        const r = h.getBoundingClientRect();
        return r.width !== 0 || r.height !== 0;
      } catch {
        /* fall through to the manual walk */
      }
    }
    const r = h.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const s = window.getComputedStyle(h);
    if (s.visibility === 'hidden' || s.display === 'none') return false;
    let p: Element | null = el.parentElement;
    while (p) {
      const ps = window.getComputedStyle(p as HTMLElement);
      if (ps.display === 'none' || ps.visibility === 'hidden') return false;
      p = p.parentElement;
    }
    if (h.offsetParent === null && s.position !== 'fixed') return false;
    return true;
  };

  const accName = (el: Element): string => {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const t = labelledby.split(/\s+/).map((id) => document.getElementById(id)?.innerText ?? '').join(' ').trim();
      if (t) return t;
    }
    const ph = el.getAttribute('placeholder');
    if (ph) return ph.trim();
    const title = el.getAttribute('title');
    if (title) return title.trim();
    const text = (el as HTMLElement).innerText ?? '';
    if (text) return text.replace(/\s+/g, ' ').trim().slice(0, 120);
    const alt = el.querySelector('img[alt]')?.getAttribute('alt');
    return (alt ?? '').trim();
  };

  const roleOf = (el: Element): string => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const t = (el as HTMLInputElement).type;
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'button' || t === 'submit') return 'button';
      return 'textbox';
    }
    return tag;
  };

  // Collect candidates across the light DOM *and* open shadow roots, descending
  // recursively. Defensive against null/closed shadow roots and re-visits.
  const seen = new Set<Element>();
  const candidates: Element[] = [];
  const collect = (root: Document | DocumentFragment | ShadowRoot): void => {
    if (candidates.length >= max) return;
    let matched: ArrayLike<Element>;
    try {
      matched = root.querySelectorAll(sel);
    } catch {
      matched = [];
    }
    for (let i = 0; i < matched.length; i++) {
      if (candidates.length >= max) break;
      const el = matched[i];
      if (seen.has(el)) continue;
      seen.add(el);
      candidates.push(el);
    }
    // Descend into any open shadow roots hosted under this root. A plain index
    // loop over the live NodeList: no Array.from copy of every element on the page.
    let hosts: ArrayLike<Element>;
    try {
      hosts = root.querySelectorAll('*');
    } catch {
      hosts = [];
    }
    for (let i = 0; i < hosts.length; i++) {
      if (candidates.length >= max) break;
      const sr = (hosts[i] as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
      if (sr) collect(sr);
    }
  };
  collect(document);

  // -- phase 1: reads only ---------------------------------------------------
  interface Seen {
    el: Element;
    node: Omit<RawSnapshotNode, 'ref'>;
  }
  const read = (el: Element): Seen => {
    const node: Omit<RawSnapshotNode, 'ref'> = { role: roleOf(el), name: accName(el), tag: el.tagName.toLowerCase() };
    // A password field's characters never leave the page. The node still
    // appears (so the model can target it) and is flagged `secret`, but the
    // value is not something a caller has a use for and every caller would
    // otherwise get it by default.
    const isSecret = el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'password';
    if (isSecret) node.secret = true;
    const v = (el as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value;
    if (!isSecret && typeof v === 'string' && v) node.value = v.slice(0, 200);
    if ((el as HTMLInputElement).disabled) node.disabled = true;
    if ((el as HTMLInputElement).checked) node.checked = true;
    return { el, node };
  };

  const els = candidates.filter(visible);
  let picked: Seen[];
  let truncated = false;
  let nearby: string[] | undefined;
  let refPrefix = 'e';

  if (locator && (locator.role !== undefined || locator.name !== undefined)) {
    // Locator mode: score every visible candidate, keep the strongest tier.
    const norm = (x: string): string => x.replace(/\s+/g, ' ').trim().toLowerCase();
    const wantRole = locator.role !== undefined ? norm(locator.role) : null;
    const wantName = locator.name;
    const score = (role: string, name: string): number => {
      if (wantRole !== null && norm(role) !== wantRole) return 0;
      if (!wantName) return 1;
      const have = norm(name);
      const need = norm(wantName);
      if (!have) return 0;
      if (name.trim() === wantName.trim()) return 4;
      if (have === need) return 3;
      if (have.startsWith(need)) return 2;
      if (have.includes(need)) return 1;
      return 0;
    };
    let best = 0;
    picked = [];
    const sameRole: string[] = [];
    for (const el of els) {
      const s = read(el);
      const sc = score(s.node.role, s.node.name);
      if (sc === 0) {
        if ((wantRole === null || norm(s.node.role) === wantRole) && sameRole.length < 8) {
          sameRole.push(`${s.node.role} "${s.node.name}"`);
        }
        continue;
      }
      if (sc > best) {
        best = sc;
        picked = [s];
      } else if (sc === best) {
        picked.push(s);
      }
    }
    if (picked.length === 0) nearby = sameRole;
    // Refs from a locate must not collide with a prior snapshot's e1..eN, which
    // may still be stamped on OTHER elements: use a distinct, per-call prefix.
    refPrefix = `l${Date.now().toString(36).slice(-4)}-`;
  } else {
    picked = [];
    for (const el of els) {
      if (picked.length >= max) break;
      picked.push(read(el));
    }
    truncated = els.length > picked.length;
  }

  // -- phase 2: writes (one attribute per returned node) ----------------------
  const nodes: RawSnapshotNode[] = [];
  let n = 0;
  for (const { el, node } of picked) {
    const ref = `${refPrefix}${++n}`;
    el.setAttribute('data-mcp-ref', ref);
    nodes.push({ ref, ...node });
  }
  return { url: location.href, title: document.title, nodes, truncated, ...(nearby ? { nearby } : {}) };
}
