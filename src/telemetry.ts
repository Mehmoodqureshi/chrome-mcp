/**
 * src/telemetry.ts — anonymous usage statistics from the chrome-mcp SERVER.
 *
 * What it sends, to PostHog: a random per-install id, the chrome-mcp version,
 * OS, CPU architecture and Node major version, whether this session owns the
 * port or shares it, how many browsers are paired (and, when none, which of a
 * few fixed reasons applies), per-tool call and error
 * COUNTS. Never URLs, domains, tool arguments, page content, profile names,
 * tokens, file paths, or anything typed. Events are marked personless and ask
 * PostHog not to geolocate them.
 *
 * The browser extension sends nothing; this lives only in the npm server.
 *
 * On by default with a one-time notice on first run. Off with
 * CHROME_MCP_TELEMETRY=0 (or false/off), DO_NOT_TRACK=1, or --no-telemetry.
 * Every failure is swallowed: telemetry can never break or slow a tool call.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { join } from 'node:path';

import { TOOL_CATEGORY } from './mcp/tool-categories';

/** PostHog project key. Public by design: it can only WRITE events, never read them. */
export const POSTHOG_KEY = 'phc_CG5QX5JEkRokfUN87rZQnPa3URdLWePCZnfqW6MCyCdU';
export const POSTHOG_HOST = 'https://us.i.posthog.com';

/** How often the aggregated counts are sent while a session runs. */
const FLUSH_INTERVAL_MS = 10 * 60_000;
/**
 * The first summary goes out this long after the first call, not at the first
 * 10-minute tick: hosts that kill the server without a clean shutdown (common
 * on Windows) otherwise lose every short session's counts.
 */
const FIRST_FLUSH_MS = 60_000;
/** When to report whether a browser paired: long enough for one to dial in. */
const PAIR_CHECK_MS = 60_000;
/** Per-call MCP Analytics events are batched and sent this often. */
const MCP_FLUSH_MS = 15_000;
/** Upper bound on buffered per-call events between flushes; extra calls are only counted. */
const MCP_BUFFER_MAX = 500;
/** An MCP Analytics session ends after this long without a tool call, as PostHog's SDK does. */
const MCP_SESSION_IDLE_MS = 30 * 60_000;
/** A send never holds up the process longer than this. */
const SEND_TIMEOUT_MS = 3_000;
const STATE_FILE = 'telemetry.json';

export const TELEMETRY_NOTICE =
  'MCP Browser Extension collects anonymous usage statistics (version, OS, tool call and error counts; never URLs, ' +
  'page content or arguments) to see how it is used. Turn it off with CHROME_MCP_TELEMETRY=0 or DO_NOT_TRACK=1. ' +
  'Details: https://github.com/Mehmoodqureshi/chrome-mcp#telemetry';

interface Event {
  event: string;
  distinct_id: string;
  timestamp: string;
  properties: Record<string, unknown>;
}

export interface TelemetryOptions {
  dataDir: string;
  version: string;
  /** --no-telemetry */
  disabledByFlag?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Override the project key (tests, forks). Empty = telemetry off. */
  key?: string;
  log?: (message: string) => void;
  /** Test seam: replaces the HTTP POST. */
  send?: (events: Event[]) => Promise<void>;
  /** Live context added to each summary (role, paired browsers, pair state). */
  context?: () => Record<string, unknown>;
  /** Test seam: shortens the first-flush and pair-check delays. */
  delaysMs?: { firstFlush?: number; pairCheck?: number; mcpFlush?: number };
  /** The MCP client this session serves, as it named itself at initialize. */
  client?: () => { name?: string; version?: string } | undefined;
}

/** Whether the user has turned telemetry off, by env or flag. */
export function telemetryDisabled(env: NodeJS.ProcessEnv, disabledByFlag = false): boolean {
  if (disabledByFlag) return true;
  const own = (env.CHROME_MCP_TELEMETRY ?? '').trim().toLowerCase();
  if (['0', 'false', 'off', 'no'].includes(own)) return true;
  const dnt = (env.DO_NOT_TRACK ?? '').trim().toLowerCase();
  return dnt !== '' && dnt !== '0' && dnt !== 'false';
}

/** Pull the `[CODE]` prefix off a tool error message, if any. */
export function errorCodeOf(message: string | undefined): string {
  const m = /^\[([A-Z_]+)\]/.exec(message ?? '');
  return m ? m[1] : 'OTHER';
}

class Telemetry {
  private readonly installId: string;
  private calls = new Map<string, { calls: number; errors: number }>();
  private errorCodes = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  /** One-off timers: the early first summary and the pair check. */
  private readonly once = new Set<NodeJS.Timeout>();
  private firstFlushArmed = false;
  /** PostHog MCP Analytics: one `$mcp_tool_call` per call, buffered between flushes. */
  private mcpEvents: Event[] = [];
  private mcpTimer: NodeJS.Timeout | null = null;
  /** A random id for the current MCP Analytics session, in the shape it expects. */
  private sessionId = newSessionId();
  private lastCallAt = 0;
  /** From the initialize handshake: the negotiated MCP revision. */
  private protocolVersion: string | undefined;
  /** The model the client says is calling, from request metadata it sends on its own. */
  private llmModel: string | undefined;
  private readonly base: Record<string, unknown>;
  /** Sends still on the wire, so a quick exit doesn't cut session_started off. */
  private readonly inflight = new Set<Promise<void>>();

