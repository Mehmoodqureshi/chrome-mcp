/**
 * src/auto-update.ts — keep every install on the latest chrome-mcp.
 *
 * Most people run chrome-mcp through `npx -y @mehmoodqureshi/chrome-mcp` in an
 * MCP config. npx reuses whatever copy it cached first, so installs sat on old
 * versions for weeks (telemetry: three times as many sessions on 0.9.13 as on
 * the current 0.9.15) and never got the fixes. Nobody edits their MCP config to
 * pick up a release.
 *
 * So at startup, before binding the port, the server asks the npm registry for
 * the latest version. If it is newer than this copy, it hands off: it runs
 * `npx -y @mehmoodqureshi/chrome-mcp@<latest>` with the same arguments, passes
 * stdin/stdout/stderr straight through (the MCP host talks to the new version
 * directly), and exits when that does. The new copy's server also mirrors its
 * extension build into the unpacked folder, so the extension follows.
 *
 * It never gets in the way: a dev checkout (not under node_modules) is left
 * alone, the check gives up after a short timeout when offline, a failed spawn
 * falls back to running this copy, and the child is marked so it never hands
 * off again. Off with CHROME_MCP_AUTO_UPDATE=0 or --no-auto-update.
 */

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { sep } from 'node:path';

export const PACKAGE_NAME = '@mehmoodqureshi/chrome-mcp';
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
/** The registry answers in well under this; offline must not delay startup more. */
const CHECK_TIMEOUT_MS = 1_500;
/** Set on the handed-off child: it is already the latest, never hand off again. */
export const HANDOFF_ENV = 'CHROME_MCP_UPDATED_FROM';

export interface HandOffOptions {
  current: string;
  /** This copy's package directory: only an installed copy (under node_modules) updates. */
  packageDir: string;
  /** The CLI arguments to pass on unchanged. */
  argv: string[];
  env?: NodeJS.ProcessEnv;
  disabledByFlag?: boolean;
  log?: (message: string) => void;
  /** Test seams. */
  fetchLatest?: () => Promise<string | null>;
  spawn?: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
  platform?: NodeJS.Platform;
}

/** Whether auto-update is off, by env, flag, or because this IS the handed-off copy. */
export function autoUpdateDisabled(env: NodeJS.ProcessEnv, disabledByFlag = false): boolean {
  if (disabledByFlag || env[HANDOFF_ENV]) return true;
  const v = (env.CHROME_MCP_AUTO_UPDATE ?? '').trim().toLowerCase();
  return ['0', 'false', 'off', 'no'].includes(v);
}

/** True when `latest` is a plain release strictly newer than `current` (x.y.z). */
export function isNewer(latest: string, current: string): boolean {
  const parse = (v: string): number[] | null => {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const a = parse(latest);
  const b = parse(current);
  if (!a || !b) return false; // a prerelease or a local build never triggers a hand-off
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** An installed copy (npx cache or a global install), not a git checkout. */
export function isInstalledCopy(packageDir: string): boolean {
  return packageDir.split(sep).includes('node_modules');
}

async function fetchLatestFromRegistry(): Promise<string | null> {
  try {
    const res = await fetch(REGISTRY_URL, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === 'string' ? body.version : null;
  } catch {
    return null; // offline, slow, or blocked: run this copy
  }
}

/** Quote one argument for cmd.exe (Windows runs npx through a shell). */
function winQuote(arg: string): string {
  return /^[A-Za-z0-9_\-./:=@\\]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`;
}

/**
 * Hand off to a newer published version when there is one. Resolves with the
 * exit code to leave with once the newer copy has exited, or null to carry on
 * starting THIS copy (up to date, disabled, offline, or the spawn failed).
 */
export async function maybeHandOff(opts: HandOffOptions): Promise<number | null> {
  const env = opts.env ?? process.env;
  if (autoUpdateDisabled(env, opts.disabledByFlag)) return null;
  if (!isInstalledCopy(opts.packageDir)) return null;

  const latest = await (opts.fetchLatest ?? fetchLatestFromRegistry)();
  if (!latest || !isNewer(latest, opts.current)) return null;

  const platform = opts.platform ?? process.platform;
  const win = platform === 'win32';
  // Pin the exact version: a registry that briefly lags must not bounce us
  // back to an older copy.
  const args = ['-y', `${PACKAGE_NAME}@${latest}`, ...opts.argv];
  const spawn = opts.spawn ?? nodeSpawn;
  opts.log?.(`chrome-mcp ${latest} is available (this copy is ${opts.current}) — starting it now`);

  let child: ChildProcess;
  try {
    child = win
      ? // Node only runs .cmd shims through a shell, which then needs the quoting.
        spawn('npx.cmd', args.map(winQuote), { stdio: 'inherit', env: { ...env, [HANDOFF_ENV]: opts.current }, shell: true })
      : spawn('npx', args, { stdio: 'inherit', env: { ...env, [HANDOFF_ENV]: opts.current } });
  } catch (err) {
    opts.log?.(`could not start chrome-mcp ${latest} (${err instanceof Error ? err.message : String(err)}); running ${opts.current}`);
    return null;
  }

  return new Promise<number | null>((resolve) => {
    let started = false;
    const forward = (signal: NodeJS.Signals): void => {
      try {
        child.kill(signal);
      } catch {
        /* already gone */
      }
    };
    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const cleanup = (): void => {
      for (const s of signals) process.off(s, forward);
    };
    child.once('spawn', () => {
      started = true;
      for (const s of signals) process.on(s, forward);
    });
    child.once('error', (err) => {
      cleanup();
      // npx missing or not runnable: nothing has touched stdin yet, so this copy
      // can still serve the session.
      if (!started) {
        opts.log?.(`could not start chrome-mcp ${latest} (${err.message}); running ${opts.current}`);
        resolve(null);
      } else {
        resolve(1);
      }
    });
    child.once('exit', (code, signal) => {
      cleanup();
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}
