/**
 * src/mcp/tools.ts — the MCP tool surface: the advertised catalog
 * (`TOOL_DEFINITIONS`, each with a zod `inputSchema`), the name→handler dispatch
 * (`TOOL_HANDLERS`), the never-throw firewall (`dispatchToolCall`), and
 * `registerTools()` which registers every tool on an `McpServer` via
 * `registerTool` — the SDK validates the zod schema before dispatch runs.
 *
 * Each handler: validate args → **policy-gate against the relevant URL** → call
 * the active Executor (or a server-side helper) → serialize via an envelope.
 * Nothing here throws to the transport: `dispatchToolCall` renders any thrown
 * `Error` as an `isError` result.
 */

import { resolve as pathResolve, sep } from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import type { WireMethod } from '../../shared/protocol';
import type { DialogPolicy, Executor, FrameOpts, TabInfo, Target, WaitUntil } from '../executor/types';
import { ExecutorError } from '../executor/types';
import { getManager } from '../executor/manager';
import { assertUrlAllowed, isUrlGated, type Policy } from '../security/policy';
import { errorResult, imageResult, jsonResult, textResult } from './envelopes';
import {
  capHtml,
  capText,
  DEFAULT_MAX_OUTPUT_BYTES,
  MAX_OUTPUT_BYTES,
  MIN_OUTPUT_BYTES,
  truncationMeta,
} from './limits';
import { runBatch } from './batch';
import { extractLinks, fillForm, readAsMarkdown } from './helpers';
import { compileRedactionPattern, NO_REDACTION, redactHtml, redactText, type RedactionConfig } from './redact';
import { resolveLocator, hasLocator, type Locator } from './locate';
import { diffSnapshots, lastSnapshot, rememberSnapshot, resetSnapshots, scopeOf } from './snapdiff';
import { describeAuthWall, detectAuthWall, type AuthWall } from '../../shared/auth-wall';
import { noteBytes, noteGate, noteRedactions, withAudit, type CallAudit } from './audit';
import { logDebug, logErr } from './log';
import { listTasks } from '../bridge/tasks';
import {
  appendHistory,
  getActiveWorkspace,
  peekActiveWorkspace,
  saveBinary,
  saveResult,
  saveScreenshot,
  switchWorkspace,
} from '../bridge/workspace';
import {
  asArgs,
  MAX_TEXT_LEN,
  McpToolError,
  optionalBoolean,
  optionalNumber,
  optionalString,
  optionalStringArray,
  optionalTarget,
  requireString,
  requireTarget,
  requireWithinLength,
} from './validators';

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export interface ToolDefinition {
  name: string;
  description: string;
  /** zod raw shape passed to `McpServer.registerTool`; the SDK validates it before dispatch. */
  inputSchema: z.ZodRawShape;
}

/**
 * Element targeting, defined ONCE and spread whole by every tool that acts on
 * an element. `TARGET_PROPS` is the plain selector|ref pair (for tools whose
 * handler resolves a node and nothing else); `LOCATOR_PROPS` is the full block
 * — selector | ref | role+name, in any frame — and is what click/type/hover/
 * select_option spread as a single object.
 *
 * Keeping the block in one place is also what keeps `tools/list` cheap: these
 * seven fields repeat across a dozen tools, so every byte of prose here is paid
 * a dozen times on EVERY turn. Detail an agent does not need on every call
 * belongs in the owning tool's description (`frames_list`, `auth_check`) or the
 * README, not here.
 *
 * A handler that needs a target calls `requireTarget`; ambiguity fails loudly
 * rather than acting on the wrong element.
 */
const TARGET_PROPS = {
  selector: z.string().describe('CSS selector (or pass ref)').optional(),
  ref: z.string().describe('Element ref from a snapshot').optional(),
} as const;

/**
 * Frame targeting. Omitted = the top frame. `allFrames` is the one to reach for
 * when a selector "should" match but does not — the element is almost always
 * inside an iframe. Every frame is authorized against its own URL, so a scan
 * never reaches a site the allowlist does not cover.
 */
const FRAME_PROPS = {
  frameId: z.number().describe('Frame id from frames_list').optional(),
  allFrames: z.boolean().describe('Act on the first match in ANY frame (the element may be in an iframe)').optional(),
} as const;

/**
 * The full locator block. role+name targets an element the way a person reads
 * the page, so an action needs no snapshot first; resolution is server-side.
 */
const LOCATOR_PROPS = {
  ...TARGET_PROPS,
  // These tools take role+name too, so their `selector` says so; the tools that
  // only resolve a node keep the plain TARGET_PROPS wording.
  selector: z.string().describe('CSS selector (or ref, or role+name)').optional(),
  role: z.string().describe('ARIA role, e.g. button|link|textbox (pair with name)').optional(),
  name: z.string().describe('Accessible name / visible label (pair with role)').optional(),
  nth: z.number().describe('0-based index when role+name is ambiguous').optional(),
  ...FRAME_PROPS,
} as const;

const tabIdField = z.string().describe('Tab id (default: active tab)').optional();
const authWallField = z.boolean().describe('Error with [AUTH_REQUIRED] if this lands on a sign-in wall (expired session)').optional();

const snapshotAfterField = z
  .boolean()
  .describe('Return what CHANGED on the page after this action instead of making you re-read it')
  .optional();
const maxBytesField = z
  .number()
  .describe(`Cap returned content at N UTF-8 bytes (default ${DEFAULT_MAX_OUTPUT_BYTES}); the full payload still lands in results/`)
  .optional();
