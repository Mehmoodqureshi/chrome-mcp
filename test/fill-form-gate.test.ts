/**
 * Batching a form into one wire command must not weaken the policy gate. The
 * router evaluates once, before the first field; these tests pin that
 * `runFillFields` re-evaluates before EVERY field, so a page that navigates
 * mid-fill cannot collect the values that were still to be written.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runFillFields, type FillFormHooks } from '../shared/fill-form';
import { resolvePolicy } from '../src/security/policy';
import type { FillFieldOp } from '../shared/protocol';

const ALLOWED = 'https://example.com/form';
const EVIL = 'https://evil.test/collect';

const POLICY = resolvePolicy({ allowDomains: ['example.com'], enableMutations: true });

const FIELDS: FillFieldOp[] = [
  { selector: '#user', value: 'ada' },
  { selector: '#password', value: 'hunter2' },
  { selector: '#remember', value: true },
];

/** Hooks that record what got written, reading urls from a scripted sequence. */
function harness(urls: string[], policy = POLICY): { hooks: FillFormHooks; wrote: string[] } {
  const wrote: string[] = [];
  let call = 0;
  return {
    wrote,
    hooks: {
      currentUrl: async () => urls[Math.min(call++, urls.length - 1)] ?? '',
      policy: () => policy,
      write: async (op) => {
        wrote.push(op.selector);
      },
      toError: (err) => ({ code: 'CDP_ERROR', message: err instanceof Error ? err.message : String(err) }),
    },
  };
}

test('all fields land while the tab stays on an allowed url', async () => {
  const { hooks, wrote } = harness([ALLOWED, ALLOWED, ALLOWED]);
  const res = await runFillFields(FIELDS, hooks);
  assert.deepEqual(res, { filled: 3 });
  assert.deepEqual(wrote, ['#user', '#password', '#remember']);
});

test('a mid-fill navigation to a disallowed origin stops the batch before the password', async () => {
  // The first field lands on example.com, then the page navigates to evil.test.
  const { hooks, wrote } = harness([ALLOWED, EVIL, EVIL]);
  const res = await runFillFields(FIELDS, hooks);

  assert.equal(res.filled, 1);
  assert.equal(res.error?.code, 'POLICY_DENIED');
  assert.equal(res.error?.selector, '#password');
  // The whole point: the secret was never typed into the page that replaced it.
  assert.deepEqual(wrote, ['#user']);
  assert.ok(!wrote.includes('#password'));
});

test('no policy fails closed — not one field is written', async () => {
  const { hooks, wrote } = harness([ALLOWED], null as never);
  const res = await runFillFields(FIELDS, hooks);
  assert.equal(res.filled, 0);
  assert.equal(res.error?.code, 'POLICY_DENIED');
  assert.deepEqual(wrote, []);
});

test('an unreadable url is treated as not-allowlisted', async () => {
  const { hooks, wrote } = harness(['']);
  const res = await runFillFields(FIELDS, hooks);
  assert.equal(res.filled, 0);
  assert.equal(res.error?.code, 'POLICY_DENIED');
  assert.deepEqual(wrote, []);
});

test('a failing write reports that field and stops, keeping the landed count', async () => {
  const { hooks, wrote } = harness([ALLOWED, ALLOWED, ALLOWED]);
  const failing: FillFormHooks = {
    ...hooks,
    write: async (op) => {
      if (op.selector === '#password') throw new Error('no element for selector: #password');
      wrote.push(op.selector);
    },
  };
  const res = await runFillFields(FIELDS, failing);
  assert.equal(res.filled, 1);
  assert.equal(res.error?.selector, '#password');
  assert.equal(res.error?.code, 'CDP_ERROR');
  assert.deepEqual(wrote, ['#user']);
});

test('an empty field list is a no-op, not an error', async () => {
  const { hooks, wrote } = harness([ALLOWED]);
  assert.deepEqual(await runFillFields([], hooks), { filled: 0 });
  assert.deepEqual(wrote, []);
});

test('fill_form: the wire timeout grows with the field count, clamped to 60 s..10 min', async () => {
  const { fillFormTimeoutMs } = await import('../shared/protocol');
  assert.equal(fillFormTimeoutMs(0), 60_000);
  assert.equal(fillFormTimeoutMs(3), 60_000, 'small forms keep the old flat budget');
  assert.equal(fillFormTimeoutMs(20), 130_000);
  assert.ok(fillFormTimeoutMs(20) > 20 * 5_000, 'covers every field waiting out its 5 s element wait');
  assert.equal(fillFormTimeoutMs(10_000), 600_000);
  assert.equal(fillFormTimeoutMs(Number.NaN), 60_000);
});

test('fill_form: past the deadline no further field is written, and the stop is a TIMEOUT', async () => {
  const { hooks, wrote } = harness([ALLOWED]);
  let clock = 0;
  const res = await runFillFields(FIELDS, {
    ...hooks,
    deadline: 100,
    now: () => clock,
    write: async (op) => {
      wrote.push(op.selector);
      clock += 60; // each write eats 60 ms of a 100 ms budget
    },
  });
  assert.deepEqual(wrote, ['#user', '#password']);
  assert.equal(res.filled, 2);
  assert.equal(res.error?.code, 'TIMEOUT');
  assert.equal(res.error?.selector, '#remember');
});

test('fill_form: no deadline means every field runs, as before', async () => {
  const { hooks, wrote } = harness([ALLOWED]);
  const res = await runFillFields(FIELDS, hooks);
  assert.equal(res.filled, 3);
  assert.equal(res.error, undefined);
  assert.deepEqual(wrote, ['#user', '#password', '#remember']);
});
