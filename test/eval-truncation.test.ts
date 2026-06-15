/**
 * FIX 1 verification — EvalResult truncation. Both backends route eval results
 * through `truncateEvalResult`, so testing the shared helper proves the cap is
 * enforced uniformly: a serialized value over MAX_EVAL_BYTES comes back with
 * truncated:true and a bounded value; small / non-serializable / failed results
 * are left untouched and the helper never throws.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { truncateEvalResult, MAX_EVAL_BYTES, type EvalResult } from '../src/executor/types';

test('over-cap serialized value is truncated with a bounded value and truncated:true', () => {
  // A string whose JSON encoding far exceeds the 256KB cap.
  const huge = 'x'.repeat(MAX_EVAL_BYTES * 2);
  const out = truncateEvalResult({ ok: true, value: huge, type: 'string' });
  assert.equal(out.truncated, true);
  assert.equal(typeof out.value, 'string');
  const v = out.value as string;
  assert.ok(v.endsWith('...[truncated]'), 'truncated marker must be appended');
  // Bounded: byte length is the cap plus the short marker, NOT the original 512KB.
  assert.ok(Buffer.byteLength(v, 'utf8') <= MAX_EVAL_BYTES + 32);
  assert.ok(Buffer.byteLength(v, 'utf8') < Buffer.byteLength(huge, 'utf8'));
  assert.equal(out.type, 'string', 'unrelated fields are preserved');
});

test('a small value passes through untouched (no truncated flag)', () => {
  const input: EvalResult = { ok: true, value: { a: 1, b: 'hi' }, type: 'object' };
  const out = truncateEvalResult(input);
  assert.equal(out.truncated, undefined);
  assert.deepEqual(out.value, { a: 1, b: 'hi' });
});

test('a value exactly at the cap is not truncated', () => {
  // JSON of a string is the chars plus two quotes; pick a length so JSON == cap.
  const s = 'a'.repeat(MAX_EVAL_BYTES - 2);
  const out = truncateEvalResult({ ok: true, value: s });
  assert.equal(Buffer.byteLength(JSON.stringify(s), 'utf8'), MAX_EVAL_BYTES);
  assert.equal(out.truncated, undefined);
  assert.equal(out.value, s);
});

test('a failed result is returned unchanged', () => {
  const out = truncateEvalResult({ ok: false, error: 'boom' });
  assert.equal(out.truncated, undefined);
  assert.equal(out.error, 'boom');
});

test('a non-serializable value never throws and is left untouched', () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  let out: EvalResult | undefined;
  assert.doesNotThrow(() => {
    out = truncateEvalResult({ ok: true, value: circular });
  });
  assert.equal(out!.truncated, undefined);
  assert.equal(out!.value, circular);
});

test('an undefined value is left untouched', () => {
  const out = truncateEvalResult({ ok: true, value: undefined, type: 'undefined' });
  assert.equal(out.truncated, undefined);
  assert.equal(out.value, undefined);
});