const waitUntilField = z.enum(['load', 'domcontentloaded', 'networkidle']).describe('When to consider navigation done').optional();

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  { name: 'tabs_list', description: 'List open browser tabs.', inputSchema: {} },
  { name: 'tab_select', description: 'Make a tab active by tabId.', inputSchema: { tabId: z.string() } },
  { name: 'tab_new', description: 'Open a NEW tab (optionally at a URL) and focus it. Prefer this over `navigate` when the user says "open"/"go to" a site — `navigate` REPLACES the current tab. Pass active:false to open in the background (used by parallel batches).', inputSchema: { url: z.string().optional(), active: z.boolean().optional() } },
  { name: 'tab_close', description: 'Close a tab by tabId.', inputSchema: { tabId: z.string() } },

  { name: 'navigate', description: 'Navigate a tab to a URL, REPLACING its current page. Acts on the active tab unless tabId is given — to open a site without losing the current page, use `tab_new` instead.', inputSchema: { url: z.string(), tabId: tabIdField, waitUntil: waitUntilField, failOnAuthWall: authWallField } },
  { name: 'back', description: 'Go back in history.', inputSchema: { tabId: tabIdField, failOnAuthWall: authWallField } },
  { name: 'forward', description: 'Go forward in history.', inputSchema: { tabId: tabIdField, failOnAuthWall: authWallField } },
  { name: 'reload', description: 'Reload the active (or given) tab.', inputSchema: { tabId: tabIdField, waitUntil: waitUntilField, failOnAuthWall: authWallField } },

  { name: 'click', description: 'Click an element. Target by selector, a snapshot ref, or role+name (e.g. role:"button", name:"Sign in") - the locator needs no snapshot first. trusted=true uses real OS-level input.', inputSchema: { ...LOCATOR_PROPS, tabId: tabIdField, button: z.enum(['left', 'right', 'middle']).optional(), clickCount: z.number().optional(), trusted: z.boolean().optional(), snapshotAfter: snapshotAfterField, failOnAuthWall: authWallField } },
  { name: 'type', description: 'Type text into an element (target by selector, ref, or role+name). trusted=true sends real keystrokes (works on React/Vue controlled inputs).', inputSchema: { ...LOCATOR_PROPS, text: z.string(), tabId: tabIdField, clear: z.boolean().optional(), pressEnter: z.boolean().optional(), keyEvents: z.boolean().optional(), trusted: z.boolean().optional(), snapshotAfter: snapshotAfterField, failOnAuthWall: authWallField } },
  { name: 'select_option', description: 'Select option(s) of a <select> by value or visible label.', inputSchema: { ...LOCATOR_PROPS, values: z.array(z.string()), tabId: tabIdField, snapshotAfter: snapshotAfterField, failOnAuthWall: authWallField } },
  { name: 'press', description: 'Press a key (with optional modifiers).', inputSchema: { key: z.string(), modifiers: z.array(z.string()).optional(), tabId: tabIdField, failOnAuthWall: authWallField } },
  { name: 'hover', description: 'Hover over an element.', inputSchema: { ...LOCATOR_PROPS, tabId: tabIdField, snapshotAfter: snapshotAfterField } },
  { name: 'scroll', description: 'Scroll the page or to an element.', inputSchema: { ...TARGET_PROPS, ...FRAME_PROPS, x: z.number().optional(), y: z.number().optional(), deltaX: z.number().optional(), deltaY: z.number().optional(), tabId: tabIdField } },

  { name: 'screenshot', description: 'Capture a screenshot (page or element). Default is JPEG (quality 70) at CSS-pixel size, which is several times smaller than PNG and reads fine. Pass format:"png" for lossless, quality 1-100 for JPEG, scale 2 for device pixels on a Retina display or 0.5 to shrink.', inputSchema: { ...TARGET_PROPS, ...FRAME_PROPS, fullPage: z.boolean().optional(), format: z.enum(['jpeg', 'png']).optional(), quality: z.number().optional(), scale: z.number().optional(), tabId: tabIdField } },
  { name: 'get_text', description: 'Get visible text of the page or an element.', inputSchema: { ...TARGET_PROPS, ...FRAME_PROPS, tabId: tabIdField, maxBytes: maxBytesField } },
  { name: 'get_html', description: 'Get HTML of the page or an element. Output is capped (see maxBytes) and cut at a tag boundary; narrow it with `selector` rather than raising the cap when you can. Password field values are always blanked.', inputSchema: { ...TARGET_PROPS, ...FRAME_PROPS, outer: z.boolean().optional(), tabId: tabIdField, maxBytes: maxBytesField } },
  { name: 'snapshot', description: 'Accessibility snapshot: interactive elements with refs to target by `ref` (more reliable than guessing CSS selectors). Pass diff:true to get only what changed since the last snapshot of this tab - far cheaper in a click/read loop. Password fields appear as secret:true with no value.', inputSchema: { interactiveOnly: z.boolean().optional(), max: z.number().optional(), diff: z.boolean().describe('Return added/removed/changed elements since the previous snapshot of this tab instead of the whole tree').optional(), failOnAuthWall: authWallField, ...FRAME_PROPS, tabId: tabIdField } },
  { name: 'get_cookies', description: "Read cookies visible to the tab's URL (or a given url).", inputSchema: { url: z.string().optional(), tabId: tabIdField } },
  { name: 'storage', description: 'Read/write localStorage (or sessionStorage). op: get|set|remove|clear.', inputSchema: { op: z.enum(['get', 'set', 'remove', 'clear']), key: z.string().optional(), value: z.string().optional(), session: z.boolean().optional(), tabId: tabIdField } },
  { name: 'eval', description: 'Evaluate JavaScript in the page (disabled in safe-mode).', inputSchema: { expression: z.string(), awaitPromise: z.boolean().optional(), ...FRAME_PROPS, tabId: tabIdField } },
  { name: 'wait_for', description: 'Wait for a selector or text to appear/disappear.', inputSchema: { selector: z.string().optional(), textContains: z.string().optional(), gone: z.boolean().optional(), timeoutMs: z.number().optional(), ...FRAME_PROPS, tabId: tabIdField, failOnAuthWall: authWallField } },

  { name: 'extract_links', description: 'Extract anchors from the page or a subtree. dedupe=true collapses links sharing an href (nav/footer noise); limit caps the count.', inputSchema: { selector: z.string().optional(), sameOriginOnly: z.boolean().optional(), dedupe: z.boolean().optional(), limit: z.number().optional(), ...FRAME_PROPS, tabId: tabIdField } },
  { name: 'read_as_markdown', description: 'Read the page (or subtree) as readable markdown.', inputSchema: { selector: z.string().optional(), ...FRAME_PROPS, tabId: tabIdField, maxBytes: maxBytesField } },
  { name: 'fill_form', description: 'Fill multiple fields (keyed by selector) and optionally submit.', inputSchema: { fields: z.record(z.string(), z.union([z.string(), z.boolean()])), submitSelector: z.string().optional(), ...FRAME_PROPS, tabId: tabIdField, failOnAuthWall: authWallField } },
  { name: 'download_file', description: 'Download a file by URL or from a link element.', inputSchema: { url: z.string().optional(), ...TARGET_PROPS, suggestedName: z.string().optional(), tabId: tabIdField } },
  { name: 'upload_file', description: 'Set local file(s) on a file <input> (target by selector or ref) — uploads without the OS dialog. Requires --enable-uploads. `files` are absolute local paths.', inputSchema: { ...TARGET_PROPS, files: z.array(z.string()), tabId: tabIdField } },

  {
    name: 'frames_list',
    description:
      "List the tab's frames (the top document plus every iframe the extension can reach), with each frame's id and URL. Use it when a selector that should match does not: the element is probably in one of these frames, and you can then pass frameId (or allFrames:true) to act inside it.",
    inputSchema: { tabId: tabIdField },
  },
  {
    name: 'console_logs',
    description:
      'Console output and uncaught errors recorded on the page (requires --enable-observers). This is how you find out WHY a page misbehaved rather than only what it looks like afterwards. Pass sinceSeq to poll for what is new, clear:true to drain.',
    inputSchema: {
      level: z.enum(['log', 'info', 'warn', 'error', 'debug', 'exception']).describe('Only entries at this level').optional(),
      ...FRAME_PROPS,
      sinceSeq: z.number().describe('Only entries newer than this seq (from a previous call)').optional(),
      limit: z.number().describe('Max entries to return (default 200)').optional(),
      clear: z.boolean().describe('Empty the buffer after reading').optional(),
      tabId: tabIdField,
    },
  },
  {
    name: 'network_log',
    description:
      "Requests the page made - fetch and XMLHttpRequest with method, URL, status and duration (requires --enable-observers). Set includeResources:true to also list scripts/images/styles from Resource Timing (those carry timing and size but no status). Does not include the document request or headers.",
    inputSchema: {
      urlContains: z.string().describe('Only requests whose URL contains this substring').optional(),
      ...FRAME_PROPS,
      failedOnly: z.boolean().describe('Only requests that errored or returned status >= 400').optional(),
      includeResources: z.boolean().describe('Also include Resource Timing entries (scripts, images, styles)').optional(),
      sinceSeq: z.number().optional(),
      limit: z.number().optional(),
      clear: z.boolean().optional(),
      tabId: tabIdField,
    },
  },
  {
    name: 'dialogs',
    description:
      "Native dialogs (alert/confirm/prompt/beforeunload) the page raised, and how they were answered (requires --enable-observers). With observers on, dialogs are intercepted rather than left to block the renderer - which is what otherwise turns a click that opens a confirm() into a mystery TIMEOUT. Set policy:'accept' to answer confirms with true.",
    inputSchema: {
      policy: z.enum(['dismiss', 'accept']).describe("How to answer future dialogs (default dismiss: confirm->false, prompt->null)").optional(),
      ...FRAME_PROPS,
      promptText: z.string().describe("Text to answer prompt() with when policy is 'accept'").optional(),
      sinceSeq: z.number().optional(),
      limit: z.number().optional(),
      clear: z.boolean().optional(),
      tabId: tabIdField,
    },
  },
  {
    name: 'print_pdf',
    description:
      "Render the page to PDF through Chrome's own print pipeline and save it to the task's results/ dir. Returns the path and size, not the bytes - a PDF is not something to spend context on.",
    inputSchema: {
      landscape: z.boolean().optional(),
      printBackground: z.boolean().describe('Include background graphics (default true)').optional(),
      scale: z.number().describe('0.1 - 2.0').optional(),
      paperWidth: z.number().describe('Inches').optional(),
      paperHeight: z.number().describe('Inches').optional(),
      pageRanges: z.string().describe("e.g. '1-3, 5'").optional(),
      preferCSSPageSize: z.boolean().optional(),
      tabId: tabIdField,
    },
  },

  { name: 'chrome_status', description: 'Report backend/session status.', inputSchema: {} },
  { name: 'auth_check', description: 'Is the tab sitting on a sign-in wall? Reads the page (URL, title, password fields, sign-in controls) and returns { authRequired, confidence, signals }. Use it after a navigate, or whenever a step fails unexpectedly, to tell "the session expired" apart from "the agent got lost". Pass failOnAuthWall:true to get an [AUTH_REQUIRED] error instead of a verdict, so a harness can bucket the run as an auth failure.', inputSchema: { failOnAuthWall: authWallField, ...FRAME_PROPS, tabId: tabIdField } },

  { name: 'profile_use', description: 'Switch the active browser profile (identity). Subsequent downloads, results, screenshots, and the action log are stored under profiles/<name>/. Resets the active task to "default" unless you then call task_new.', inputSchema: { name: z.string().describe('Profile name (becomes a folder; sanitized to a safe path segment).') } },
  { name: 'task_new', description: 'Start a new task (run) under the active profile. Creates profiles/<profile>/tasks/<name>/ with downloads/, results/, screenshots/ and makes it the active task so all captured artifacts land there.', inputSchema: { name: z.string().describe('Task name (becomes a folder; sanitized to a safe path segment).') } },
  { name: 'tasks_list', description: 'List every task across all profiles under the data dir, with sizes and download counts.', inputSchema: {} },
  { name: 'task_status', description: 'Report the active profile/task and the folder paths where this run\'s artifacts are stored.', inputSchema: {} },

  {
    name: 'batch',
    description:
      'Run multiple tool calls in one request — parallel (default) or serial. Each op is { tool, args } and goes through the same policy gate, rate limit, and error handling as a direct call. In parallel mode, tab-scoped ops MUST pass an explicit tabId (the active-tab default is unsafe under concurrency). Use to drive several tabs at once (e.g. open tabs, then batch get_text across them). Cannot be nested.',
    inputSchema: {
      ops: z
        .array(z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()).optional() }))
        .describe('Operations to run; each is a tool name + its args.'),
      mode: z.enum(['parallel', 'serial']).describe('Default "parallel".').optional(),
      stopOnError: z.boolean().describe('Serial mode only: stop after the first failing op (the rest are skipped).').optional(),
      maxConcurrency: z.number().describe('Parallel mode: max ops in flight at once (default 6).').optional(),
      maxResultBytes: z.number().describe('Total payload budget across all ops (default 1048576). Ops past the budget are replaced by a one-line summary instead of their content, so a 50-op screenshot/get_html batch cannot flood the caller.').optional(),
    },
  },
];

