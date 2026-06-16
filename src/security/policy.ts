/**
 * src/security/policy.ts — the default-deny domain policy and capability gate.
 *
 * This is the real exfiltration firewall. Because this tool feeds untrusted page
 * text to an LLM that can call `eval`, prompt-injection-to-exfil is a PRIMARY
 * threat, so the policy:
 *   - is ON by default with a SAFE default (empty allowlist, no eval, no
 *     downloads, mutations disabled),
 *   - gates READS as well as writes (reads are the exfil payload),
 *   - is enforced at BOTH ends. The decision lives in `shared/policy.ts`
 *     (`evaluatePolicy`); the server wraps it here (`assertUrlAllowed`) and the
 *     extension router runs the SAME function against the policy delivered in the
 *     `welcome` frame. Because both ends call one shared function, they cannot
 *     drift, and a client that bypasses the server still hits the extension gate.
 *     (The bridge token remains the PRIMARY trust boundary for the WebSocket;
 *     the extension gate is defense-in-depth on top of it.)
 *
 * `assertUrlAllowed(url, method, policy)` is the single chokepoint. It throws an
 * `ExecutorError('POLICY_DENIED', …)` which the never-throw dispatch firewall
 * renders as a structured MCP error.
 */

import type { WireMethod, WirePolicy } from '../../shared/protocol';
import { ExecutorError } from '../executor/types';
import {
  evaluatePolicy,
  isReadMethod,
  isMutatingMethod,
  isUrlGated,
  hostOf,
  isDomainAllowed,
} from '../../shared/policy';

// Re-exported so existing server-side importers keep their entry point.
export { isReadMethod, isMutatingMethod, isUrlGated, hostOf, isDomainAllowed };

// ---------------------------------------------------------------------------
// Policy shape + defaults
// ---------------------------------------------------------------------------

/** The full server-side policy: the wire-serializable {@link WirePolicy} plus the
 *  server-only `uploadsDir` (a local path, never sent to the extension). */
export interface Policy extends WirePolicy {
  /** If set, `upload_file` may only read files inside this directory (absolute path). */
  uploadsDir?: string;
}

/** The SAFE default: deny everything until the user opts in. */
export const DEFAULT_POLICY: Readonly<Policy> = Object.freeze({
  allowDomains: [],
  allowEval: false,
  allowDownloads: false,
  allowUploads: false,
  uploadsDir: undefined,
  allowAllTabs: false,
  enableMutations: false,
});

/** Merge a partial (from a policy file and/or CLI flags) over the safe default. */
export function resolvePolicy(partial?: Partial<Policy>): Policy {
  return {
    allowDomains: partial?.allowDomains ?? [...DEFAULT_POLICY.allowDomains],
    allowEval: partial?.allowEval ?? DEFAULT_POLICY.allowEval,
    allowDownloads: partial?.allowDownloads ?? DEFAULT_POLICY.allowDownloads,
    allowUploads: partial?.allowUploads ?? DEFAULT_POLICY.allowUploads,
    uploadsDir: partial?.uploadsDir ?? DEFAULT_POLICY.uploadsDir,
    allowAllTabs: partial?.allowAllTabs ?? DEFAULT_POLICY.allowAllTabs,
    enableMutations: partial?.enableMutations ?? DEFAULT_POLICY.enableMutations,
  };
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * Throw `POLICY_DENIED` unless `method` against `url` is permitted by `policy`.
 * `url` is the DESTINATION for navigation, otherwise the current tab URL.
 * Thin server-side wrapper over the shared, pure `evaluatePolicy` — the SAME
 * function the extension router runs, so the two ends cannot drift.
 */
export function assertUrlAllowed(url: string, method: WireMethod, policy: Policy): void {
  const verdict = evaluatePolicy(url, method, policy);
  if (!verdict.ok) throw new ExecutorError('POLICY_DENIED', verdict.reason);
}
