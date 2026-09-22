/**
 * The sequencing behind a batched `fill_form`.
 *
 * Batching a form into ONE wire command removes a round-trip per field, but it
 * also removes the router's per-command policy gate: the router evaluates once,
 * before the first field, and then N writes happen with nothing re-checking
 * where they land. That matters because a field's input handler — or a
 * checkbox's click — can navigate the tab, and the values still to be written
 * are exactly the sensitive ones (passwords, personal data). Typing them into
 * whatever page replaced the allowlisted one would be a silent exfiltration.
 *
 * So the gate moves in here and runs per field, against the tab's CURRENT url,
 * reproducing what N separate commands would have enforced. This lives in
 * `shared/` for the same reason `evaluatePolicy` does: it is a security
 * decision, so it belongs where both ends and the test suite can reach it
 * (`extension/` is outside the tsconfig the tests compile).
 */

import { evaluatePolicy } from './policy';
import type { FillFieldOp, FillFormWireResult, WirePolicy } from './protocol';

/** What the caller must supply; everything chrome-specific stays outside. */
export interface FillFormHooks {
  /** The target tab's url right now — re-read before every field. */
  currentUrl: () => Promise<string>;
  /** The live wire policy, or null before a handshake has delivered one. */
  policy: () => WirePolicy | null;
  /** Perform one field write. Throws to fail the batch at this field. */
  write: (op: FillFieldOp) => Promise<void>;
  /** Map a thrown value to a wire error. */
  toError: (err: unknown) => { code: FillFormError['code']; message: string };
}

type FillFormError = NonNullable<FillFormWireResult['error']>;

/**
 * Run `ops` in order, re-gating before each one, stopping at the first failure.
 * Never throws: the failing field is reported in `error` and `filled` counts the
 * writes that actually landed, so the server can tell the caller how far the
 * form got rather than leaving it ambiguous.
 */
export async function runFillFields(ops: readonly FillFieldOp[], hooks: FillFormHooks): Promise<FillFormWireResult> {
  const res: FillFormWireResult = { filled: 0 };
  for (const op of ops) {
    try {
      // Fails CLOSED, exactly as the router does: no policy means nothing runs.
      const policy = hooks.policy();
      if (!policy) throw new PolicyStop('no policy is in force; refusing to fill');
      const verdict = evaluatePolicy(await hooks.currentUrl(), 'fill_form', policy);
      if (!verdict.ok) throw new PolicyStop(verdict.reason);
      await hooks.write(op);
    } catch (err) {
      res.error =
        err instanceof PolicyStop
          ? { selector: op.selector, code: 'POLICY_DENIED', message: err.message }
          : { selector: op.selector, ...hooks.toError(err) };
      return res;
    }
    res.filled++;
  }
  return res;
}

/** A refusal raised by the gate itself, kept distinct from a page-op failure. */
class PolicyStop extends Error {}