// ---------------------------------------------------------------------------
// Tool allowlist (--tools)
// ---------------------------------------------------------------------------

/** Every advertised tool name, in catalog order. */
export const TOOL_NAMES: readonly string[] = TOOL_DEFINITIONS.map((d) => d.name);

/** `null` = the whole catalog (the default). */
let toolAllowlist: Set<string> | null = null;

/**
 * Restrict the tool surface to `names` (`--tools`). The catalog is the single
 * largest fixed cost of having this server connected: every tool's JSON Schema
 * is re-sent to the model on EVERY turn. A run that only reads pages has no use
 * for uploads, PDFs or task management, and should not pay for their schemas.
 *
 * Excluded tools are neither advertised in `tools/list` nor callable — a
 * `batch` op naming one is refused exactly like an unknown tool, so hiding a
 * tool is a real restriction and not just a display filter.
 *
 * Passing `null`/`undefined`/`[]` restores the full catalog. Unknown names
 * throw rather than being ignored: a typo that silently drops `click` from the
 * surface is far more expensive to debug than a startup error.
 */
export function setToolAllowlist(names: readonly string[] | null | undefined): void {
  if (!names || names.length === 0) {
    toolAllowlist = null;
    return;
  }
  const known = new Set(TOOL_NAMES);
  const unknown = names.filter((n) => !known.has(n));
  if (unknown.length > 0) {
    throw new Error(
      `--tools: unknown tool ${unknown.map((n) => JSON.stringify(n)).join(', ')}. ` +
        `Known tools: ${TOOL_NAMES.join(', ')}`,
    );
  }
  toolAllowlist = new Set(names);
}

/** Is `name` on the surface? True for every catalog tool when no allowlist is set. */
export function isToolEnabled(name: string): boolean {
  return toolAllowlist === null || toolAllowlist.has(name);
}

