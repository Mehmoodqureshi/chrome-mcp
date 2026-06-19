/**
 * shared/mutex.ts — a tiny per-key async lock.
 *
 * Calls sharing a key run one-at-a-time in FIFO order; different keys run
 * concurrently. Pure promises, no platform deps, so it's reusable by the
 * extension service worker and unit-testable without Chrome.
 *
 * Used in the SW to serialize chrome.debugger attach→work→detach per tab (a
 * second attach on the same tab throws, and one op's detach would yank the
 * debugger from a concurrent op) while keeping different tabs parallel.
 */

function noop(): void {
  /* swallow — the tracker must never reject so the queue keeps flowing */
}

export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  /** Run `fn` after all earlier holders of `key` settle. Resolves/rejects with fn's outcome. */
  run<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    // Run fn whether the previous holder resolved or rejected (its failure must
    // not poison this one).
    const result = prev.then(fn, fn);
    // A non-rejecting tracker the next waiter chains on.
    const tail = result.then(noop, noop);
    this.tails.set(key, tail);
    void tail.then(() => {
      // Only drop the entry if no newer waiter has replaced it.
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }

  /** Number of keys with an outstanding or queued holder (for tests/inspection). */
  get size(): number {
    return this.tails.size;
  }
}
