/**
 * src/mcp/audit.ts — per-call context so the action log can record WHICH page a
 * call touched and what the policy decided about it.
 *
 * `history.jsonl` already records tool + args + ok. For a tool that drives a
 * real, logged-in browser, the question people actually ask afterwards is "what
 * did it touch, and what was it allowed to touch" — and the target URL, the
 * policy verdict, and the size of what came back were all missing from the
 * record. They are known inside the call and nowhere after it.
 *
 * `AsyncLocalStorage` rather than a module-level variable because `batch` runs
 * ops CONCURRENTLY: one shared slot would attribute one op's URL to another's
 * log line, which is worse than not logging it at all.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface CallAudit {
  /** The URL the policy gate was evaluated against, once one is resolved. */
  url?: string;
  /** Set when the gate denied the call. */
  denied?: boolean;
  /** Bytes of content this call returned to the caller (post-cap). */
  bytes?: number;
  /** How many secrets the redaction pass replaced. */
  redactions?: number;
  /** Frame the call actually acted on, when it was not the top frame. */
  frameId?: number;
}

const storage = new AsyncLocalStorage<CallAudit>();

/** Run `fn` with a fresh audit record, and hand that record back. */
export async function withAudit<T>(fn: (audit: CallAudit) => Promise<T>): Promise<{ result: T; audit: CallAudit }> {
  const audit: CallAudit = {};
  const result = await storage.run(audit, () => fn(audit));
  return { result, audit };
}

/** The current call's audit record, or undefined outside a dispatch. */
export function currentAudit(): CallAudit | undefined {
  return storage.getStore();
}

/** Record the policy decision for this call. Safe to call outside a dispatch. */
export function noteGate(url: string, allowed: boolean): void {
  const a = storage.getStore();
  if (!a) return;
  if (url) a.url = url;
  if (!allowed) a.denied = true;
}

/** Record how much content crossed back to the caller. */
export function noteBytes(bytes: number): void {
  const a = storage.getStore();
  if (!a) return;
  a.bytes = (a.bytes ?? 0) + bytes;
}

/** Record how many secrets were scrubbed on the way out. */
export function noteRedactions(count: number): void {
  if (count <= 0) return;
  const a = storage.getStore();
  if (!a) return;
  a.redactions = (a.redactions ?? 0) + count;
}