/** The names actually advertised, in catalog order. */
export function enabledToolNames(): readonly string[] {
  return TOOL_NAMES.filter(isToolEnabled);
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

interface ToolCtx {
  ex: Executor;
  policy: Policy;
}

type ToolHandler = (args: Record<string, unknown>, ctx: ToolCtx) => Promise<CallToolResult>;

const GATE_CONTEXT = 'cannot resolve the target tab URL for the policy gate';

/**
 * Resolve the URL the policy should be evaluated against: the URL of the tab
 * this very call will act on — the explicit `tabId` when the caller gave one,
 * the active tab only when they didn't.
 *
 * Gating on the ACTIVE tab regardless of `tabId` is an authorization bypass:
 * park an allowlisted page as active and every `tabId`-addressed read (get_text,
 * get_html, screenshot, eval, …) sails through against a tab whose origin was
 * never checked. The tab that gets touched is the tab that must be authorized.
 *
 * NEVER substitutes a placeholder URL, and never falls back to some *other*
 * tab. If the real origin is unknown, evaluating the policy against a stand-in
 * would silently allow or deny against the wrong origin with no signal to the
 * caller. So a `tabsList` failure (or a browser reporting no tabs at all)
 * propagates — the dispatch firewall renders it as an error carrying the code.
 *
 * Prefers a URL the backend already reported over asking again: the extension
 * rides the tab's landing URL home on every result frame, which is what keeps a
 * gated call to ONE round-trip instead of two. The active-tab cache serves calls
 * without a `tabId`; the per-tab cache (fed by results for that tab and by any
 * `tabs_list`) serves explicitly-targeted ones, so a parallel batch over N tabs
 * gates on the one listing that opened it rather than N more.
 */
async function gatedUrl(ex: Executor, tabId?: string): Promise<string> {
  const known = tabId ? ex.cachedTabUrl?.(tabId) : ex.cachedActiveUrl?.();
  if (known) return known;

  let tabs: TabInfo[];
  try {
    tabs = await ex.tabsList();
  } catch (err) {
    // Keep the underlying code (TIMEOUT / EXTENSION_DISCONNECTED / …) so the
    // caller can tell a transient bridge failure from a policy decision — the
    // rendered message is prefixed with it, since only the text crosses MCP.
    if (err instanceof ExecutorError) throw new ExecutorError(err.code, `${GATE_CONTEXT}: ${err.message}`);
    throw err; // an internal fault, not a browser one — don't relabel it
  }

  if (tabs.length === 0) {
    throw new ExecutorError('TAB_NOT_FOUND', `${GATE_CONTEXT}: the browser reports no open tabs`);
  }
  const target = tabId ? tabs.find((t) => t.tabId === tabId) : tabs.find((t) => t.active);
  if (!target) {
    throw new ExecutorError(
      'TAB_NOT_FOUND',
      tabId
        ? `${GATE_CONTEXT}: no open tab has id ${tabId} — call tabs_list for the current ids`
        : `${GATE_CONTEXT}: the browser reports open tabs but none active — pass an explicit tabId`,
    );
  }
  // An empty URL is Chrome declining to reveal one (a chrome:// page, or a tab
  // the extension has no host access to) — NOT an origin. Gating on '' would
  // produce a baffling "blocked on " denial that reads like a policy decision.
  if (!target.url) {
    throw new ExecutorError(
      'TAB_NOT_FOUND',
      `${GATE_CONTEXT}: the target tab (id ${target.tabId}) reports no URL. Chrome hides it for ` +
        `internal pages (chrome://, the Web Store) and until the extension has access to that site — ` +
        `switch to a normal page, or open the target site in a new tab.`,
    );
  }
  return target.url;
}

/**
 * Policy chokepoint. `opts.url` is the destination for navigation (it governs
 * instead of any current tab URL); `opts.tabId` is the tab the call will act on,
 * and MUST be threaded through by every URL-gated handler that accepts one —
 * omitting it silently authorizes the call against the active tab instead.
 *
 * Only resolves a tab URL for methods whose verdict actually depends on one
 * (`isUrlGated`). Tab management and the capability gates — eval, downloads,
 * uploads, mutations — are decided without any URL, so making them wait on the
 * tab list bought nothing and, worse, made `tab_new` fail exactly when the tab
 * list was unreadable: the one call that could dig you out.
 */
async function gate(ctx: ToolCtx, method: WireMethod, opts: { url?: string; tabId?: string } = {}): Promise<void> {
  const url = opts.url ?? (isUrlGated(method) ? await gatedUrl(ctx.ex, opts.tabId) : '');
  try {
    assertUrlAllowed(url, method, ctx.policy);
  } catch (err) {
    noteGate(url, false);
    throw err;
  }
  noteGate(url, true);
}

const tabId = (args: Record<string, unknown>): string | undefined => optionalString(args, 'tabId');

/** Frame targeting pulled off the raw args. */
const frameOpts = (args: Record<string, unknown>): FrameOpts => ({
  frameId: optionalNumber(args, 'frameId', { min: 0 }),
  allFrames: optionalBoolean(args, 'allFrames'),
});

const locatorOf = (args: Record<string, unknown>): Locator => ({
  role: optionalString(args, 'role'),
  name: optionalString(args, 'name'),
  nth: optionalNumber(args, 'nth', { min: 0, max: 999 }),
});

/**
 * Resolve whatever the caller used to point at an element: a CSS selector, a
 * snapshot ref, or a role+name locator. Exactly one of the three — mixing them
 * is a mistake worth reporting rather than silently preferring one.
 */
async function resolveTargetArg(ctx: ToolCtx, a: Record<string, unknown>): Promise<Target> {
  const direct = optionalString(a, 'selector') !== undefined || optionalString(a, 'ref') !== undefined;
  const loc = locatorOf(a);
  if (direct && hasLocator(loc)) {
    throw new McpToolError('give exactly one of selector | ref | role+name — not several at once');
  }
  if (!direct && hasLocator(loc)) {
    const found = await resolveLocator(ctx.ex, loc, { tabId: tabId(a), ...frameOpts(a) });
    return found.target;
  }
  // No locator: keep the original exactly-one-of validation and its message.
  return requireTarget(a);
}

/** Re-parse a redacted JSON string, falling back to the string when the
 *  substitution broke its syntax (a marker inside a string literal never does,
 *  but a caller is better served by the scrubbed text than by a throw). */
function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return json;
  }
}

/** Compiled redaction config per policy object (compiling per call is waste). */
const redactionCache = new WeakMap<Policy, RedactionConfig>();
function redaction(policy: Policy): RedactionConfig {
  if (!policy.redact) return NO_REDACTION;
  const hit = redactionCache.get(policy);
  if (hit) return hit;
  const cfg: RedactionConfig = {
    enabled: true,
    extra: (policy.redactPatterns ?? []).map(compileRedactionPattern),
  };
  redactionCache.set(policy, cfg);
  return cfg;
}

/** The scope a tab's remembered snapshot lives under. */
/**
 * Throw `[AUTH_REQUIRED]` when the caller asked for it and the page is a
 * high-confidence sign-in wall. Medium-confidence verdicts never fail a call: a
 * lone password field on an otherwise ordinary page is not worth aborting over.
 */
function failIfAuthWall(wall: AuthWall | null, url: string, a: Record<string, unknown>, policy: Policy): void {
  if (!wall || wall.confidence !== 'high') return;
  if (!authGuardOn(a, policy)) return;
  throw new ExecutorError('AUTH_REQUIRED', describeAuthWall(wall, url));
}

/** The guard is on for this call when the caller asked, or the server runs with `--fail-on-auth-wall`. */
function authGuardOn(a: Record<string, unknown>, policy: Policy): boolean {
  return optionalBoolean(a, 'failOnAuthWall') === true || policy.failOnAuthWall === true;
}

/**
 * After an action or history move: when the guard is on, look at the page the
 * tab landed on and fail with `AUTH_REQUIRED` if it is a sign-in wall. Costs
 * one snapshot round-trip, and only when the guard is on. The snapshot is
 * remembered for this tab so a later `snapshot { diff: true }` stays coherent.
 */
async function guardAuthWall(ctx: ToolCtx, a: Record<string, unknown>): Promise<void> {
  if (!authGuardOn(a, ctx.policy)) return;
  const snap = await ctx.ex.snapshot({ tabId: tabId(a), interactiveOnly: true, max: 200 });
  rememberSnapshot(snapScope(a), snap);
  failIfAuthWall(detectAuthWall(snap), snap.url, a, ctx.policy);
}

/**
 * A wait that timed out on a page that has become a sign-in wall is an auth
 * failure, not a slow page. With the guard on, reclassify it.
 */
async function reclassifyTimeout(ctx: ToolCtx, a: Record<string, unknown>, err: unknown): Promise<never> {
  if (err instanceof ExecutorError && err.code === 'TIMEOUT' && authGuardOn(a, ctx.policy)) {
    await guardAuthWall(ctx, a);
  }
  throw err;
}

/** The `authWall` field to spread onto a page-read result: present only when detected. */
function authWallOf(
  ctx: ToolCtx,
  snap: { url: string; title: string; nodes: Array<{ role: string; name: string; tag: string; secret?: boolean }> },
  a: Record<string, unknown>,
): { authWall?: AuthWall } {
  const wall = detectAuthWall(snap);
  failIfAuthWall(wall, snap.url, a, ctx.policy);
  return wall ? { authWall: wall } : {};
}

const snapScope = (a: Record<string, unknown>): string =>
  scopeOf(peekActiveWorkspace()?.profile ?? 'default', tabId(a));

/**
 * Render an action's result, optionally with what the action CHANGED on the
 * page. One extra round-trip buys the caller the delta instead of a full
 * re-read, which is the expensive half of every click-then-look loop.
 */
async function actionResult(
  ctx: ToolCtx,
  a: Record<string, unknown>,
  payload: Record<string, unknown>,
): Promise<CallToolResult> {
  const wantDiff = optionalBoolean(a, 'snapshotAfter') === true;
  const guard = authGuardOn(a, ctx.policy);
  if (!wantDiff && !guard) return jsonResult(payload);
  const scope = snapScope(a);
  const previous = lastSnapshot(scope);
  const snap = await ctx.ex.snapshot({ tabId: tabId(a), max: 200, ...frameOpts(a) });
  // One snapshot serves both: the auth guard reads it first (and aborts the
  // call if the action landed on a sign-in wall), then the diff is built.
  failIfAuthWall(detectAuthWall(snap), snap.url, a, ctx.policy);
  const stored = rememberSnapshot(scope, snap);
  if (!wantDiff) return jsonResult(payload);
  const diff = diffSnapshots(previous, snap);
  return jsonResult({ ...payload, changed: { ...diff, snapshotId: stored.id, url: snap.url } });
}

/**
 * Shared body of console_logs / network_log / dialogs: one gate, one read, and
 * a straight answer when the hook is not there rather than an empty list that
 * reads like "nothing happened".
 */
