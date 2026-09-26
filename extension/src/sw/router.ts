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
import { ChromeExecutor, CmdError, HANDLED, observedTabUrl, resolveTab, urlForCommand } from './executor';

export interface RouterDeps {
  exec: ChromeExecutor;
  send: (frame: ResultFrame | ErrorFrame) => void;
  /** The policy delivered in `welcome`, or null before one arrives. */
  getPolicy: () => WirePolicy | null;
  log: (message: string) => void;
  /** The "chrome-mcp is working here" tab border; optional so tests can omit it. */
  border?: {
    used(tabId: number): Promise<void>;
    opened(tabId: number): Promise<void>;
    aroundCapture<T>(tabId: number | null, fn: () => Promise<T>): Promise<T>;
  };
}

/** Commands whose output is an image of the page: the border is taken off first. */
const CAPTURES = new Set<string>(['screenshot', 'print_pdf']);

export class CommandRouter {
  constructor(private readonly deps: RouterDeps) {
    for (const m of WIRE_METHODS) {
      if (!HANDLED.has(m)) throw new Error(`router drift: no handler for wire method "${m}"`);
    }
  }

  async dispatch(cmd: CommandFrame): Promise<void> {
    try {
      // THE authoritative policy gate. It runs the SAME shared `evaluatePolicy`
      // the server runs, but here it is decisive rather than defence-in-depth:
      // only this side can resolve the EXACT target tab (an explicit `tabId`, not
      // merely whichever tab is active) and read its URL in the instant before
      // the command executes. The server gates too, but from a URL that is by
      // construction one round-trip stale — so a client that reaches this socket
      // is constrained here, and here alone.
      //
      // Fails CLOSED: no policy (handshake incomplete) means nothing is known to
      // be permitted, so nothing runs. `ping_probe` is the one exemption — it
      // touches no page and no data, and the backend selector uses it to decide
      // whether this browser is alive at all.
      const policy = this.deps.getPolicy();
      if (!policy && cmd.method !== 'ping_probe') {
        throw new CmdError(
          'POLICY_DENIED',
          'no policy has arrived from the chrome-mcp server yet, so this extension is refusing every command',
        );
      }
      // One tab lookup serves the gate, the executor and the result frame.
      const tab = await resolveTab(cmd);
      if (policy) {
        const url = isUrlGated(cmd.method) ? await urlForCommand(cmd, tab) : '';
        const verdict = evaluatePolicy(url, cmd.method, policy);
        if (!verdict.ok) throw new CmdError('POLICY_DENIED', verdict.reason);
      }
      const border = this.deps.border;
      const data =
        border && CAPTURES.has(cmd.method)
          ? await border.aroundCapture(tab, () => this.deps.exec.run(cmd, tab))
          : await this.deps.exec.run(cmd, tab);
      if (border) void this.markBorder(border, cmd, tab, data);
      const frame: ResultFrame = { type: 'result', v: PROTOCOL_VERSION, id: cmd.id, ok: true, data };
      // Ride the tab's landing URL home so the server's next gate needs no
      // round-trip. Best-effort: a closed/unreadable tab just omits it.
      const tabUrl = await observedTabUrl(cmd, tab);
      if (tabUrl) frame.tabUrl = tabUrl;
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

  /** Border the tab a successful command worked in. Never delays or fails the reply. */
  private async markBorder(
    border: NonNullable<RouterDeps['border']>,
    cmd: CommandFrame,
    tab: number | null,
    data: unknown,
  ): Promise<void> {
    try {
      if (cmd.method === 'tab_new') {
        const handle = (data as { tabId?: unknown } | null)?.tabId;
        const id = typeof handle === 'string' ? Number(handle.split(':')[2]) : NaN;
        if (Number.isInteger(id)) await border.opened(id);
      } else if (tab !== null && cmd.method !== 'tab_close') {
        await border.used(tab);
      }
    } catch {
      /* cosmetic only */
    }
  }
}
