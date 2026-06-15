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
}

export interface RawSnapshot {
  url: string;
  title: string;
  nodes: RawSnapshotNode[];
  truncated: boolean;
}

/** Runs IN THE PAGE. Returns interactive (and optionally landmark) elements with fresh refs. */
export function collectSnapshot(interactiveOnly = true, max = 200): RawSnapshot {
  const INTERACTIVE = 'a[href],button,input,select,textarea,[role=button],[role=link],[role=tab],[role=checkbox],[role=radio],[role=menuitem],[role=option],[role=switch],[contenteditable=true],[onclick]';
  const LANDMARK = 'h1,h2,h3,[role=heading],nav,main,header,footer,[role=navigation]';
  const sel = interactiveOnly ? INTERACTIVE : `${INTERACTIVE},${LANDMARK}`;

  const visible = (el: Element): boolean => {
    const r = (el as HTMLElement).getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const s = window.getComputedStyle(el as HTMLElement);
    if (s.visibility === 'hidden' || s.display === 'none') return false;
    // Prefer the native check (accounts for ancestors, content-visibility, etc.).
    const cv = (el as HTMLElement & { checkVisibility?: (opts?: object) => boolean }).checkVisibility;
    if (typeof cv === 'function') {
      try {
        return cv.call(el, { checkOpacity: false, checkVisibilityCSS: true });
      } catch {
        /* fall through to manual ancestor walk */
      }
    }
    // Fallback: walk ancestors for display:none / visibility:hidden. An element
    // with no offsetParent (and not position:fixed) is detached/hidden.
    let p: Element | null = el.parentElement;
    while (p) {
      const ps = window.getComputedStyle(p as HTMLElement);
      if (ps.display === 'none' || ps.visibility === 'hidden') return false;
      p = p.parentElement;
    }
    if ((el as HTMLElement).offsetParent === null && s.position !== 'fixed') return false;
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
    let matched: Element[];
    try {
      matched = Array.from(root.querySelectorAll(sel));
    } catch {
      matched = [];
    }
    for (const el of matched) {
      if (candidates.length >= max) break;
      if (seen.has(el)) continue;
      seen.add(el);
      candidates.push(el);
    }
    // Descend into any open shadow roots hosted under this root.
    let hosts: Element[];
    try {
      hosts = Array.from(root.querySelectorAll('*'));
    } catch {
      hosts = [];
    }
    for (const host of hosts) {
      if (candidates.length >= max) break;
      const sr = (host as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
      if (sr) collect(sr);
    }
  };
  collect(document);
  const els = candidates.filter(visible);
  const nodes: RawSnapshotNode[] = [];
  let n = 0;
  for (const el of els) {
    if (nodes.length >= max) break;
    const ref = `e${++n}`;
    el.setAttribute('data-mcp-ref', ref);
    const node: RawSnapshotNode = { ref, role: roleOf(el), name: accName(el), tag: el.tagName.toLowerCase() };
    const v = (el as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value;
    if (typeof v === 'string' && v) node.value = v.slice(0, 200);
    if ((el as HTMLInputElement).disabled) node.disabled = true;
    if ((el as HTMLInputElement).checked) node.checked = true;
    nodes.push(node);
  }
  return { url: location.href, title: document.title, nodes, truncated: els.length > nodes.length };
}
