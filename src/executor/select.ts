/**
 * src/executor/select.ts — backend selection.
 *
 * Re-evaluated on every `ensureReady()`: prefer a *responsive* extension (an
 * 800 ms ping probe, so a dead-but-not-yet-reconnected MV3 worker falls through
 * instead of eating a 30 s command timeout), otherwise the CDP fallback. The
 * extension and CDP executors are cached across calls; only the choice is live.
 */

import { type Executor, ExecutorError } from './types';
import { ExtensionExecutor } from './extension-executor';
import { CdpExecutor, type CdpOptions } from './cdp-executor';
import type { BridgeServer } from '../bridge/server';
import type { BackendPreference } from '../config';

export interface SelectorDeps {
  bridge: BridgeServer;
  cdpFallback: boolean;
  prefer: BackendPreference;
  cdp: CdpOptions;
  pingDeadlineMs?: number;
  /** How long a successful ping is trusted before re-probing (ms). A burst of
   *  commands within this window skips the per-call ping round-trip. 0 disables. */
  pingCacheMs?: number;
  /** Test seams — default to the real executors. */
  makeExtension?: (bridge: BridgeServer) => Executor;
  makeCdp?: (opts: CdpOptions) => Executor;
}

/** A responsiveness-aware Executor (extension executors expose `ping`). */
type Pingable = Executor & { ping(deadlineMs?: number): Promise<boolean> };

export function createSelector(deps: SelectorDeps): () => Promise<Executor> {
  const makeExt = deps.makeExtension ?? ((b) => new ExtensionExecutor(b));
  const makeCdp = deps.makeCdp ?? ((o) => new CdpExecutor(o));
  const pingMs = deps.pingDeadlineMs ?? 800;
  const pingCacheMs = deps.pingCacheMs ?? 2_000;

  const ext = makeExt(deps.bridge) as Pingable;
  let cdp: Executor | null = null;
  let lastPingOkAt = 0;

  const cdpAllowed = (): boolean => deps.cdpFallback || deps.prefer === 'cdp' || !!deps.cdp.cdpEndpoint;
  const getCdp = (): Executor | null => {
    if (!cdpAllowed()) return null;
    cdp ??= makeCdp(deps.cdp);
    return cdp;
  };

  const tryExt = async (): Promise<Executor | null> => {
    if (!deps.bridge.hasActiveExtension()) return null;
    // A recent successful ping proves liveness; skip re-pinging within the TTL so
    // a burst of commands doesn't each pay the ~ping round-trip. A truly dead
    // worker closes its socket, flipping hasActiveExtension() false above before
    // this matters — the ping only guards the narrow open-but-frozen window.
    if (pingCacheMs > 0 && Date.now() - lastPingOkAt < pingCacheMs) return ext;
    if (await ext.ping(pingMs)) {
      lastPingOkAt = Date.now();
      return ext;
    }
    return null;
  };

  return async (): Promise<Executor> => {
    if (deps.prefer === 'cdp') {
      const c = getCdp();
      if (c) return c;
      const e = await tryExt();
      if (e) return e;
    } else {
      const e = await tryExt();
      if (e) return e;
      const c = getCdp();
      if (c) return c;
    }
    throw new ExecutorError(
      'NO_BACKEND',
      'No Chrome available: pair the extension, attach a --cdp-endpoint, or enable the CDP fallback.',
    );
  };
}