  constructor(private readonly opts: TelemetryOptions & { key: string }) {
    this.installId = this.loadInstallId();
    this.base = {
      version: opts.version,
      os: platform(),
      arch: arch(),
      node: process.versions.node.split('.')[0],
      // Anonymous: no person profile, no GeoIP lookup from the request IP.
      $process_person_profile: false,
      $geoip_disable: true,
    };
  }

  start(): void {
    void this.capture('session_started', this.opts.context?.() ?? {});
    this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    this.timer.unref();
    // One event per session saying whether a browser ever paired and, if not,
    // why: no extension, a stale token, a version skew, or a profile mismatch.
    this.later(this.opts.delaysMs?.pairCheck ?? PAIR_CHECK_MS, () => void this.capture('pair_check', this.opts.context?.() ?? {}));
  }

  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.once.delete(t);
      fn();
    }, ms);
    t.unref();
    this.once.add(t);
  }

  noteCall(tool: string, ok: boolean, error?: string, ms?: number): void {
    this.noteMcpCall(tool, ok, error, ms);
    if (!this.firstFlushArmed) {
      this.firstFlushArmed = true;
      this.later(this.opts.delaysMs?.firstFlush ?? FIRST_FLUSH_MS, () => void this.flush());
    }
    const c = this.calls.get(tool) ?? { calls: 0, errors: 0 };
    c.calls++;
    if (!ok) {
      c.errors++;
      const code = errorCodeOf(error);
      this.errorCodes.set(code, (this.errorCodes.get(code) ?? 0) + 1);
    }
    this.calls.set(tool, c);
  }

  /**
   * Queue the `$mcp_tool_call` event PostHog's MCP Analytics dashboard reads.
   * Only the standard fields that carry no user data: the tool, how long it
   * took, whether it failed and its error CODE, and which MCP client called.
   * Never `$mcp_parameters`, `$mcp_response` or `$mcp_error_message`: those
   * would hold URLs, selectors and page text.
   */
  private noteMcpCall(tool: string, ok: boolean, error: string | undefined, ms: number | undefined): void {
    // A long pause is a new piece of work: start a new session, so the
    // Sessions view shows real stretches of use rather than one endless one.
    const now = Date.now();
    if (this.lastCallAt && now - this.lastCallAt > MCP_SESSION_IDLE_MS) this.sessionId = newSessionId();
    this.lastCallAt = now;
    const category = TOOL_CATEGORY[tool];
    this.queueMcp(
      this.event('$mcp_tool_call', {
        ...this.mcpContext(),
        $mcp_tool_name: tool,
        $mcp_resource_name: tool,
        ...(category ? { $mcp_tool_category: category } : {}),
        ...(this.llmModel ? { $mcp_llm_model: this.llmModel, $mcp_llm_model_source: 'client_metadata' } : {}),
        ...(typeof ms === 'number' ? { $mcp_duration_ms: ms } : {}),
        $mcp_is_error: !ok,
        ...(ok ? {} : { $mcp_error_type: errorCodeOf(error) }),
      }),
    );
  }

  /** The fields every MCP Analytics event carries: which session, server and client. */
  private mcpContext(): Record<string, unknown> {
    const client = this.opts.client?.();
    return {
      $mcp_source: 'posthog_mcp_analytics',
      $session_id: this.sessionId,
      $mcp_server_name: 'mcp-browser-extension',
      $mcp_server_version: this.opts.version,
      ...(client?.name ? { $mcp_client_name: client.name } : {}),
      ...(client?.version ? { $mcp_client_version: client.version } : {}),
      ...(this.protocolVersion ? { $mcp_protocol_version: this.protocolVersion } : {}),
    };
  }

  /**
   * The client connected: record the handshake (`$mcp_initialize`) and the
   * tools we offered it (`$mcp_tools_list`, names only), so the dashboard can
   * show clients and protocol revisions, and which tools agents never call.
   */
  noteInitialize(protocolVersion: string | undefined, toolNames: string[]): void {
    this.protocolVersion = protocolVersion;
    this.queueMcp(this.event('$mcp_initialize', this.mcpContext()));
    this.queueMcp(this.event('$mcp_tools_list', { ...this.mcpContext(), $mcp_listed_tool_names: toolNames }));
  }

  /** The client named the model calling us in its request metadata. */
  noteModel(model: string | undefined): void {
    const m = typeof model === 'string' ? model.trim().slice(0, 100) : '';
    if (m && m.toLowerCase() !== 'unknown') this.llmModel = m;
  }

  private queueMcp(event: Event): void {
    if (this.mcpEvents.length >= MCP_BUFFER_MAX) return;
    this.mcpEvents.push(event);
    if (!this.mcpTimer) {
      this.mcpTimer = setTimeout(() => {
        this.mcpTimer = null;
        void this.flushMcp();
      }, this.opts.delaysMs?.mcpFlush ?? MCP_FLUSH_MS);
      this.mcpTimer.unref();
    }
  }

  private takeMcpEvents(): Event[] {
    const batch = this.mcpEvents;
    this.mcpEvents = [];
    return batch;
  }

  private async flushMcp(): Promise<void> {
    const batch = this.takeMcpEvents();
    if (batch.length > 0) await this.send(batch);
  }

  /** Send the counts gathered since the last flush (skipped when idle). */
  async flush(): Promise<void> {
    const summary = this.takeSummary();
    if (summary) await this.send([summary]);
  }

  /** The counts since the last summary as an event, resetting them; null when idle. */
  private takeSummary(): Event | null {
    if (this.calls.size === 0) return null;
    const tools = Object.fromEntries(this.calls);
    const errors = Object.fromEntries(this.errorCodes);
    let total = 0;
    let failed = 0;
    for (const c of this.calls.values()) {
      total += c.calls;
      failed += c.errors;
    }
    this.calls = new Map();
    this.errorCodes = new Map();
    return this.event('usage_summary', { ...(this.opts.context?.() ?? {}), calls: total, errors: failed, tools, error_codes: errors });
  }

  /** Last summary and session_ended in ONE request, so both fit the shutdown deadline. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const t of this.once) clearTimeout(t);
    this.once.clear();
    if (this.mcpTimer) clearTimeout(this.mcpTimer);
    this.mcpTimer = null;
    const summary = this.takeSummary();
    const final = this.send([...this.takeMcpEvents(), ...(summary ? [summary] : []), this.event('session_ended', {})]);
    // Also wait for anything already sent (session_started on a short session).
    await Promise.allSettled([...this.inflight, final]);
  }

  private capture(event: string, props: Record<string, unknown>): Promise<void> {
    return this.send([this.event(event, props)]);
  }

  private event(event: string, props: Record<string, unknown>): Event {
    return {
      event,
      distinct_id: this.installId,
      timestamp: new Date().toISOString(),
      properties: { ...this.base, ...props },
    };
  }

  private send(batch: Event[]): Promise<void> {
    const p = (async () => {
      try {
        await (this.opts.send ?? ((b) => this.post(b)))(batch);
      } catch {
        /* offline, blocked, or PostHog down — never matters to the user */
      }
    })();
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
    return p;
  }

  private async post(batch: Event[]): Promise<void> {
    await fetch(`${POSTHOG_HOST}/batch/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: this.opts.key, batch }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  }

  /** The random install id, created (with the first-run notice) on first use. */
  private loadInstallId(): string {
    const path = join(this.opts.dataDir, STATE_FILE);
    try {
      if (existsSync(path)) {
        const saved = JSON.parse(readFileSync(path, 'utf8')) as { installId?: unknown };
        if (typeof saved.installId === 'string' && saved.installId.length > 0) return saved.installId;
      }
    } catch {
      /* unreadable: start over with a new id */
    }
    const installId = randomUUID();
    this.opts.log?.(TELEMETRY_NOTICE);
    try {
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify({ installId, noticeShownAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
      renameSync(tmp, path);
    } catch {
      /* read-only data dir: a new id (and notice) next boot is harmless */
    }
    return installId;
  }
}

function newSessionId(): string {
  return `ses_${randomBytes(16).toString('hex')}`;
}

let active: Telemetry | null = null;

/** Start telemetry for this server process, unless turned off or unconfigured. */
export function initTelemetry(opts: TelemetryOptions): boolean {
  const key = opts.key ?? POSTHOG_KEY;
  if (!key || telemetryDisabled(opts.env ?? process.env, opts.disabledByFlag)) return false;
  active = new Telemetry({ ...opts, key });
  active.start();
  return true;
}

/** Record the MCP handshake and the advertised tool names. A no-op when telemetry is off. */
export function noteMcpInitialize(protocolVersion: string | undefined, toolNames: string[]): void {
  active?.noteInitialize(protocolVersion, toolNames);
}

/** Record the model a client named in its request metadata. A no-op when telemetry is off. */
export function noteMcpModel(model: string | undefined): void {
  active?.noteModel(model);
}

/** Count one tool call. A no-op when telemetry is off. */
export function noteToolCall(tool: string, ok: boolean, error?: string, ms?: number): void {
  active?.noteCall(tool, ok, error, ms);
}

/** Flush and send session_ended. Safe to call when telemetry is off. */
export async function stopTelemetry(): Promise<void> {
  const t = active;
  active = null;
  await t?.stop();
}

/** Test seam: forget the active instance. */
export function resetTelemetryForTesting(): void {
  active = null;
}