async function readObservers(
  ctx: ToolCtx,
  a: Record<string, unknown>,
  which: { console?: boolean; network?: boolean; dialogs?: boolean },
  extra: { setPolicy?: DialogPolicy; promptText?: string; includeResources?: boolean } = {},
): Promise<Record<string, unknown>> {
  await gate(ctx, 'observers', { tabId: tabId(a) });
  if (!ctx.ex.observers) {
    throw new ExecutorError('UNSUPPORTED', 'this backend cannot read in-page observers');
  }
  const res = await ctx.ex.observers({
    tabId: tabId(a),
    ...frameOpts(a),
    ...which,
    ...extra,
    sinceSeq: optionalNumber(a, 'sinceSeq', { min: 0 }),
    limit: optionalNumber(a, 'limit', { min: 1, max: 1000 }),
    clear: optionalBoolean(a, 'clear'),
  });
  if (!res.installed) {
    throw new McpToolError(
      'the observer hook is not present on this page. It is registered for allowlisted sites when the ' +
        'server runs with --enable-observers; if it is on, reload the page so the hook is installed at load.',
    );
  }
  return res as unknown as Record<string, unknown>;
}
/** The caller's output cap for a content read, or the default. */
const maxBytes = (args: Record<string, unknown>): number =>
  optionalNumber(args, 'maxBytes', { min: MIN_OUTPUT_BYTES, max: MAX_OUTPUT_BYTES }) ?? DEFAULT_MAX_OUTPUT_BYTES;
const waitUntil = (args: Record<string, unknown>): WaitUntil | undefined =>
  optionalString(args, 'waitUntil') as WaitUntil | undefined;

/** Tools that don't act on a single tab (so `tabId` is irrelevant) — exempt from
 *  the parallel-batch explicit-tabId requirement. Everything else falls back to
 *  the active tab when `tabId` is omitted, which races under concurrency. */
const PARALLEL_TAB_EXEMPT = new Set([
  'tabs_list', 'tab_new', 'chrome_status', 'batch',
  'profile_use', 'task_new', 'tasks_list', 'task_status',
]);

/** Server-side tools that manage the task workspace and need no browser backend. */
const NO_BACKEND_TOOLS = new Set(['profile_use', 'task_new', 'tasks_list', 'task_status']);

/** Project a Workspace to the path fields worth returning to the caller. */
function workspaceView(w: ReturnType<typeof getActiveWorkspace>): Record<string, unknown> {
  return {
    profile: w.profile,
    task: w.task,
    taskDir: w.taskDir,
    downloadDir: w.downloadDir,
    resultsDir: w.resultsDir,
    screenshotsDir: w.screenshotsDir,
    historyPath: w.historyPath,
  };
}

/** A known tool that operates on a specific tab — needs an explicit tabId in a parallel batch. */
function requiresExplicitTab(tool: string): boolean {
  return tool in TOOL_HANDLERS && !PARALLEL_TAB_EXEMPT.has(tool);
}

