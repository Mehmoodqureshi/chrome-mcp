/**
 * src/mcp/snapdiff.ts — remember the last accessibility snapshot per tab and
 * answer "what changed" instead of re-sending the page.
 *
 * A snapshot is the most token-expensive read in the tool surface, and the agent
 * loop that leans on it hardest — snapshot, click, snapshot, click — re-sends a
 * page that is mostly identical every time. The diff is what the caller actually
 * wanted: this button appeared, that error text is new, submit is no longer
 * disabled.
 *
 * Refs (`e1`, `e2`, ...) are minted in document order on every snapshot, so they
 * are NOT identity across snapshots: `e7` is a different element the moment
 * anything above it is inserted. Nodes are therefore matched on role + tag +
 * accessible name, and every diff entry carries the CURRENT ref, so anything the
 * caller is told about is immediately targetable.
 */

import type { SnapshotNode, SnapshotResult } from '../executor/types';

/** How many tabs' snapshots to keep. Small: a convenience cache, not state. */
const MAX_SCOPES = 32;

export interface StoredSnapshot {
  id: string;
  ts: number;
  url: string;
  nodes: SnapshotNode[];
}

export interface SnapshotDiff {
  /** The snapshot this was compared against, or null when there was none. */
  since: string | null;
  added: SnapshotNode[];
  removed: SnapshotNode[];
  changed: Array<{ node: SnapshotNode; was: Partial<SnapshotNode> }>;
  unchanged: number;
}

const store = new Map<string, StoredSnapshot>();
let counter = 0;

/** Identity of a node ACROSS snapshots - deliberately not the ref. */
export function nodeKey(n: SnapshotNode): string {
  return `${n.role} | ${n.tag} | ${n.name}`;
}

/** Scope key: snapshots are per browser profile and per tab. */
export function scopeOf(profile: string, tabId?: string): string {
  return `${profile} | ${tabId ?? 'active'}`;
}

export function rememberSnapshot(scope: string, snap: SnapshotResult): StoredSnapshot {
  const stored: StoredSnapshot = { id: `snap_${++counter}`, ts: Date.now(), url: snap.url, nodes: snap.nodes };
  store.set(scope, stored);
  // Bounded: drop the oldest insertion once over the ceiling.
  while (store.size > MAX_SCOPES) {
    const oldest = store.keys().next();
    if (oldest.done) break;
    store.delete(oldest.value);
  }
  return stored;
}

export function lastSnapshot(scope: string): StoredSnapshot | undefined {
  return store.get(scope);
}

/** Forget everything - for tests, and whenever the active profile changes. */
export function resetSnapshots(): void {
  store.clear();
  counter = 0;
}

/** The state fields a diff reports as "changed" (the ref is expected to move). */
const STATE_FIELDS: Array<keyof SnapshotNode> = ['value', 'disabled', 'checked'];

export function diffSnapshots(prev: StoredSnapshot | undefined, next: SnapshotResult): SnapshotDiff {
  if (!prev) {
    return { since: null, added: next.nodes, removed: [], changed: [], unchanged: 0 };
  }
  const before = new Map<string, SnapshotNode>();
  for (const n of prev.nodes) if (!before.has(nodeKey(n))) before.set(nodeKey(n), n);

  const added: SnapshotNode[] = [];
  const changed: SnapshotDiff['changed'] = [];
  let unchanged = 0;
  const matched = new Set<string>();

  for (const n of next.nodes) {
    const key = nodeKey(n);
    const old = before.get(key);
    if (!old) {
      added.push(n);
      continue;
    }
    matched.add(key);
    const was: Partial<SnapshotNode> = {};
    for (const f of STATE_FIELDS) {
      if (old[f] !== n[f]) (was as Record<string, unknown>)[f] = old[f];
    }
    if (Object.keys(was).length > 0) changed.push({ node: n, was });
    else unchanged++;
  }

  const removed = prev.nodes.filter((n) => !matched.has(nodeKey(n)));
  return { since: prev.id, added, removed, changed, unchanged };
}
