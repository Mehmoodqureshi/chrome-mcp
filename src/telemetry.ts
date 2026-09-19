/**
 * src/telemetry.ts — anonymous usage statistics from the chrome-mcp SERVER.
 *
 * What it sends, to PostHog: a random per-install id, the chrome-mcp version,
 * OS, CPU architecture and Node major version, whether this session owns the
 * port or shares it, how many browsers are paired, and per-tool call and error
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

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { join } from 'node:path';

/** PostHog project key. Public by design: it can only WRITE events, never read them. */
export const POSTHOG_KEY = 'phc_CG5QX5JEkRokfUN87rZQnPa3URdLWePCZnfqW6MCyCdU';
export const POSTHOG_HOST = 'https://us.i.posthog.com';

/** How often the aggregated counts are sent while a session runs. */
const FLUSH_INTERVAL_MS = 10 * 60_000;
/** A send never holds up the process longer than this. */
const SEND_TIMEOUT_MS = 3_000;
const STATE_FILE = 'telemetry.json';

export const TELEMETRY_NOTICE =
  'chrome-mcp collects anonymous usage statistics (version, OS, tool call and error counts; never URLs, ' +
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
  /** Live context added to each summary (role, paired browsers). */
  context?: () => Record<string, unknown>;
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
  }

  noteCall(tool: string, ok: boolean, error?: string): void {
    const c = this.calls.get(tool) ?? { calls: 0, errors: 0 };
    c.calls++;
    if (!ok) {
      c.errors++;
      const code = errorCodeOf(error);
      this.errorCodes.set(code, (this.errorCodes.get(code) ?? 0) + 1);
    }
    this.calls.set(tool, c);
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
    const summary = this.takeSummary();
    const final = this.send([...(summary ? [summary] : []), this.event('session_ended', {})]);
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

let active: Telemetry | null = null;

/** Start telemetry for this server process, unless turned off or unconfigured. */
export function initTelemetry(opts: TelemetryOptions): boolean {
  const key = opts.key ?? POSTHOG_KEY;
  if (!key || telemetryDisabled(opts.env ?? process.env, opts.disabledByFlag)) return false;
  active = new Telemetry({ ...opts, key });
  active.start();
  return true;
}

/** Count one tool call. A no-op when telemetry is off. */
export function noteToolCall(tool: string, ok: boolean, error?: string): void {
  active?.noteCall(tool, ok, error);
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
