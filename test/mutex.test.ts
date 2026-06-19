/**
 * KeyedMutex — the per-key async lock behind the SW's per-tab debugger
 * serialization (Phase 3). Verifies FIFO serialization per key, concurrency
 * across keys, failure isolation, and cleanup.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { KeyedMutex } from '../shared/mutex';

/** A macrotask flush — guarantees all pending microtasks have run. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test('same key runs one-at-a-time in FIFO order', async () => {
  const m = new KeyedMutex();
  const order: string[] = [];
  const gate = deferred<void>();

  const p1 = m.run('k', async () => {
    order.push('a:start');
    await gate.promise;
    order.push('a:end');
  });
  const p2 = m.run('k', async () => {
    order.push('b:start');
    order.push('b:end');
  });

  await tick();
  assert.deepEqual(order, ['a:start']); // b is blocked until a finishes

  gate.resolve();
  await Promise.all([p1, p2]);
  assert.deepEqual(order, ['a:start', 'a:end', 'b:start', 'b:end']);
});

test('different keys run concurrently', async () => {
  const m = new KeyedMutex();
  const started: string[] = [];
  const g1 = deferred<void>();
  const g2 = deferred<void>();

  const p1 = m.run('a', async () => {
    started.push('a');
    await g1.promise;
  });
  const p2 = m.run('b', async () => {
    started.push('b');
    await g2.promise;
  });

  await tick();
  assert.deepEqual([...started].sort(), ['a', 'b']); // both started, neither finished

  g1.resolve();
  g2.resolve();
  await Promise.all([p1, p2]);
});

test('a throwing holder does not block the next holder of the same key', async () => {
  const m = new KeyedMutex();
  const p1 = m.run('k', async () => {
    throw new Error('boom');
  });
  const p2 = m.run('k', async () => 'ok');

  await assert.rejects(p1, /boom/);
  assert.equal(await p2, 'ok');
});

test('keys are released after settling', async () => {
  const m = new KeyedMutex();
  await m.run('k', async () => 1);
  await tick();
  assert.equal(m.size, 0);
});
