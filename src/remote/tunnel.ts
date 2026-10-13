/**
 * src/remote/tunnel.ts — a public https URL for the local HTTP endpoint, via a
 * Cloudflare quick tunnel (`cloudflared tunnel --url ...`).
 *
 * Free and accountless; the trade-off is a new random *.trycloudflare.com host
 * on every start. cloudflared is not bundled: when it is missing, the error says
 * how to install it.
 */

import { spawn, type ChildProcess } from 'node:child_process';

// `api.trycloudflare.com` is Cloudflare's own endpoint, named in cloudflared's
// error lines ("failed to request quick Tunnel: Post https://api.trycloudflare.com/...");
// it is never the tunnel. Real quick-tunnel hosts are several hyphenated words.
const URL_PATTERN = /https:\/\/(?!api\.)[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com/;
const QUICK_TUNNEL_FAILED = /failed to request quick Tunnel[^\n]*/;
const START_TIMEOUT_MS = 45_000;
/** Attempts before giving up: the free quick-tunnel service often times out once. */
const ATTEMPTS = 3;

export interface Tunnel {
  url: string;
  stop(): void;
}

export function installHint(): string {
  switch (process.platform) {
    case 'darwin':
      return 'Install it with: brew install cloudflared';
    case 'win32':
      return 'Install it with: winget install --id Cloudflare.cloudflared';
    default:
      return 'Install it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/';
  }
}

/** Pull the public URL out of cloudflared's log output, if this chunk has it. */
export function findTunnelUrl(text: string): string | null {
  return URL_PATTERN.exec(text)?.[0] ?? null;
}

function startOnce(opts: {
  localPort: number;
  bin?: string;
  log: (message: string) => void;
  onExit?: (code: number | null) => void;
}): Promise<Tunnel> {
  const bin = opts.bin ?? 'cloudflared';
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${opts.localPort}`], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(err);
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error("Couldn't start: cloudflared did not report a tunnel URL in time. Check your internet connection."));
    }, START_TIMEOUT_MS);

    const scan = (chunk: Buffer): void => {
      if (settled) return;
      const text = chunk.toString('utf8');
      const failed = QUICK_TUNNEL_FAILED.exec(text);
      if (failed) {
        settled = true;
        clearTimeout(timer);
        child.kill();
        reject(new Error(`Cloudflare's quick-tunnel service did not answer (${failed[0]})`));
        return;
      }
      const url = findTunnelUrl(text);
      if (!url) return;
      settled = true;
      clearTimeout(timer);
      resolve({ url, stop: () => child.kill() });
    };
    child.stdout?.on('data', scan);
    child.stderr?.on('data', scan);

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return opts.log(`tunnel error: ${err.message}`);
      settled = true;
      clearTimeout(timer);
      reject(
        err.code === 'ENOENT'
          ? new Error(`Couldn't start: --tunnel needs cloudflared, which is not installed. ${installHint()}`)
          : err,
      );
    });
    child.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Couldn't start: cloudflared exited (code ${code}) before the tunnel came up.`));
        return;
      }
      opts.onExit?.(code);
    });
  });
}

/** Open a quick tunnel, retrying when Cloudflare's free service is slow to answer. */
export async function startQuickTunnel(opts: Parameters<typeof startOnce>[0]): Promise<Tunnel> {
  let last: unknown;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      return await startOnce(opts);
    } catch (err) {
      last = err;
      // Not installed is not going to fix itself.
      if (err instanceof Error && /not installed/.test(err.message)) throw err;
      if (attempt < ATTEMPTS) {
        opts.log(`tunnel attempt ${attempt} failed: ${err instanceof Error ? err.message : String(err)}; retrying`);
        await new Promise((r) => setTimeout(r, 3_000 * attempt));
      }
    }
  }
  const why = last instanceof Error ? last.message : String(last);
  throw new Error(
    `Couldn't start: no tunnel after ${ATTEMPTS} tries. ${why}. Cloudflare's free quick tunnels are sometimes down; try again in a few minutes.`,
  );
}
