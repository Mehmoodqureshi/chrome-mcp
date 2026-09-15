/**
 * src/mcp/locate.ts — target an element by what it IS rather than by where it
 * sits in the DOM.
 *
 * Today every action needs a CSS selector or a `ref` from a snapshot, so the
 * cheapest way to click "Sign in" is to pull the whole accessibility tree first
 * and read a ref out of it. That is a large read to perform one small action,
 * and a hand-written selector is the alternative that breaks on the next
 * redeploy.
 *
 * A locator closes that: `{ role: 'button', name: 'Sign in' }` resolves through
 * one snapshot and the caller never sees the tree. The page does the matching
 * itself (`collectSnapshot` with a locator returns only the strongest-tier
 * hits, and stamps refs on those alone), so what crosses the bridge is a
 * handful of nodes rather than 400; this module re-scores them — same tiers:
 * exact, then case-insensitive, then prefix, then contains — so an unambiguous
 * name wins outright and an ambiguous one fails loudly with the candidates
 * rather than silently clicking the first row.
 */

import type { Executor, SnapshotNode, Target } from '../executor/types';
import { McpToolError } from './validators';

export interface Locator {
  role?: string;
  name?: string;
  /** Alias for `name`, for callers that think in visible text. */
  text?: string;
  /** Pick the nth match (0-based) when a locator is legitimately ambiguous. */
  nth?: number;
}

/** Was a locator supplied at all? */
export function hasLocator(l: Locator | undefined): boolean {
  return !!l && (l.role !== undefined || l.name !== undefined || l.text !== undefined);
}

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Rank a node against the locator. Higher is better; 0 means no match.
 * The tiers are what make an exact name beat a substring of a longer label.
 */
function score(node: SnapshotNode, want: { role?: string; name?: string }): number {
  if (want.role && norm(node.role) !== norm(want.role)) return 0;
  if (!want.name) return 1; // role-only locator: any node of that role
  const have = norm(node.name);
  const need = norm(want.name);
  if (!have) return 0;
  if (node.name.trim() === want.name.trim()) return 4; // exact, case-sensitive
  if (have === need) return 3; // exact, case-insensitive
  if (have.startsWith(need)) return 2;
  if (have.includes(need)) return 1;
  return 0;
}

export interface Resolution {
  target: Target;
  node: SnapshotNode;
  /** How many nodes matched at the same (winning) strength. */
  matches: number;
}

/**
 * Resolve a locator to a `ref` by taking one snapshot of the target tab.
 *
 * Throws `McpToolError` when nothing matches or when the best tier is ambiguous
 * — an ambiguous click is a wrong click, and the message lists what it found so
 * the caller can narrow it (or pass `nth`).
 */
export async function resolveLocator(
  ex: Executor,
  loc: Locator,
  opts: { tabId?: string; frameId?: number; allFrames?: boolean } = {},
): Promise<Resolution> {
  const want = { role: loc.role, name: loc.name ?? loc.text };
  const snap = await ex.snapshot({
    tabId: opts.tabId,
    interactiveOnly: false,
    max: 400,
    locator: want,
    frameId: opts.frameId,
    allFrames: opts.allFrames,
  });

  let best = 0;
  let winners: SnapshotNode[] = [];
  for (const node of snap.nodes) {
    const s = score(node, want);
    if (s === 0) continue;
    if (s > best) {
      best = s;
      winners = [node];
    } else if (s === best) {
      winners.push(node);
    }
  }

  const describe = (n: SnapshotNode): string => `${n.role} "${n.name}"`;
  if (winners.length === 0) {
    // A page that scored in place reports what it had of that role as `nearby`;
    // a backend that returned the full tree leaves it to us.
    const sample =
      snap.nearby ??
      snap.nodes
        .filter((n) => !want.role || norm(n.role) === norm(want.role))
        .slice(0, 8)
        .map(describe);
    throw new McpToolError(
      `no element matches ${JSON.stringify(want)}. ` +
        (sample.length
          ? `Closest by role: ${sample.join(', ')}. `
          : 'Nothing on the page has that role. ') +
        'Take a `snapshot` to see what is there, or target by `selector` instead.',
    );
  }

  if (loc.nth !== undefined) {
    const picked = winners[loc.nth];
    if (!picked) {
      throw new McpToolError(
        `nth=${loc.nth} is out of range: ${winners.length} element(s) match ${JSON.stringify(want)}`,
      );
    }
    return { target: { ref: picked.ref }, node: picked, matches: winners.length };
  }

  if (winners.length > 1) {
    throw new McpToolError(
      `${winners.length} elements match ${JSON.stringify(want)}: ${winners.slice(0, 6).map(describe).join(', ')}. ` +
        'Narrow the name, add a role, or pass `nth` to choose one.',
    );
  }

  return { target: { ref: winners[0].ref }, node: winners[0], matches: 1 };
}
