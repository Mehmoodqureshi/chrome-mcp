/**
 * extension/src/sw/router.ts — the never-throw command firewall (the extension
 * mirror of the server's dispatchToolCall). Exactly one result/error frame per
 * command id; a thrown handler becomes an ErrorFrame, never an unhandled
 * rejection. Asserts at construction that every WireMethod has a handler.
 */

import {
  PROTOCOL_VERSION,
  WIRE_METHODS,
  type CommandFrame,
  type ErrorFrame,
  type ExecutorErrorCode,
  type ResultFrame,
  type WirePolicy,
} from '../../../shared/protocol';
import { evaluatePolicy, isUrlGated } from '../../../shared/policy';
import { ChromeExecutor, CmdError, HANDLED, urlForCommand } from './executor';

export interface RouterDeps {
  exec: ChromeExecutor;
  send: (frame: ResultFrame | ErrorFrame) => void;
  /** The policy delivered in `welcome`, or null before one arrives. */
  getPolicy: () => WirePolicy | null;
  log: (message: string) => void;
}

export class CommandRouter {
  constructor(private readonly deps: RouterDeps) {
    for (const m of WIRE_METHODS) {
      if (!HANDLED.has(m)) throw new Error(`router drift: no handler for wire method "${m}"`);
    }
  }

  async dispatch(cmd: CommandFrame): Promise<void> {
    try {
      // Extension-side policy mirror (defense-in-depth): run the SAME shared gate
      // the server runs, so a client that bypasses the server can't drive the
      // extension outside policy. Fails closed if the policy hasn't arrived.
      const policy = this.deps.getPolicy();
      if (policy) {
        const url = isUrlGated(cmd.method) ? await urlForCommand(cmd) : '';
        const verdict = evaluatePolicy(url, cmd.method, policy);
        if (!verdict.ok) throw new CmdError('POLICY_DENIED', verdict.reason);
      }
      const data = await this.deps.exec.run(cmd);
      const frame: ResultFrame = { type: 'result', v: PROTOCOL_VERSION, id: cmd.id, ok: true, data };
      this.deps.send(frame);
    } catch (err) {
      const code: ExecutorErrorCode = err instanceof CmdError ? err.code : 'CDP_ERROR';
      const message = err instanceof Error ? err.message : String(err);
      this.deps.log(`command "${cmd.method}" failed: ${message}`);
      const frame: ErrorFrame = {
        type: 'error',
        v: PROTOCOL_VERSION,
        id: cmd.id,
        ok: false,
        error: { code, message },
      };
      this.deps.send(frame);
    }
  }
}
