/**
 * src/mcp/limits.ts — output size caps for the page-read tools.
 *
 * `eval` has been capped at 256 KB since 0.1 (MAX_EVAL_BYTES) and `screenshot`
 * reports `truncated` with the real height, but the three tools that read page
 * CONTENT — get_html, get_text, read_as_markdown — were unbounded. A single
 * `get_html` on an ordinary content-heavy page can be several megabytes, which is
 * enough to consume an agent's entire context window in one call, and the caller
 * has no way to ask for less.
 *
 * The cap is applied server-side, after the read: the full payload is still
 * written to the task's `results/` directory by the handlers that save artifacts,
 * so nothing is lost on disk — only what crosses into the model's context is
 * bounded.
 */

/** Default cap on a single content read, matching the long-standing eval cap. */
export const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;

/** Floor/ceiling for a caller-supplied `maxBytes`. */
export const MIN_OUTPUT_BYTES = 1024;
export const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export interface Truncation {
  /** The (possibly shortened) text. */
  text: string;
  /** True when `text` is shorter than the input. */
  truncated: boolean;
  /** UTF-8 byte length of the ORIGINAL text. */
  totalBytes: number;
  /** UTF-8 byte length of `text`. */
  returnedBytes: number;
}

/**
 * Cut `text` to at most `maxBytes` UTF-8 bytes.
 *
 * `Buffer.subarray` slices bytes, which can land mid-codepoint; decoding back to
 * a string would leave a replacement character at the seam. So the slice is taken
 * and then trimmed back to the last complete character.
 */
function sliceUtf8(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.byteLength <= maxBytes) return text;
  let end = maxBytes;
  // A UTF-8 continuation byte is 10xxxxxx; walk back off the middle of a
  // multi-byte sequence so the decode is clean.
  while (end > 0 && (buf[end] & 0b1100_0000) === 0b1000_0000) end--;
  return buf.subarray(0, end).toString('utf8');
}

/** Truncate plain text (or markdown) to a byte budget. */
export function capText(text: string, maxBytes: number = DEFAULT_MAX_OUTPUT_BYTES): Truncation {
  const totalBytes = Buffer.byteLength(text, 'utf8');
  if (totalBytes <= maxBytes) {
    return { text, truncated: false, totalBytes, returnedBytes: totalBytes };
  }
  const cut = sliceUtf8(text, maxBytes);
  return { text: cut, truncated: true, totalBytes, returnedBytes: Buffer.byteLength(cut, 'utf8') };
}

/**
 * Truncate HTML to a byte budget, backing up to the last tag boundary.
 *
 * Cutting mid-tag (`<div class="fo`) hands the caller markup that no parser will
 * accept and that an LLM will happily hallucinate the rest of. Ending on a `>`
 * keeps every returned tag complete — the document is still truncated, but every
 * element in it is well-formed up to the cut.
 */
export function capHtml(html: string, maxBytes: number = DEFAULT_MAX_OUTPUT_BYTES): Truncation {
  const capped = capText(html, maxBytes);
  if (!capped.truncated) return capped;
  const lastClose = capped.text.lastIndexOf('>');
  // Only back up when a boundary exists reasonably near the cut; a single
  // enormous text node has no tag to align to and is better returned as-is.
  if (lastClose > 0) {
    const aligned = capped.text.slice(0, lastClose + 1);
    return { ...capped, text: aligned, returnedBytes: Buffer.byteLength(aligned, 'utf8') };
  }
  return capped;
}

/** The metadata fields appended to a truncated read's envelope. */
export function truncationMeta(t: Truncation): Record<string, unknown> {
  if (!t.truncated) return {};
  return {
    truncated: true,
    totalBytes: t.totalBytes,
    returnedBytes: t.returnedBytes,
    truncationNote:
      `output capped at ${t.returnedBytes} of ${t.totalBytes} bytes; ` +
      'raise `maxBytes` for more, or narrow the read with `selector`',
  };
}
