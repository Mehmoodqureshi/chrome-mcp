/**
 * src/mcp/redact.ts — keep secrets that happen to be on the page out of the
 * model's context.
 *
 * The premise of this tool is that it drives a browser you are already logged
 * into. That is also the problem: `get_text` / `get_html` / `read_as_markdown` /
 * `eval` return whatever is on the page, and on a logged-in page that routinely
 * includes a session token rendered into a script tag, an API key on a settings
 * screen, or the value sitting in a password field. The domain allowlist decides
 * WHICH pages may be read; it has nothing to say about what comes back from one
 * that is allowed.
 *
 * Two layers, deliberately different in strength:
 *   - password-field values are ALWAYS suppressed. That one is unambiguous — no
 *     caller ever wants the characters in a `<input type=password>` — so it
 *     needs no flag and has no false positives.
 *   - pattern redaction (JWTs, cloud keys, bearer tokens, private key blocks) is
 *     opt-in via `--redact`, because a pattern can and will fire on something a
 *     user legitimately asked to read.
 */

export interface RedactionConfig {
  /** Pattern-based redaction (the opt-in layer). Password fields are handled regardless. */
  enabled: boolean;
  /** Extra caller-supplied patterns, already compiled. */
  extra: RegExp[];
}

export const NO_REDACTION: RedactionConfig = { enabled: false, extra: [] };

/** Well-known secret shapes. Each is anchored enough not to fire on prose. */
const BUILTIN: Array<{ kind: string; re: RegExp }> = [
  { kind: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]{0,8000}?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { kind: 'aws-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  { kind: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'api-key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}/g },
];

/**
 * Compile a user-supplied pattern. Invalid regexes are a configuration error
 * worth failing loudly on — silently ignoring one would leave the user believing
 * a secret is being scrubbed when it is not.
 */
export function compileRedactionPattern(source: string): RegExp {
  return new RegExp(source, 'g');
}

export interface Redacted<T> {
  value: T;
  /** How many substitutions were made, so a caller can see redaction happened. */
  redactions: number;
}

/** Replace every match of the configured patterns with a labelled marker. */
export function redactText(text: string, cfg: RedactionConfig): Redacted<string> {
  if (!cfg.enabled || !text) return { value: text, redactions: 0 };
  let out = text;
  let count = 0;
  for (const { kind, re } of BUILTIN) {
    out = out.replace(new RegExp(re.source, re.flags), () => {
      count++;
      return `[redacted:${kind}]`;
    });
  }
  for (const re of cfg.extra) {
    out = out.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`), () => {
      count++;
      return '[redacted:custom]';
    });
  }
  return { value: out, redactions: count };
}

/** Matches one complete `<input …>` tag so its attributes can be inspected. */
const INPUT_TAG = /<input\b[^>]*>/gi;
const VALUE_ATTR = /\bvalue\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i;
const PASSWORD_TYPE = /\btype\s*=\s*["']?password["']?/i;

/**
 * Strip the `value` of every password input, then apply pattern redaction.
 *
 * The value attribute is emptied rather than removed so the markup keeps its
 * shape — a caller reasoning about the form still sees the field, just not
 * what is in it.
 */
export function redactHtml(html: string, cfg: RedactionConfig): Redacted<string> {
  if (!html) return { value: html, redactions: 0 };
  let count = 0;
  let out = html.replace(INPUT_TAG, (tag) => {
    if (!PASSWORD_TYPE.test(tag) || !VALUE_ATTR.test(tag)) return tag;
    count++;
    return tag.replace(VALUE_ATTR, 'value="[redacted:password]"');
  });
  const patterned = redactText(out, cfg);
  out = patterned.value;
  return { value: out, redactions: count + patterned.redactions };
}
