/**
 * src/mcp/tools.ts — the MCP tool surface: the advertised catalog
 * (`TOOL_DEFINITIONS`), the name→handler dispatch (`TOOL_HANDLERS`), the
 * never-throw firewall (`dispatchToolCall`), and `registerTools()` which wires
 * both onto a `Server`.
 *
 * Each handler: validate args → **policy-gate against the relevant URL** → call
 * the active Executor (or a server-side helper) → serialize via an envelope.
 * Nothing here throws to the transport: `dispatchToolCall` renders any thrown
 * `Error` as an `isError` result.
 */

import { resolve as pathResolve, sep } from 'node:path';

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';

import type { WireMethod } from '../../shared/protocol';
import type { Executor, Target, WaitUntil } from '../executor/types';
import { ExecutorError } from '../executor/types';
import { getManager } from '../executor/manager';
import { assertUrlAllowed, type Policy } from '../security/policy';
import { errorResult, imageResult, jsonResult, textResult } from './envelopes';
import { runBatch } from './batch';
import { extractLinks, fillForm, readAsMarkdown } from './helpers';
import { listTasks } from '../bridge/tasks';
import {
  appendHistory,
  getActiveWorkspace,
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
  inputSchema: Record<string, unknown>;
}

const TARGET_PROPS = {
  selector: { type: 'string', description: 'CSS selector (exactly one of selector|ref)' },
  ref: { type: 'string', description: 'Element ref from a prior read (exactly one of selector|ref)' },
} as const;