export const TOOL_HANDLERS: Record<string, ToolHandler> = {
  tabs_list: async (_a, ctx) => jsonResult(await ctx.ex.tabsList()),

  tab_select: async (a, ctx) => {
    await gate(ctx, 'tab_select');
    return jsonResult(await ctx.ex.tabSelect(requireString(a, 'tabId')));
  },
  tab_new: async (a, ctx) => {
    await gate(ctx, 'tab_new');
    return jsonResult(await ctx.ex.tabNew(optionalString(a, 'url'), { active: optionalBoolean(a, 'active') }));
  },
  tab_close: async (a, ctx) => {
    await gate(ctx, 'tab_close');
    return jsonResult(await ctx.ex.tabClose(requireString(a, 'tabId')));
  },

  navigate: async (a, ctx) => {
    const url = requireString(a, 'url');
    await gate(ctx, 'navigate', { url });
    const nav = await ctx.ex.navigate({ url, tabId: tabId(a), waitUntil: waitUntil(a) });
    if (!authGuardOn(a, ctx.policy)) return jsonResult(nav);
    // Guard on: the check costs one snapshot round-trip after the navigation.
    const snap = await ctx.ex.snapshot({ tabId: tabId(a), interactiveOnly: true, max: 200 });
    rememberSnapshot(snapScope(a), snap);
    return jsonResult({ ...nav, ...authWallOf(ctx, snap, a) });
  },
  back: async (a, ctx) => {
    await gate(ctx, 'back', { tabId: tabId(a) });
    const res = await ctx.ex.back(tabId(a));
    await guardAuthWall(ctx, a);
    return jsonResult(res);
  },
  forward: async (a, ctx) => {
    await gate(ctx, 'forward', { tabId: tabId(a) });
    const res = await ctx.ex.forward(tabId(a));
    await guardAuthWall(ctx, a);
    return jsonResult(res);
  },
  reload: async (a, ctx) => {
    await gate(ctx, 'reload', { tabId: tabId(a) });
    const res = await ctx.ex.reload({ tabId: tabId(a), waitUntil: waitUntil(a) });
    await guardAuthWall(ctx, a);
    return jsonResult(res);
  },

  click: async (a, ctx) => {
    await gate(ctx, 'click', { tabId: tabId(a) });
    const t = await resolveTargetArg(ctx, a);
    const res = await ctx.ex.click(t, {
      tabId: tabId(a),
      ...frameOpts(a),
      button: optionalString(a, 'button') as 'left' | 'right' | 'middle' | undefined,
      clickCount: optionalNumber(a, 'clickCount', { min: 1, max: 3 }),
      trusted: optionalBoolean(a, 'trusted'),
    });
    return actionResult(ctx, a, res as unknown as Record<string, unknown>);
  },
  type: async (a, ctx) => {
    await gate(ctx, 'type', { tabId: tabId(a) });
    const t = await resolveTargetArg(ctx, a);
    const res = await ctx.ex.type(t, requireWithinLength(requireString(a, 'text'), 'text', MAX_TEXT_LEN), {
      tabId: tabId(a),
      ...frameOpts(a),
      clear: optionalBoolean(a, 'clear'),
      pressEnter: optionalBoolean(a, 'pressEnter'),
      keyEvents: optionalBoolean(a, 'keyEvents'),
      trusted: optionalBoolean(a, 'trusted'),
    });
    return actionResult(ctx, a, res as unknown as Record<string, unknown>);
  },
  select_option: async (a, ctx) => {
    await gate(ctx, 'type', { tabId: tabId(a) }); // mutating
    const t = await resolveTargetArg(ctx, a);
    const values = optionalStringArray(a, 'values');
    if (!values || values.length === 0) throw new McpToolError('"values" must be a non-empty array of strings');
    const res = await ctx.ex.selectOption(t, values, { tabId: tabId(a), ...frameOpts(a) });
    return actionResult(ctx, a, res as unknown as Record<string, unknown>);
  },
  press: async (a, ctx) => {
    await gate(ctx, 'press', { tabId: tabId(a) });
    const res = await ctx.ex.press(requireString(a, 'key'), {
      tabId: tabId(a),
      modifiers: optionalStringArray(a, 'modifiers') as never,
    });
    await guardAuthWall(ctx, a); // Enter on a form is the classic way to land on a wall
    return jsonResult(res);
  },
  hover: async (a, ctx) => {
    await gate(ctx, 'hover', { tabId: tabId(a) });
    const t = await resolveTargetArg(ctx, a);
    const res = await ctx.ex.hover(t, { tabId: tabId(a), ...frameOpts(a) });
    return actionResult(ctx, a, res as unknown as Record<string, unknown>);
  },
  scroll: async (a, ctx) => {
    await gate(ctx, 'scroll', { tabId: tabId(a) });
    return jsonResult(
      await ctx.ex.scroll({
        tabId: tabId(a),
        ...frameOpts(a),
        x: optionalNumber(a, 'x'),
        y: optionalNumber(a, 'y'),
        deltaX: optionalNumber(a, 'deltaX'),
        deltaY: optionalNumber(a, 'deltaY'),
        target: optionalTarget(a),
      }),
    );
  },

  screenshot: async (a, ctx) => {
    await gate(ctx, 'screenshot', { tabId: tabId(a) });
    const format = optionalString(a, 'format');
    if (format !== undefined && format !== 'jpeg' && format !== 'png') {
      throw new McpToolError('"format" must be "jpeg" or "png"');
    }
    const shot = await ctx.ex.screenshot({
      tabId: tabId(a),
      ...frameOpts(a),
      fullPage: optionalBoolean(a, 'fullPage'),
      target: optionalTarget(a),
      format,
      quality: optionalNumber(a, 'quality', { min: 1, max: 100 }),
      scale: optionalNumber(a, 'scale', { min: 0.1, max: 4 }),
    });
    saveScreenshot(shot.dataBase64, shot.mimeType === 'image/jpeg' ? 'jpg' : 'png');
    const caption = shot.truncated ? `(truncated; full height ${shot.fullHeight}px)` : undefined;
    return imageResult(shot.dataBase64, shot.mimeType, caption);
  },
  get_text: async (a, ctx) => {
    await gate(ctx, 'get_text', { tabId: tabId(a) });
    const res = await ctx.ex.getText(optionalTarget(a), { tabId: tabId(a), ...frameOpts(a) });
    // Save the FULL read before capping — the artifact on disk stays lossless;
    // only what crosses into the caller's context is bounded.
    saveResult('get_text', 'json', JSON.stringify(res, null, 2));
    const clean = redactText(res.text, redaction(ctx.policy));
    noteRedactions(clean.redactions);
    const capped = capText(clean.value, maxBytes(a));
    noteBytes(capped.returnedBytes);
    return jsonResult({
      ...res,
      text: capped.text,
      ...truncationMeta(capped),
      ...(clean.redactions ? { redactions: clean.redactions } : {}),
    });
  },
  get_html: async (a, ctx) => {
    await gate(ctx, 'get_html', { tabId: tabId(a) });
    const res = await ctx.ex.getHtml(optionalTarget(a), {
      tabId: tabId(a),
      ...frameOpts(a),
      outer: optionalBoolean(a, 'outer'),
    });
    // Password values go before the cap, so a truncated read cannot leak what a
    // full one would have hidden.
    const clean = redactHtml(res.html, redaction(ctx.policy));
    noteRedactions(clean.redactions);
    const capped = capHtml(clean.value, maxBytes(a));
    noteBytes(capped.returnedBytes);
    return jsonResult({
      ...res,
      html: capped.text,
      ...truncationMeta(capped),
      ...(clean.redactions ? { redactions: clean.redactions } : {}),
    });
  },
  snapshot: async (a, ctx) => {
    await gate(ctx, 'get_text', { tabId: tabId(a) }); // read of page structure
    const snap = await ctx.ex.snapshot({
      tabId: tabId(a),
      ...frameOpts(a),
      interactiveOnly: optionalBoolean(a, 'interactiveOnly'),
      max: optionalNumber(a, 'max', { min: 1, max: 1000 }),
    });
    const scope = snapScope(a);
    const previous = lastSnapshot(scope);
    const stored = rememberSnapshot(scope, snap);
    const authWall = authWallOf(ctx, snap, a);
    if (optionalBoolean(a, 'diff') !== true) {
      return jsonResult({ ...snap, snapshotId: stored.id, ...authWall });
    }
    const diff = diffSnapshots(previous, snap);
    return jsonResult({
      url: snap.url,
      title: snap.title,
      snapshotId: stored.id,
      ...authWall,
      ...diff,
      ...(diff.since === null
        ? { note: 'no previous snapshot for this tab, so everything is reported as added' }
        : {}),
    });
  },
  get_cookies: async (a, ctx) => {
    await gate(ctx, 'get_text', { tabId: tabId(a) }); // reads tab-scoped secrets; same domain gate as content reads
    return jsonResult(await ctx.ex.getCookies({ tabId: tabId(a), url: optionalString(a, 'url') }));
  },
  storage: async (a, ctx) => {
    const op = requireString(a, 'op') as 'get' | 'set' | 'remove' | 'clear';
    // get is a read; set/remove/clear mutate.
    await gate(ctx, op === 'get' ? 'get_text' : 'type', { tabId: tabId(a) });
    if ((op === 'set' || op === 'remove') && !optionalString(a, 'key')) {
      throw new McpToolError(`storage "${op}" requires a "key"`);
    }
    return jsonResult(
      await ctx.ex.storage({
        op,
        key: optionalString(a, 'key'),
        value: optionalString(a, 'value'),
        session: optionalBoolean(a, 'session'),
        tabId: tabId(a),
      }),
    );
  },
  eval: async (a, ctx) => {
    await gate(ctx, 'eval', { tabId: tabId(a) });
    const res = await ctx.ex.eval(requireString(a, 'expression'), {
      tabId: tabId(a),
      ...frameOpts(a),
      awaitPromise: optionalBoolean(a, 'awaitPromise'),
    });
    // eval returns arbitrary page data — the widest read there is, so it gets
    // the same scrub as the content reads.
    const cfg = redaction(ctx.policy);
    if (!cfg.enabled || res.value === undefined) return jsonResult(res);
    const asText = typeof res.value === 'string' ? res.value : JSON.stringify(res.value);
    if (asText === undefined) return jsonResult(res);
    const clean = redactText(asText, cfg);
    if (clean.redactions === 0) return jsonResult(res);
    noteRedactions(clean.redactions);
    const value = typeof res.value === 'string' ? clean.value : safeParse(clean.value);
    return jsonResult({ ...res, value, redactions: clean.redactions });
  },
  wait_for: async (a, ctx) => {
    await gate(ctx, 'wait_for', { tabId: tabId(a) });
    try {
      return jsonResult(
        await ctx.ex.waitFor({
          tabId: tabId(a),
          ...frameOpts(a),
          selector: optionalString(a, 'selector'),
          textContains: optionalString(a, 'textContains'),
          gone: optionalBoolean(a, 'gone'),
          timeoutMs: optionalNumber(a, 'timeoutMs', { min: 0, max: 120_000 }),
        }),
      );
    } catch (err) {
      return reclassifyTimeout(ctx, a, err);
    }
  },

  extract_links: async (a, ctx) => {
    await gate(ctx, 'get_text', { tabId: tabId(a) }); // read of page content
    const res = await extractLinks(ctx.ex, {
      ...frameOpts(a),
      selector: optionalString(a, 'selector'),
      sameOriginOnly: optionalBoolean(a, 'sameOriginOnly'),
      dedupe: optionalBoolean(a, 'dedupe'),
      limit: optionalNumber(a, 'limit', { min: 1, max: 10_000 }),
      tabId: tabId(a),
    });
    saveResult('extract_links', 'json', JSON.stringify(res, null, 2));
    return jsonResult(res);
  },
  read_as_markdown: async (a, ctx) => {
    await gate(ctx, 'get_text', { tabId: tabId(a) });
    const md = await readAsMarkdown(ctx.ex, {
      selector: optionalString(a, 'selector'),
      tabId: tabId(a),
      ...frameOpts(a),
    });
    saveResult('read_as_markdown', 'md', md);
    const clean = redactText(md, redaction(ctx.policy));
    noteRedactions(clean.redactions);
    const capped = capText(clean.value, maxBytes(a));
    noteBytes(capped.returnedBytes);
    // Markdown is returned as plain text, so the truncation notice has to ride in
    // the body rather than as sibling JSON fields.
    return textResult(
      capped.truncated
        ? `${capped.text}\n\n[truncated: ${capped.returnedBytes} of ${capped.totalBytes} bytes — raise maxBytes or narrow with selector; the full document was saved to the task's results/ dir]`
        : capped.text,
    );
  },
  fill_form: async (a, ctx) => {
    await gate(ctx, 'type', { tabId: tabId(a) }); // mutating
    const fields = a.fields;
    if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) {
      throw new McpToolError('"fields" must be an object mapping selector -> string|boolean');
    }
    for (const [sel, val] of Object.entries(fields as Record<string, unknown>)) {
      if (typeof val === 'string') requireWithinLength(val, `fields["${sel}"]`, MAX_TEXT_LEN);
    }
    const res = await fillForm(ctx.ex, {
      ...frameOpts(a),
      fields: fields as Record<string, string | boolean>,
      submitSelector: optionalString(a, 'submitSelector'),
      tabId: tabId(a),
    });
    await guardAuthWall(ctx, a);
    return jsonResult(res);
  },
  download_file: async (a, ctx) => {
    await gate(ctx, 'download_file');
    const url = optionalString(a, 'url');
    const target = optionalTarget(a);
    if (!url && !target) throw new McpToolError('provide "url" or a target (selector|ref)');
    return jsonResult(
      await ctx.ex.download({ url, target, tabId: tabId(a), suggestedName: optionalString(a, 'suggestedName') }),
    );
  },
  upload_file: async (a, ctx) => {
    const t = requireTarget(a);
    await gate(ctx, 'upload_file', { tabId: tabId(a) });
    const files = optionalStringArray(a, 'files');
    if (!files || files.length === 0) throw new McpToolError('"files" must be a non-empty array of absolute local paths');
    // Path restriction: uploads MUST be confined to a configured directory. Without
    // one, any absolute path (e.g. ~/.ssh/id_rsa) could be uploaded to a page, so we
    // refuse rather than allow unrestricted local-file access. With a dir, every file
    // must resolve inside it (blocks `..` traversal and arbitrary-file exfiltration).
    if (!ctx.policy.uploadsDir) {
      throw new McpToolError('upload denied: uploads require an --uploads-dir to be configured (refusing unrestricted local-file access)');
    }
    const dir = pathResolve(ctx.policy.uploadsDir);
    for (const f of files) {
      const abs = pathResolve(f);
      if (abs !== dir && !abs.startsWith(dir + sep)) {
        throw new McpToolError(`upload denied: "${f}" is outside the allowed uploads dir (${dir})`);
      }
    }
    return jsonResult(await ctx.ex.uploadFile(t, files, { tabId: tabId(a) }));
  },

  frames_list: async (a, ctx) => {
    await gate(ctx, 'frames_list', { tabId: tabId(a) });
    if (!ctx.ex.framesList) throw new ExecutorError('UNSUPPORTED', 'this backend cannot enumerate frames');
    const frames = await ctx.ex.framesList({ tabId: tabId(a) });
    return jsonResult({
      frames,
      count: frames.length,
      ...(frames.length > 1
        ? { hint: 'pass frameId (or allFrames:true) on a click/type/get_text to act inside one of these' }
        : {}),
    });
  },

  console_logs: async (a, ctx) => {
    const res = await readObservers(ctx, a, { console: true });
    const level = optionalString(a, 'level');
    const entries = ((res.console as Array<{ level: string }>) ?? []).filter((e) => !level || e.level === level);
    return jsonResult({
      entries,
      count: entries.length,
      ...(res.dropped ? { dropped: true, dropNote: 'older entries were dropped from the in-page ring buffer' } : {}),
      ...(res.justInstalled ? { note: res.note } : {}),
    });
  },

  network_log: async (a, ctx) => {
    const res = await readObservers(ctx, a, { network: true }, {
      includeResources: optionalBoolean(a, 'includeResources'),
    });
    const contains = optionalString(a, 'urlContains');
    const failedOnly = optionalBoolean(a, 'failedOnly') === true;
    const entries = ((res.network as Array<{ url: string; status?: number; error?: string }>) ?? []).filter((e) => {
      if (contains && !e.url.includes(contains)) return false;
      if (failedOnly && !e.error && (e.status ?? 0) < 400) return false;
      return true;
    });
    return jsonResult({
      entries,
      count: entries.length,
      ...(res.dropped ? { dropped: true } : {}),
      ...(res.justInstalled ? { note: res.note } : {}),
    });
  },

  dialogs: async (a, ctx) => {
    const policy = optionalString(a, 'policy') as DialogPolicy | undefined;
    if (policy && policy !== 'dismiss' && policy !== 'accept') {
      throw new McpToolError('"policy" must be "dismiss" or "accept"');
    }
    const res = await readObservers(ctx, a, { dialogs: true }, {
      setPolicy: policy,
      promptText: optionalString(a, 'promptText'),
    });
    return jsonResult({
      entries: res.dialogs ?? [],
      count: ((res.dialogs as unknown[]) ?? []).length,
      policy: res.dialogPolicy,
      ...(res.justInstalled ? { note: res.note } : {}),
    });
  },

  print_pdf: async (a, ctx) => {
    await gate(ctx, 'print_pdf', { tabId: tabId(a) });
    if (!ctx.ex.printPdf) throw new ExecutorError('UNSUPPORTED', 'this backend cannot print to PDF');
    const pdf = await ctx.ex.printPdf({
      tabId: tabId(a),
      landscape: optionalBoolean(a, 'landscape'),
      printBackground: optionalBoolean(a, 'printBackground'),
      scale: optionalNumber(a, 'scale', { min: 0.1, max: 2 }),
      paperWidth: optionalNumber(a, 'paperWidth', { min: 0.1, max: 200 }),
      paperHeight: optionalNumber(a, 'paperHeight', { min: 0.1, max: 200 }),
      pageRanges: optionalString(a, 'pageRanges'),
      preferCSSPageSize: optionalBoolean(a, 'preferCSSPageSize'),
    });
    const bytes = Buffer.from(pdf.dataBase64, 'base64');
    const path = saveBinary('print_pdf', 'pdf', bytes);
    noteBytes(bytes.byteLength);
    // The bytes themselves are deliberately NOT returned: a PDF is megabytes of
    // base64 that no model can read, and the file on disk is the useful artifact.
    return jsonResult({
      path,
      bytes: bytes.byteLength,
      url: pdf.url,
      title: pdf.title,
      ...(path ? {} : { note: 'no active task workspace, so the PDF was not saved to disk' }),
    });
  },

  chrome_status: async (_a, ctx) => jsonResult(ctx.ex.status()),
  auth_check: async (a, ctx) => {
    await gate(ctx, 'get_text', { tabId: tabId(a) }); // read of page structure
    const snap = await ctx.ex.snapshot({ tabId: tabId(a), ...frameOpts(a), interactiveOnly: true, max: 200 });
    const wall = detectAuthWall(snap);
    failIfAuthWall(wall, snap.url, a, ctx.policy);
    return jsonResult({
      url: snap.url,
      title: snap.title,
      authRequired: wall !== null,
      ...(wall ? { confidence: wall.confidence, signals: wall.signals } : {}),
    });
  },

  // --- task workspace management (server-side; no browser needed) ---
  profile_use: async (a) => {
    // Snapshots are keyed by profile+tab, and a profile switch routes to a
    // different browser entirely — keeping the old tree would diff a page
    // against one from another machine.
    resetSnapshots();
    return jsonResult(workspaceView(switchWorkspace({ profile: requireString(a, 'name') })));
  },
  task_new: async (a) => jsonResult(workspaceView(switchWorkspace({ task: requireString(a, 'name') }))),
  task_status: async () => jsonResult(workspaceView(getActiveWorkspace())),
  tasks_list: async () => jsonResult(listTasks(getActiveWorkspace().dataDir)),

  // Fan-out: each sub-op is routed back through `dispatchToolCall`, so it gets
  // the same policy gate, rate limit, and never-throw handling as a direct call.
  batch: async (a) => runBatch(a, { dispatch: dispatchToolCall, requiresExplicitTab }),
};

