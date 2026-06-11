/**
 * test/hitl/gating.ts — the pure decision for whether a scenario may run.
 *
 * Read-only scenarios always run. Mutating scenarios run only when the operator
 * opted in with --include-mutating AND then confirmed interactively (the
 * confirmation is collected by the runner; this function only says whether one
 * is required). Pure + side-effect-free so it is unit-tested in CI.
 */

import type { Scenario, RunOptions } from './types';

export interface GateDecision {
  eligible: boolean;
  requiresConfirm: boolean;
  reason: string;
}

export function decideScenario(scn: Scenario, opts: Pick<RunOptions, 'includeMutating'>): GateDecision {
  if (!scn.mutating) {
    return { eligible: true, requiresConfirm: false, reason: 'read-only' };
  }
  if (!opts.includeMutating) {
    return { eligible: false, requiresConfirm: false, reason: 'mutating — pass --include-mutating to enable' };
  }
  return { eligible: true, requiresConfirm: true, reason: 'mutating — will prompt for confirmation' };
}