const obj = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  { name: 'tabs_list', description: 'List open browser tabs.', inputSchema: obj({}) },
  { name: 'tab_select', description: 'Make a tab active by tabId.', inputSchema: obj({ tabId: { type: 'string' } }, ['tabId']) },
  { name: 'tab_new', description: 'Open a NEW tab (optionally at a URL) and focus it. Prefer this over `navigate` when the user says "open"/"go to" a site — `navigate` REPLACES the current tab. Pass active:false to open in the background (used by parallel batches).', inputSchema: obj({ url: { type: 'string' }, active: { type: 'boolean' } }) },
  { name: 'tab_close', description: 'Close a tab by tabId.', inputSchema: obj({ tabId: { type: 'string' } }, ['tabId']) },

  { name: 'navigate', description: 'Navigate a tab to a URL, REPLACING its current page. Acts on the active tab unless tabId is given — to open a site without losing the current page, use `tab_new` instead.', inputSchema: obj({ url: { type: 'string' }, tabId: { type: 'string' }, waitUntil: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle'] } }, ['url']) },
  { name: 'back', description: 'Go back in history.', inputSchema: obj({ tabId: { type: 'string' } }) },
  { name: 'forward', description: 'Go forward in history.', inputSchema: obj({ tabId: { type: 'string' } }) },
  { name: 'reload', description: 'Reload the active (or given) tab.', inputSchema: obj({ tabId: { type: 'string' }, waitUntil: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle'] } }) },

  { name: 'click', description: 'Click an element (target by selector or a snapshot ref). trusted=true uses real OS-level input.', inputSchema: obj({ ...TARGET_PROPS, tabId: { type: 'string' }, button: { type: 'string', enum: ['left', 'right', 'middle'] }, clickCount: { type: 'number' }, trusted: { type: 'boolean' } }) },
  { name: 'type', description: 'Type text into an element. trusted=true sends real keystrokes (works on React/Vue controlled inputs).', inputSchema: obj({ ...TARGET_PROPS, text: { type: 'string' }, tabId: { type: 'string' }, clear: { type: 'boolean' }, pressEnter: { type: 'boolean' }, keyEvents: { type: 'boolean' }, trusted: { type: 'boolean' } }, ['text']) },
  { name: 'select_option', description: 'Select option(s) of a <select> by value or visible label.', inputSchema: obj({ ...TARGET_PROPS, values: { type: 'array', items: { type: 'string' } }, tabId: { type: 'string' } }, ['values']) },
  { name: 'press', description: 'Press a key (with optional modifiers).', inputSchema: obj({ key: { type: 'string' }, modifiers: { type: 'array', items: { type: 'string' } }, tabId: { type: 'string' } }, ['key']) },
  { name: 'hover', description: 'Hover over an element.', inputSchema: obj({ ...TARGET_PROPS, tabId: { type: 'string' } }) },
  { name: 'scroll', description: 'Scroll the page or to an element.', inputSchema: obj({ ...TARGET_PROPS, x: { type: 'number' }, y: { type: 'number' }, deltaX: { type: 'number' }, deltaY: { type: 'number' }, tabId: { type: 'string' } }) },

  { name: 'screenshot', description: 'Capture a PNG screenshot (page or element).', inputSchema: obj({ ...TARGET_PROPS, fullPage: { type: 'boolean' }, tabId: { type: 'string' } }) },
  { name: 'get_text', description: 'Get visible text of the page or an element.', inputSchema: obj({ ...TARGET_PROPS, tabId: { type: 'string' } }) },
  { name: 'get_html', description: 'Get HTML of the page or an element.', inputSchema: obj({ ...TARGET_PROPS, outer: { type: 'boolean' }, tabId: { type: 'string' } }) },
  { name: 'snapshot', description: 'Accessibility snapshot: interactive elements with stable refs to target by `ref` (more reliable than guessing CSS selectors).', inputSchema: obj({ interactiveOnly: { type: 'boolean' }, max: { type: 'number' }, tabId: { type: 'string' } }) },
  { name: 'get_cookies', description: "Read cookies visible to the tab's URL (or a given url).", inputSchema: obj({ url: { type: 'string' }, tabId: { type: 'string' } }) },
  { name: 'storage', description: 'Read/write localStorage (or sessionStorage). op: get|set|remove|clear.', inputSchema: obj({ op: { type: 'string', enum: ['get', 'set', 'remove', 'clear'] }, key: { type: 'string' }, value: { type: 'string' }, session: { type: 'boolean' }, tabId: { type: 'string' } }, ['op']) },
  { name: 'eval', description: 'Evaluate JavaScript in the page (disabled in safe-mode).', inputSchema: obj({ expression: { type: 'string' }, awaitPromise: { type: 'boolean' }, tabId: { type: 'string' } }, ['expression']) },
  { name: 'wait_for', description: 'Wait for a selector or text to appear/disappear.', inputSchema: obj({ selector: { type: 'string' }, textContains: { type: 'string' }, gone: { type: 'boolean' }, timeoutMs: { type: 'number' }, tabId: { type: 'string' } }) },

  { name: 'extract_links', description: 'Extract anchors from the page or a subtree.', inputSchema: obj({ selector: { type: 'string' }, sameOriginOnly: { type: 'boolean' }, tabId: { type: 'string' } }) },
  { name: 'read_as_markdown', description: 'Read the page (or subtree) as readable markdown.', inputSchema: obj({ selector: { type: 'string' }, tabId: { type: 'string' } }) },
  { name: 'fill_form', description: 'Fill multiple fields (keyed by selector) and optionally submit.', inputSchema: obj({ fields: { type: 'object' }, submitSelector: { type: 'string' }, tabId: { type: 'string' } }, ['fields']) },
  { name: 'download_file', description: 'Download a file by URL or from a link element.', inputSchema: obj({ url: { type: 'string' }, ...TARGET_PROPS, suggestedName: { type: 'string' }, tabId: { type: 'string' } }) },
  { name: 'upload_file', description: 'Set local file(s) on a file <input> (target by selector or ref) — uploads without the OS dialog. Requires --enable-uploads. `files` are absolute local paths.', inputSchema: obj({ ...TARGET_PROPS, files: { type: 'array', items: { type: 'string' } }, tabId: { type: 'string' } }, ['files']) },

  { name: 'chrome_status', description: 'Report backend/session status.', inputSchema: obj({}) },

  { name: 'profile_use', description: 'Switch the active browser profile (identity). Subsequent downloads, results, screenshots, and the action log are stored under profiles/<name>/. Resets the active task to "default" unless you then call task_new.', inputSchema: obj({ name: { type: 'string', description: 'Profile name (becomes a folder; sanitized to a safe path segment).' } }, ['name']) },
  { name: 'task_new', description: 'Start a new task (run) under the active profile. Creates profiles/<profile>/tasks/<name>/ with downloads/, results/, screenshots/ and makes it the active task so all captured artifacts land there.', inputSchema: obj({ name: { type: 'string', description: 'Task name (becomes a folder; sanitized to a safe path segment).' } }, ['name']) },
  { name: 'tasks_list', description: 'List every task across all profiles under the data dir, with sizes and download counts.', inputSchema: obj({}) },
  { name: 'task_status', description: 'Report the active profile/task and the folder paths where this run\'s artifacts are stored.', inputSchema: obj({}) },

  {
    name: 'batch',
    description:
      'Run multiple tool calls in one request — parallel (default) or serial. Each op is { tool, args } and goes through the same policy gate, rate limit, and error handling as a direct call. In parallel mode, tab-scoped ops MUST pass an explicit tabId (the active-tab default is unsafe under concurrency). Use to drive several tabs at once (e.g. open tabs, then batch get_text across them). Cannot be nested.',
    inputSchema: obj(
      {
        ops: {
          type: 'array',
          description: 'Operations to run; each is a tool name + its args.',
          items: obj({ tool: { type: 'string' }, args: { type: 'object' } }, ['tool']),
        },
        mode: { type: 'string', enum: ['parallel', 'serial'], description: 'Default "parallel".' },
        stopOnError: { type: 'boolean', description: 'Serial mode only: stop after the first failing op (the rest are skipped).' },
        maxConcurrency: { type: 'number', description: 'Parallel mode: max ops in flight at once (default 6).' },
      },
      ['ops'],
    ),
  },
];

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

interface ToolCtx {
  ex: Executor;
  policy: Policy;
}

type ToolHandler = (args: Record<string, unknown>, ctx: ToolCtx) => Promise<CallToolResult>;

/** Resolve the URL the policy should be evaluated against (the active tab). */
async function activeUrl(ex: Executor): Promise<string> {
  try {
    const tabs = await ex.tabsList();
    return tabs.find((t) => t.active)?.url ?? tabs[0]?.url ?? 'about:blank';
  } catch {
    return 'about:blank';
  }
}

/** Policy chokepoint. `urlOverride` is the destination for navigation. */
async function gate(ctx: ToolCtx, method: WireMethod, urlOverride?: string): Promise<void> {
  const url = urlOverride ?? (await activeUrl(ctx.ex));
  assertUrlAllowed(url, method, ctx.policy);
}

const tabId = (args: Record<string, unknown>): string | undefined => optionalString(args, 'tabId');
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
    await gate(ctx, 'navigate', url);
    return jsonResult(await ctx.ex.navigate({ url, tabId: tabId(a), waitUntil: waitUntil(a) }));
  },
  back: async (a, ctx) => {
    await gate(ctx, 'back');
    return jsonResult(await ctx.ex.back(tabId(a)));
  },
  forward: async (a, ctx) => {
    await gate(ctx, 'forward');
    return jsonResult(await ctx.ex.forward(tabId(a)));
  },
  reload: async (a, ctx) => {
    await gate(ctx, 'reload');
    return jsonResult(await ctx.ex.reload({ tabId: tabId(a), waitUntil: waitUntil(a) }));
  },

  click: async (a, ctx) => {
    const t = requireTarget(a);
    await gate(ctx, 'click');
    return jsonResult(
      await ctx.ex.click(t, {
        tabId: tabId(a),
        button: optionalString(a, 'button') as 'left' | 'right' | 'middle' | undefined,
        clickCount: optionalNumber(a, 'clickCount', { min: 1, max: 3 }),
        trusted: optionalBoolean(a, 'trusted'),
      }),
    );
  },
  type: async (a, ctx) => {
    const t = requireTarget(a);
    await gate(ctx, 'type');
    return jsonResult(
      await ctx.ex.type(t, requireWithinLength(requireString(a, 'text'), 'text', MAX_TEXT_LEN), {
        tabId: tabId(a),
        clear: optionalBoolean(a, 'clear'),
        pressEnter: optionalBoolean(a, 'pressEnter'),
        keyEvents: optionalBoolean(a, 'keyEvents'),
        trusted: optionalBoolean(a, 'trusted'),
      }),
    );
  },
  select_option: async (a, ctx) => {
    const t = requireTarget(a);
    await gate(ctx, 'type'); // mutating
    const values = optionalStringArray(a, 'values');
    if (!values || values.length === 0) throw new McpToolError('"values" must be a non-empty array of strings');
    return jsonResult(await ctx.ex.selectOption(t, values, { tabId: tabId(a) }));
  },
  press: async (a, ctx) => {
    await gate(ctx, 'press');
    return jsonResult(
      await ctx.ex.press(requireString(a, 'key'), {
        tabId: tabId(a),
        modifiers: optionalStringArray(a, 'modifiers') as never,
      }),
    );
  },
  hover: async (a, ctx) => {
    const t = requireTarget(a);
    await gate(ctx, 'hover');
    return jsonResult(await ctx.ex.hover(t, { tabId: tabId(a) }));
  },
  scroll: async (a, ctx) => {
    await gate(ctx, 'scroll');
    return jsonResult(
      await ctx.ex.scroll({
        tabId: tabId(a),
        x: optionalNumber(a, 'x'),
        y: optionalNumber(a, 'y'),
        deltaX: optionalNumber(a, 'deltaX'),
        deltaY: optionalNumber(a, 'deltaY'),
        target: optionalTarget(a),
      }),
    );
  },

  screenshot: async (a, ctx) => {
    await gate(ctx, 'screenshot');
    const shot = await ctx.ex.screenshot({
      tabId: tabId(a),
      fullPage: optionalBoolean(a, 'fullPage'),
      target: optionalTarget(a),
    });
    saveScreenshot(shot.dataBase64);
    const caption = shot.truncated ? `(truncated; full height ${shot.fullHeight}px)` : undefined;
    return imageResult(shot.dataBase64, shot.mimeType, caption);
  },
  get_text: async (a, ctx) => {
    await gate(ctx, 'get_text');
    const res = await ctx.ex.getText(optionalTarget(a), { tabId: tabId(a) });
    saveResult('get_text', 'json', JSON.stringify(res, null, 2));
    return jsonResult(res);
  },
  get_html: async (a, ctx) => {
    await gate(ctx, 'get_html');
    return jsonResult(
      await ctx.ex.getHtml(optionalTarget(a), { tabId: tabId(a), outer: optionalBoolean(a, 'outer') }),
    );
  },
  snapshot: async (a, ctx) => {
    await gate(ctx, 'get_text'); // read of page structure
    return jsonResult(
      await ctx.ex.snapshot({
        tabId: tabId(a),
        interactiveOnly: optionalBoolean(a, 'interactiveOnly'),
        max: optionalNumber(a, 'max', { min: 1, max: 1000 }),
      }),
    );
  },
  get_cookies: async (a, ctx) => {
    await gate(ctx, 'get_text'); // reads tab-scoped secrets; same domain gate as content reads
    return jsonResult(await ctx.ex.getCookies({ tabId: tabId(a), url: optionalString(a, 'url') }));
  },
  storage: async (a, ctx) => {
    const op = requireString(a, 'op') as 'get' | 'set' | 'remove' | 'clear';
    // get is a read; set/remove/clear mutate.
    await gate(ctx, op === 'get' ? 'get_text' : 'type');
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
    await gate(ctx, 'eval');
    return jsonResult(
      await ctx.ex.eval(requireString(a, 'expression'), {
        tabId: tabId(a),
        awaitPromise: optionalBoolean(a, 'awaitPromise'),
      }),
    );
  },
  wait_for: async (a, ctx) => {
    await gate(ctx, 'wait_for');
    return jsonResult(
      await ctx.ex.waitFor({
        tabId: tabId(a),
        selector: optionalString(a, 'selector'),
        textContains: optionalString(a, 'textContains'),
        gone: optionalBoolean(a, 'gone'),
        timeoutMs: optionalNumber(a, 'timeoutMs', { min: 0, max: 120_000 }),
      }),
    );
  },

  extract_links: async (a, ctx) => {
    await gate(ctx, 'get_text'); // read of page content
    const res = await extractLinks(ctx.ex, {
      selector: optionalString(a, 'selector'),
      sameOriginOnly: optionalBoolean(a, 'sameOriginOnly'),
      tabId: tabId(a),
    });
    saveResult('extract_links', 'json', JSON.stringify(res, null, 2));
    return jsonResult(res);
  },
  read_as_markdown: async (a, ctx) => {
    await gate(ctx, 'get_text');
    const md = await readAsMarkdown(ctx.ex, { selector: optionalString(a, 'selector'), tabId: tabId(a) });
    saveResult('read_as_markdown', 'md', md);
    return textResult(md);
  },
  fill_form: async (a, ctx) => {
    await gate(ctx, 'type'); // mutating
    const fields = a.fields;
    if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) {
      throw new McpToolError('"fields" must be an object mapping selector -> string|boolean');
    }
    for (const [sel, val] of Object.entries(fields as Record<string, unknown>)) {
      if (typeof val === 'string') requireWithinLength(val, `fields["${sel}"]`, MAX_TEXT_LEN);
    }
    return jsonResult(
      await fillForm(ctx.ex, {
        fields: fields as Record<string, string | boolean>,
        submitSelector: optionalString(a, 'submitSelector'),
        tabId: tabId(a),
      }),
    );
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
    await gate(ctx, 'upload_file');
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

  chrome_status: async (_a, ctx) => jsonResult(ctx.ex.status()),

  // --- task workspace management (server-side; no browser needed) ---
  profile_use: async (a) => jsonResult(workspaceView(switchWorkspace({ profile: requireString(a, 'name') }))),
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
  if (err instanceof McpToolError || err instanceof ExecutorError) return err.message;
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

/** Append one action record to the active task's history.jsonl (best-effort). */
function recordHistory(tool: string, rawArgs: unknown, ok: boolean, error?: string): void {
  appendHistory({ ts: new Date().toISOString(), tool, args: summarizeArgs(rawArgs), ok, ...(error ? { error } : {}) });
}

export async function dispatchToolCall(name: string, rawArgs: unknown): Promise<CallToolResult> {
  const handler = TOOL_HANDLERS[name];
  if (!handler) return errorResult(`unknown tool: ${name}`);
  if (!allowCall(Date.now())) return errorResult('rate limit exceeded; slow down');
  try {
    const mgr = getManager();
    // Workspace-management tools run server-side and must work even with no
    // browser paired, so they skip the executor readiness check.
    const ex = NO_BACKEND_TOOLS.has(name) ? (null as unknown as Executor) : await mgr.ensureReady();
    const result = await handler(asArgs(rawArgs), { ex, policy: mgr.policy });
    recordHistory(name, rawArgs, !result.isError);
    return result;
  } catch (err) {
    const message = errMessage(err);
    recordHistory(name, rawArgs, false, message);
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

export function registerTools(server: Server): void {
  assertNoDrift();

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS.map((d) => ({
      name: d.name,
      description: d.description,
      inputSchema: d.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) =>
    dispatchToolCall(req.params.name, req.params.arguments),
  );
}
