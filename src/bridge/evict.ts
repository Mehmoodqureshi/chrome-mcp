/**
 * src/bridge/evict.ts — take a pinned port back from a stale chrome-mcp.
 *
 * The extension dials exactly ONE bridge port, so only one server can own a
 * given Chrome at a time. But every MCP host session spawns its own chrome-mcp
 * child, so a second session (another Claude tab/window) racing for a pinned
 * `--port` would otherwise just fail with EADDRINUSE and force the user to kill
 * the old process by hand. Newest-session-wins: we do that kill for them.
 *
 * The safety bar is high, because a pid can be recycled onto an unrelated
 * process. We evict ONLY when every check agrees:
 *   - the handshake names that port (so it describes *this* listener), and
 *   - the pid is not us, and
 *   - the pid is alive, and
 *   - its command line mentions chrome-mcp.
 * If any check fails we leave the process alone and let the caller surface the
 * plain-English port-busy error instead. Refusing to evict is always safe; a
 * wrong kill is not.
 */

import { execFileSync } from 'node:child_process';

import { readHandshake } from './auth';

/** How long to let a SIGTERM'd owner exit before escalating to SIGKILL. */
const EXIT_WAIT_MS = 3_000;
const POLL_MS = 100;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Whether `pid` exists. Signal 0 checks liveness without delivering anything. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to another user — alive, just not ours.
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/**
 * Full command line of `pid`, or null if it can't be read.
 *
 * Windows needs PowerShell/CIM: `tasklist` reports only the image name
 * ("node.exe"), which can't distinguish chrome-mcp from any other Node process
 * — far too weak a signal to kill on.
 */
function commandLine(pid: number): string | null {
  const [cmd, args] =
    process.platform === 'win32'
      ? [
          'powershell.exe',
          [
            '-NoProfile',
            '-Command',
            `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
          ],
        ]
      : ['ps', ['-p', String(pid), '-o', 'command=']];
  try {
    const out = execFileSync(cmd, args as string[], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/** Does this command line belong to a chrome-mcp server? */
export function looksLikeChromeMcp(cmdline: string): boolean {
  return /chrome-mcp/i.test(cmdline);
}

export interface EvictDeps {
  /** Injectable for tests; defaults to the real probes. */
  isAlive?: (pid: number) => boolean;
  commandLine?: (pid: number) => string | null;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
}

/**
 * Try to free `port` by terminating the chrome-mcp that owns it.
 * Returns true only if an owner was found, killed, and confirmed gone.
 */
export async function evictPortOwner(
  dataDir: string,
  port: number,
  log: (message: string) => void,
  deps: EvictDeps = {},
): Promise<boolean> {
  const alive = deps.isAlive ?? isAlive;
  const cmdOf = deps.commandLine ?? commandLine;
  const kill = deps.kill ?? ((pid, sig) => process.kill(pid, sig));

  let pid: number;
  let hsPort: number;
  try {
    const hs = readHandshake(dataDir);
    pid = Number(hs?.pid);
    hsPort = Number(hs?.port);
  } catch {
    return false; // no handshake (clean shutdown) or unreadable — nothing to evict
  }

  if (!Number.isInteger(pid) || pid <= 0) return false;
  // The handshake describes a different listener; it says nothing about ours.
  if (hsPort !== port) return false;
  if (pid === process.pid) return false;
  if (!alive(pid)) return false;

  const cmdline = cmdOf(pid);
  if (!cmdline || !looksLikeChromeMcp(cmdline)) {
    log(
      `port ${port} is held by pid ${pid}, which does not look like chrome-mcp — ` +
        `leaving it alone. Stop it yourself, or use a different --port.`,
    );
    return false;
  }

  log(`port ${port} is held by chrome-mcp pid ${pid} (another session) — taking the port over`);
  try {
    kill(pid, 'SIGTERM');
  } catch {
    return false; // vanished or not ours to signal
  }

  const deadline = Date.now() + EXIT_WAIT_MS;
  while (Date.now() < deadline) {
    if (!alive(pid)) {
      log(`previous owner (pid ${pid}) exited; reclaiming port ${port}`);
      return true;
    }
    await delay(POLL_MS);
  }

  // Wouldn't go quietly.
  try {
    kill(pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
  const gone = !alive(pid);
  if (gone) log(`previous owner (pid ${pid}) force-killed; reclaiming port ${port}`);
  return gone;
}