// ---------------------------------------------------------------------------
// Dispatch (never-throw firewall)
// ---------------------------------------------------------------------------

function errMessage(err: unknown): string {
  // Only the text crosses the MCP boundary, so the code has to travel inside it —
  // otherwise a caller cannot tell EXTENSION_DISCONNECTED (retry in a moment)
  // from POLICY_DENIED (retrying will never help).
  if (err instanceof ExecutorError) return `[${err.code}] ${err.message}`;
  if (err instanceof McpToolError) return err.message;
  if (err instanceof Error) return `internal error: ${err.message}`;
  return `internal error: ${String(err)}`;
}

// ---------------------------------------------------------------------------
// Rate limiting — a sliding window over tool calls for the active session.
// Generous by default so normal use and the test suite are unaffected; tune
// via the constants below.
// ---------------------------------------------------------------------------

/** Max tool calls permitted within `RATE_WINDOW_MS`. */
const RATE_MAX_CALLS = 600;
/** Sliding-window length, in milliseconds. */
const RATE_WINDOW_MS = 60_000;

/** Timestamps (ms) of recent dispatches; older entries are evicted lazily. */
let rateWindow: number[] = [];

/** Reset limiter state — for tests that exercise the ceiling. */
export function resetRateLimiter(): void {
  rateWindow = [];
}

