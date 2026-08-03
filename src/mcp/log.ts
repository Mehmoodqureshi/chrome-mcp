/**
 * src/mcp/log.ts — stderr diagnostics, gated by `--log-level`.
 *
 * Lives apart from `server.ts` so the tool layer can log without importing the
 * server module that imports it back. CRITICAL: in stdio mode NOTHING may be
 * written to stdout except the JSON-RPC stream, so every diagnostic here goes to
 * stderr.
 */

import type { LogLevel } from '../config';

/**
 * Active verbosity, set once from `--log-level` at startup.
 *
 * `silent` suppresses stderr entirely — an editor MCP config that asked for it
 * was getting the noise anyway, because the parsed flag was never consumed.
 * `debug` turns on the wire tracing that `logDebug` guards.
 */
let logLevel: LogLevel = 'info';

/** Apply the CLI's `--log-level`. Call before anything else logs. */
export function setLogLevel(level: LogLevel): void {
  logLevel = level;
}

/** The level currently in force (for tests, and for callers gating expensive tracing). */
export function getLogLevel(): LogLevel {
  return logLevel;
}

/** stderr only — never stdout in stdio mode. Suppressed at `--log-level silent`. */
export function logErr(message: string): void {
  if (logLevel === 'silent') return;
  process.stderr.write(`[chrome-mcp] ${message}\n`);
}

/** Verbose tracing: emitted only at `--log-level debug`. */
export function logDebug(message: string): void {
  if (logLevel !== 'debug') return;
  process.stderr.write(`[chrome-mcp] [debug] ${message}\n`);
}
