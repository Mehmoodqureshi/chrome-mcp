/**
 * src/executor/manager.ts — owns the process-global active Executor and the
 * `withReadyExecutor()` accessor every tool routes through (the `withReadyDriver`
 * analog from the LinkedIn repo).
 *
 * Phase 1 holds a single Executor produced by an injected factory (the Stub).
 * Later phases replace the factory with real selection logic (extension-if-
 * responsive else CDP), but the surface the tools see — `ensureReady()` +
 * `policy` — does not change.
 */

import { type Executor, ExecutorError } from './types';
import type { Policy } from '../security/policy';

export interface ManagerOptions {
  policy: Policy;
  /** Lazily construct a single backend on first use (Phase 1: the Stub). */
  makeExecutor?: () => Executor;
  /** Phase 3+ selection strategy, re-evaluated each `ensureReady()`. Wins over
   *  `makeExecutor` when both are present. Returns the chosen (not-yet-ready)
   *  Executor; the manager calls `ensureReady()` on it. */
  select?: () => Promise<Executor>;
}

export class ExecutorManager {
  private current: Executor | null = null;
  private readying: Promise<Executor> | null = null;

  constructor(private readonly opts: ManagerOptions) {}

  get policy(): Policy {
    return this.opts.policy;
  }

  /** Inject a ready-made executor (tests, or a later phase's selector). */
  setExecutor(ex: Executor): void {
    this.current = ex;
  }

  /**
   * Return a ready Executor, constructing it lazily and single-flight-guarding
   * concurrent callers. Throws `NO_BACKEND` when nothing is configured.
   */
  async ensureReady(): Promise<Executor> {
    if (this.readying) return this.readying;
    this.readying = this.doEnsure();
    try {
      return await this.readying;
    } finally {
      this.readying = null;
    }
  }

  private async doEnsure(): Promise<Executor> {
    // Selection strategy (Phase 3+): re-pick the backend each call.
    if (this.opts.select) {
      const chosen = await this.opts.select();
      this.current = chosen;
      await chosen.ensureReady();
      return chosen;
    }
    // Single-backend path (Phase 1 stub).
    if (!this.current) {
      if (!this.opts.makeExecutor) {
        throw new ExecutorError(
          'NO_BACKEND',
          'No Chrome available: pair the extension or enable a backend.',
        );
      }
      this.current = this.opts.makeExecutor();
    }
    await this.current.ensureReady();
    return this.current;
  }

  async dispose(): Promise<void> {
    const ex = this.current;
    this.current = null;
    await ex?.dispose();
  }
}

// ---------------------------------------------------------------------------
// Process-global singleton
// ---------------------------------------------------------------------------

let singleton: ExecutorManager | null = null;

/** Install (or replace) the global manager. Returns it. */
export function configureManager(opts: ManagerOptions): ExecutorManager {
  singleton = new ExecutorManager(opts);
  return singleton;
}

export function getManager(): ExecutorManager {
  if (!singleton) throw new Error('ExecutorManager has not been configured');
  return singleton;
}

/** Tear down the singleton (tests). */
export function resetManagerForTesting(): void {
  singleton = null;
}

export async function withReadyExecutor(): Promise<Executor> {
  return getManager().ensureReady();
}
