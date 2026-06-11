/**
 * src/mcp/envelopes.ts — serialize handler results into the MCP `content`
 * envelope. One place so every tool returns a consistent shape.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** A JSON payload rendered as pretty text (the default for structured results). */
export function jsonResult(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

/** A plain text payload (e.g. read_as_markdown). */
export function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

/** A base64 image, optionally with a caption line. */
export function imageResult(dataBase64: string, mimeType: string, caption?: string): CallToolResult {
  const content: CallToolResult['content'] = [{ type: 'image', data: dataBase64, mimeType }];
  if (caption) content.push({ type: 'text', text: caption });
  return { content };
}

/** A structured error result — never throws; sets `isError` for the host. */
export function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}
