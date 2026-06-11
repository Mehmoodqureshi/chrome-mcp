/**
 * src/mcp/validators.ts — lightweight, dependency-free runtime guards for tool
 * arguments. The JSON Schema in `tools.ts` is the advertised contract; these
 * guards defend each handler from malformed input and throw `McpToolError` with
 * an actionable message (rendered as a structured `isError` result upstream).
 */

import type { Target } from '../executor/types';

/**
 * Thrown when a tool request can't be fulfilled for a caller-actionable reason
 * (bad args, exactly-one-of violation, …). The dispatch firewall converts it to
 * an `isError` result, so it never tears down the transport.
 */
export class McpToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpToolError';
  }
}

/** Coerce raw tool args into a plain object, rejecting non-objects. */
export function asArgs(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new McpToolError('tool arguments must be a JSON object');
  }
  return raw as Record<string, unknown>;
}

export function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new McpToolError(`"${key}" is required and must be a non-empty string`);
  }
  return v;
}

export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw new McpToolError(`"${key}" must be a string`);
  return v;
}

export function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') throw new McpToolError(`"${key}" must be a boolean`);
  return v;
}

export function optionalNumber(
  args: Record<string, unknown>,
  key: string,
  bounds?: { min?: number; max?: number },
): number | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new McpToolError(`"${key}" must be a finite number`);
  }
  if (bounds?.min !== undefined && v < bounds.min) throw new McpToolError(`"${key}" must be >= ${bounds.min}`);
  if (bounds?.max !== undefined && v > bounds.max) throw new McpToolError(`"${key}" must be <= ${bounds.max}`);
  return v;
}

export function optionalStringArray(args: Record<string, unknown>, key: string): string[] | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw new McpToolError(`"${key}" must be an array of strings`);
  }
  return v as string[];
}

/**
 * Require EXACTLY ONE of `selector` | `ref`. Returns a normalized `Target`.
 * Both-present and neither-present are both errors — the contract is one-of.
 */
export function requireTarget(args: Record<string, unknown>): Target {
  const hasSel = typeof args.selector === 'string' && (args.selector as string).length > 0;
  const hasRef = typeof args.ref === 'string' && (args.ref as string).length > 0;
  if (hasSel === hasRef) {
    throw new McpToolError('provide exactly one of "selector" or "ref"');
  }
  return hasSel ? { selector: args.selector as string } : { ref: args.ref as string };
}

/** Like `requireTarget` but the target is optional (whole-page reads). */
export function optionalTarget(args: Record<string, unknown>): Target | undefined {
  const hasSel = typeof args.selector === 'string' && (args.selector as string).length > 0;
  const hasRef = typeof args.ref === 'string' && (args.ref as string).length > 0;
  if (!hasSel && !hasRef) return undefined;
  return requireTarget(args);
}