/**
 * Record one call and report whether it is within the ceiling. Evicts entries
 * older than the window so the array stays bounded.
 */
function allowCall(now: number): boolean {
  const cutoff = now - RATE_WINDOW_MS;
  if (rateWindow.length > 0 && rateWindow[0] <= cutoff) {
    rateWindow = rateWindow.filter((t) => t > cutoff);
  }
  if (rateWindow.length >= RATE_MAX_CALLS) return false;
  rateWindow.push(now);
  return true;
}

/** A compact, length-bounded summary of a call's args for the history log. */
function summarizeArgs(rawArgs: unknown): Record<string, unknown> | undefined {
  if (typeof rawArgs !== 'object' || rawArgs === null) return undefined;
  const a = rawArgs as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of ['url', 'selector', 'ref', 'name', 'text', 'key', 'op', 'tabId']) {
    const v = a[k];
    if (v === undefined) continue;
    out[k] = typeof v === 'string' && v.length > 120 ? `${v.slice(0, 120)}…` : v;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Append one action record to the active task's history.jsonl (best-effort).
 *
 * The audit fields — which URL the policy was evaluated against, whether it
 * denied, how many bytes came back, how many secrets were scrubbed — are the
 * ones someone actually wants when reviewing what an agent did in their real
 * browser, and they exist only inside the call.
 */
function recordHistory(
  tool: string,
  rawArgs: unknown,
  ok: boolean,
  extra: { error?: string; ms?: number; audit?: CallAudit } = {},
): void {
  const a = extra.audit ?? {};
  appendHistory({
    ts: new Date().toISOString(),
    tool,
    args: summarizeArgs(rawArgs),
    ok,
    ...(extra.ms !== undefined ? { ms: extra.ms } : {}),
    ...(a.url ? { url: a.url } : {}),
    ...(a.denied ? { policy: 'denied' } : a.url ? { policy: 'allowed' } : {}),
    ...(a.bytes !== undefined ? { bytes: a.bytes } : {}),
    ...(a.redactions ? { redactions: a.redactions } : {}),
    ...(extra.error ? { error: extra.error } : {}),
  });
}

/**
 * Tools it is safe to re-issue after the extension drops mid-flight.
 *
 * MV3 recycles the extension's service worker on its own schedule, so a command
 * can be in flight when the socket goes away — a fault that has nothing to do
 * with the call and that the user currently fixes by re-issuing the identical
 * request by hand. Only idempotent calls are eligible: repeating a `click` or a
 * `type` could submit a form twice, which is not a cost worth paying to avoid one
 * error message. `navigate` is included because landing on the same URL twice is
 * the same end state.
 */
const RETRY_SAFE_TOOLS = new Set([
  'tabs_list', 'chrome_status',
  'get_text', 'get_html', 'snapshot', 'get_cookies', 'auth_check',
  'extract_links', 'read_as_markdown', 'screenshot',
  'wait_for', 'navigate', 'reload',
  'frames_list', 'print_pdf',
]);

/** Whether `err` is the transient bridge fault that a single retry can clear. */
function isRetryableFault(name: string, err: unknown): boolean {
  return err instanceof ExecutorError && err.code === 'EXTENSION_DISCONNECTED' && RETRY_SAFE_TOOLS.has(name);
}

export async function dispatchToolCall(name: string, rawArgs: unknown): Promise<CallToolResult> {
  // The allowlist is checked here, not only at registration, so a `batch` op
  // cannot reach a tool the operator kept off the surface.
  if (!isToolEnabled(name)) return errorResult(`tool not enabled on this server (--tools): ${name}`);
  const handler = TOOL_HANDLERS[name];
  if (!handler) return errorResult(`unknown tool: ${name}`);
  if (!allowCall(Date.now())) return errorResult('rate limit exceeded; slow down');
  const started = Date.now();
  // One audit record per call, carried through async hops so a parallel `batch`
  // cannot cross-attribute one op's target URL to another's log line.
  const { result: outcome } = await withAudit(async (audit) =>
    dispatchInner(name, handler, rawArgs, audit, started),
  );
  return outcome;
}

async function dispatchInner(
  name: string,
  handler: ToolHandler,
  rawArgs: unknown,
  audit: CallAudit,
  started: number,
): Promise<CallToolResult> {
  try {
    const mgr = getManager();
    // Workspace-management tools run server-side and must work even with no
    // browser paired, so they skip the executor readiness check.
    const ex = NO_BACKEND_TOOLS.has(name) ? (null as unknown as Executor) : await mgr.ensureReady();
    let result: CallToolResult;
    try {
      result = await handler(asArgs(rawArgs), { ex, policy: mgr.policy });
    } catch (err) {
      if (!isRetryableFault(name, err)) throw err;
      // Re-pair (ensureReady resolves the new connection) and try once more. A
      // second failure propagates untouched, so a genuinely unpaired browser
      // still reports EXTENSION_DISCONNECTED rather than retrying forever.
      logDebug(`${name}: extension disconnected mid-call; re-pairing and retrying once`);
      const reconnected = await mgr.ensureReady();
      result = await handler(asArgs(rawArgs), { ex: reconnected, policy: mgr.policy });
      logDebug(`${name}: retry after reconnect succeeded`);
    }
    recordHistory(name, rawArgs, !result.isError, { ms: Date.now() - started, audit });
    return result;
  } catch (err) {
    const message = errMessage(err);
    recordHistory(name, rawArgs, false, { error: message, ms: Date.now() - started, audit });
    return errorResult(message);
  }
}

/** Assert the catalog and the dispatch table describe the same tool set. */
export function assertNoDrift(): void {
  const defs = new Set(TOOL_DEFINITIONS.map((d) => d.name));
  const handlers = new Set(Object.keys(TOOL_HANDLERS));
  for (const n of defs) if (!handlers.has(n)) throw new Error(`tool "${n}" is advertised but has no handler`);
  for (const n of handlers) if (!defs.has(n)) throw new Error(`handler "${n}" has no advertised definition`);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

export function registerTools(server: McpServer): void {
  assertNoDrift();

  // Register each tool with its zod `inputSchema`. The SDK advertises it in
  // `tools/list` and validates arguments before invoking the handler, which
  // just routes back through `dispatchToolCall` — our never-throw firewall that
  // applies the rate limit, executor readiness, policy gate, and history log.
  for (const d of TOOL_DEFINITIONS) {
    if (!isToolEnabled(d.name)) continue;
    server.registerTool(
      d.name,
      { description: d.description, inputSchema: d.inputSchema },
      async (args: Record<string, unknown>) => dispatchToolCall(d.name, args),
    );
  }

  const advertised = enabledToolNames();
  if (advertised.length < TOOL_NAMES.length) {
    logErr(`--tools: advertising ${advertised.length} of ${TOOL_NAMES.length} tools (${advertised.join(', ')})`);
  }
}
