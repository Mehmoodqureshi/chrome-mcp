/**
 * src/mcp/batch.ts — the `batch` fan-out tool: run many tool calls in one
 * request, in parallel (default) or serially.
 *
 * Pure server-side composition: every sub-op is routed back through the same
 * `dispatchToolCall` firewall, so it inherits the policy gate (server AND
 * extension), the rate limiter, the executor-ready guard, and never-throw error
 * rendering. There is no security bypass — a batch of N tool calls is exactly N
 * ordinary tool calls that happen to be issued together.
 *
 * Concurrency safety: in parallel mode a tab-scoped sub-op that omits `tabId`
 * would fall back to the shared "active tab" pointer, which races under
 * concurrency (see docs/BLUEPRINT.md and the SW executor's active-tab default).
 * So parallel mode REQUIRES an explicit `tabId` on tab-scoped ops; the op is
 * rejected (as its own isError result) rather than silently mis-routed.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { errorResult } from './envelopes';
import { asArgs, McpToolError, optionalBoolean, optionalNumber, optionalString } from './validators';

/** Routes a single tool call through the never-throw firewall. */
export type DispatchFn = (name: string, args: unknown) => Promise<CallToolResult>;

export interface BatchDeps {
  dispatch: DispatchFn;
  /** True for tools that act on a specific tab and default to the active tab
   *  when `tabId` is omitted — those need an explicit `tabId` in parallel mode. */
  requiresExplicitTab: (tool: string) => boolean;
}

/** Hard cap on operations per batch — bounds memory (results accumulate) and blast radius. */
const MAX_OPS = 50;
const DEFAULT_CONCURRENCY = 6;
const MAX_CONCURRENCY = 16;

type Mode = 'parallel' | 'serial';
type OpStatus = 'ok' | 'error' | 'skipped';

interface BatchOp {
  tool: string;
  args: Record<string, unknown>;
}

interface OpOutcome {
  status: OpStatus;
  result?: CallToolResult;
}

/** Validate the `ops` envelope. Structural problems throw (the whole batch is
 *  malformed); per-op semantic problems are handled later as per-op errors. */
function parseOps(raw: unknown): BatchOp[] {
  if (!Array.isArray(raw)) throw new McpToolError('"ops" must be an array of { tool, args } objects');
  if (raw.length === 0) throw new McpToolError('"ops" must contain at least one operation');
  if (raw.length > MAX_OPS) throw new McpToolError(`"ops" has ${raw.length} operations; the max is ${MAX_OPS}`);
  return raw.map((o, i) => {
    if (typeof o !== 'object' || o === null || Array.isArray(o)) {
      throw new McpToolError(`ops[${i}] must be an object with a "tool" and optional "args"`);
    }
    const rec = o as Record<string, unknown>;
    if (typeof rec.tool !== 'string' || rec.tool.length === 0) {
      throw new McpToolError(`ops[${i}].tool must be a non-empty string`);
    }
    if (rec.args !== undefined && (typeof rec.args !== 'object' || rec.args === null || Array.isArray(rec.args))) {
      throw new McpToolError(`ops[${i}].args must be an object`);
    }
    return { tool: rec.tool, args: (rec.args as Record<string, unknown> | undefined) ?? {} };
  });
}

/** Map with bounded concurrency. `fn` never throws (dispatch is the firewall). */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export async function runBatch(rawArgs: unknown, deps: BatchDeps): Promise<CallToolResult> {
  const a = asArgs(rawArgs);
  const ops = parseOps(a.ops);

  const mode = (optionalString(a, 'mode') ?? 'parallel') as Mode;
  if (mode !== 'parallel' && mode !== 'serial') {
    throw new McpToolError('"mode" must be "parallel" or "serial"');
  }
  const stopOnError = optionalBoolean(a, 'stopOnError') ?? false;
  const concurrency = optionalNumber(a, 'maxConcurrency', { min: 1, max: MAX_CONCURRENCY }) ?? DEFAULT_CONCURRENCY;

  /** Run one op through the firewall, after the per-op guards. Never throws. */
  const runOne = async (op: BatchOp): Promise<CallToolResult> => {
    if (op.tool === 'batch') return errorResult('batch cannot be nested inside batch');
    if (mode === 'parallel' && deps.requiresExplicitTab(op.tool) && op.args.tabId == null) {
      return errorResult(
        `"${op.tool}" needs an explicit "tabId" in a parallel batch — the active-tab default is unsafe under concurrency (use serial mode, or pass tabId)`,
      );
    }
    // In a parallel batch, default new tabs to the background so N concurrent
    // opens don't fight over window focus (a single tab_new still focuses).
    let args = op.args;
    if (mode === 'parallel' && op.tool === 'tab_new' && args.active === undefined) {
      args = { ...args, active: false };
    }
    return deps.dispatch(op.tool, args);
  };

  let outcomes: OpOutcome[];
  if (mode === 'serial') {
    outcomes = ops.map(() => ({ status: 'skipped' as OpStatus }));
    for (let i = 0; i < ops.length; i++) {
      const result = await runOne(ops[i]);
      outcomes[i] = { status: result.isError ? 'error' : 'ok', result };
      if (stopOnError && result.isError) break; // leave the rest 'skipped'
    }
  } else {
    const results = await mapLimit(ops, concurrency, (op) => runOne(op));
    outcomes = results.map((result) => ({ status: result.isError ? 'error' : 'ok', result }));
  }

  return renderBatch(ops, outcomes, mode);
}

/** Compose the per-op outcomes into one MCP result: a JSON summary block first,
 *  then each executed op's own content blocks (text/images flow through intact). */
function renderBatch(ops: BatchOp[], outcomes: OpOutcome[], mode: Mode): CallToolResult {
  const summary = outcomes.map((o, i) => ({ index: i, tool: ops[i].tool, status: o.status }));
  const counts = {
    total: ops.length,
    ok: summary.filter((s) => s.status === 'ok').length,
    error: summary.filter((s) => s.status === 'error').length,
    skipped: summary.filter((s) => s.status === 'skipped').length,
  };

  const content: CallToolResult['content'] = [
    { type: 'text', text: JSON.stringify({ batch: { mode, ...counts }, results: summary }, null, 2) },
  ];
  for (let i = 0; i < outcomes.length; i++) {
    const o = outcomes[i];
    if (!o.result) continue; // skipped ops carry no payload
    content.push({ type: 'text', text: `--- op ${i} (${ops[i].tool}) ${o.status} ---` });
    for (const block of o.result.content) content.push(block);
  }

  // The batch ran successfully even if some ops failed; only flag isError when
  // nothing succeeded, so a host sees partial success as success.
  const isError = ops.length > 0 && counts.ok === 0;
  return isError ? { content, isError: true } : { content };
}
