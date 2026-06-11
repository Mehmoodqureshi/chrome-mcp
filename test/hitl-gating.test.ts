/** Phase 5 — the HITL gating decision (pure; runs in CI). */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decideScenario } from '../hitl/gating';
import type { Scenario } from '../hitl/types';

const read: Scenario = { name: 'get_text', tool: 'get_text', args: {}, mutating: false };
const mut: Scenario = { name: 'fill_form', tool: 'fill_form', args: {}, mutating: true };

test('read-only scenarios always run, no confirmation', () => {
  const d = decideScenario(read, { includeMutating: false });
  assert.equal(d.eligible, true);
  assert.equal(d.requiresConfirm, false);
});

test('mutating scenarios are skipped without --include-mutating', () => {
  const d = decideScenario(mut, { includeMutating: false });
  assert.equal(d.eligible, false);
  assert.match(d.reason, /--include-mutating/);
});

test('mutating scenarios run but require confirmation when opted in', () => {
  const d = decideScenario(mut, { includeMutating: true });
  assert.equal(d.eligible, true);
  assert.equal(d.requiresConfirm, true);
});
