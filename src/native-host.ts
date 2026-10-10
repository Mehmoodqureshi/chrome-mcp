/**
 * src/native-host.ts — one-click pairing through Chrome native messaging.
 *
 * Pairing used to mean copying a port and a token out of handshake.json into
 * the extension's Options page; a store install had no other way in. Now the
 * server registers a tiny native messaging host with Chrome (and Brave, Edge,
 * Chromium, Arc) on every start. The extension's Connect button asks it for the
 * pairing, and Chrome only lets our own extension id talk to it — a web page or
 * another extension cannot. The host itself just reads handshake.json, which
 * any process of the same user could read anyway, so nothing is exposed that
 * was not already.
 *
 * Two halves live here:
 *   - `registerNativeHost()`: the server writes the host's launcher script and
 *     its manifest into each installed browser's NativeMessagingHosts folder
 *     (the registry on Windows). Best-effort and idempotent.
 *   - `runNativeHost()`: what `chrome-mcp --native-host` runs when Chrome starts
 *     the host: read one message, answer with the pairing, exit.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { STORE_EXTENSION_ID } from '../shared/protocol';

/** The host's name, as the extension addresses it. */
export const NATIVE_HOST_NAME = 'com.mehmoodqureshi.mcp_browser_extension';

export interface NativeHostPaths {
  /** Where the launcher script and the host manifest are written. */
  dir: string;
  launcher: string;
  manifest: string;
}

export function nativeHostPaths(dataDir: string, platform: NodeJS.Platform = process.platform): NativeHostPaths {
  const dir = join(dataDir, 'native-host');
  return {
    dir,
    launcher: join(dir, platform === 'win32' ? 'host.bat' : 'host.sh'),
    manifest: join(dir, `${NATIVE_HOST_NAME}.json`),
  };
}

/** Each Chromium browser's per-user NativeMessagingHosts folder (macOS, Linux). */
export function browserHostDirs(platform: NodeJS.Platform = process.platform, home = homedir()): string[] {
  if (platform === 'darwin') {
    const base = join(home, 'Library', 'Application Support');
    return [
      'Google/Chrome',
      'Google/Chrome Beta',
      'Google/Chrome Dev',
      'Google/Chrome Canary',
      'Chromium',
      'BraveSoftware/Brave-Browser',
      'Microsoft Edge',
      'Arc/User Data',
      'Vivaldi',
    ].map((b) => join(base, b, 'NativeMessagingHosts'));
  }
  if (platform === 'linux') {
    const base = join(home, '.config');
    return [
      'google-chrome',
      'google-chrome-beta',
      'google-chrome-unstable',
      'chromium',
      'BraveSoftware/Brave-Browser',
      'microsoft-edge',
      'vivaldi',
    ].map((b) => join(base, b, 'NativeMessagingHosts'));
  }
  return [];
}

/** Each Chromium browser's per-user registry key for native hosts (Windows). */
export const WINDOWS_HOST_KEYS = [
  'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts',
  'HKCU\\Software\\Chromium\\NativeMessagingHosts',
  'HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts',
  'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts',
];

export interface RegisterOptions {
  dataDir: string;
  /** The node binary and the CLI entry the launcher runs (this very process's). */
  nodePath?: string;
  cliPath: string;
  /** The server's --profile when it is not "default": a fresh extension pairs under it. */
  profile?: string;
  platform?: NodeJS.Platform;
  home?: string;
  log?: (message: string) => void;
  /** Test seam for the Windows registry writes. */
  runReg?: (args: string[]) => Promise<void>;
}

/**
 * Write the launcher and the host manifest, then point every installed browser
 * at it. Rewritten on every start, so the launcher always runs the newest
 * server (npx moves each version to a new folder). Returns the browsers it
 * registered with; never throws.
 */
export async function registerNativeHost(opts: RegisterOptions): Promise<string[]> {
  const platform = opts.platform ?? process.platform;
  const paths = nativeHostPaths(opts.dataDir, platform);
  const node = opts.nodePath ?? process.execPath;
  const registered: string[] = [];
  try {
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    const extra = [`--data-dir`, opts.dataDir, ...(opts.profile ? ['--profile', opts.profile] : [])];
    if (platform === 'win32') {
      writeFileSync(paths.launcher, `@echo off\r\n"${node}" "${opts.cliPath}" --native-host ${extra.map((a) => `"${a}"`).join(' ')} %*\r\n`);
    } else {
      const q = (a: string): string => `'${a.replace(/'/g, `'\\''`)}'`;
      writeFileSync(paths.launcher, `#!/bin/sh\nexec ${q(node)} ${q(opts.cliPath)} --native-host ${extra.map(q).join(' ')} "$@"\n`);
      chmodSync(paths.launcher, 0o700);
    }
    const manifest = {
      name: NATIVE_HOST_NAME,
      description: 'MCP Browser Extension: hands the extension its pairing (port and token) on one click',
      path: paths.launcher,
      type: 'stdio',
      // Only our extension. Unpacked copies carry the store key, so they share this id.
      allowed_origins: [`chrome-extension://${STORE_EXTENSION_ID}/`],
    };
    const body = `${JSON.stringify(manifest, null, 2)}\n`;
    writeFileSync(paths.manifest, body);

    if (platform === 'win32') {
      const reg =
        opts.runReg ??
        ((args: string[]) =>
          new Promise<void>((resolve, reject) => execFile('reg', args, { windowsHide: true }, (err) => (err ? reject(err) : resolve()))));
      for (const key of WINDOWS_HOST_KEYS) {
        try {
          await reg(['add', `${key}\\${NATIVE_HOST_NAME}`, '/ve', '/t', 'REG_SZ', '/d', paths.manifest, '/f']);
          registered.push(key);
        } catch {
          /* that browser's key could not be written; the others still work */
        }
      }
    } else {
      for (const dir of browserHostDirs(platform, opts.home)) {
        // Only browsers that are installed: their profile folder already exists.
        if (!existsSync(dirname(dir))) continue;
        try {
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, `${NATIVE_HOST_NAME}.json`), body);
          registered.push(dir);
        } catch {
          /* read-only or odd profile folder: skip it */
        }
      }
    }
  } catch (err) {
    opts.log?.(`one-click pairing helper not registered: ${err instanceof Error ? err.message : String(err)}`);
  }
  return registered;
}

/** What the host answers: the pairing, or why there is none. */
export type NativeReply =
  | { ok: true; port: number; token: string; profile?: string }
  | { ok: false; error: 'not_running' | 'bad_request'; message: string };

/** Build the reply from the data dir: the live handshake, if a server is up. */
export function pairingReply(dataDir: string, profile?: string): NativeReply {
  try {
    const h = JSON.parse(readFileSync(join(dataDir, 'handshake.json'), 'utf8')) as { port?: unknown; token?: unknown; pid?: unknown };
    if (typeof h.port !== 'number' || typeof h.token !== 'string') throw new Error('incomplete');
    // A handshake left behind by a server that died is not a pairing.
    if (typeof h.pid === 'number') {
      try {
        process.kill(h.pid, 0);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ESRCH') throw new Error('stale');
      }
    }
    return { ok: true, port: h.port, token: h.token, ...(profile ? { profile } : {}) };
  } catch {
    return {
      ok: false,
      error: 'not_running',
      message: 'The MCP Browser Extension server is not running. Start your AI client (it starts the server), then click Connect again.',
    };
  }
}

/** Frame one native message: a 4-byte little-endian length, then UTF-8 JSON. */
export function frameMessage(msg: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

/**
 * Run as the native host: read one framed message from stdin, answer it on
 * stdout, exit. Chrome starts a fresh host per sendNativeMessage call.
 */
export function runNativeHost(dataDir: string, profile?: string): void {
  const chunks: Buffer[] = [];
  let answered = false;
  const answer = (reply: NativeReply): void => {
    if (answered) return;
    answered = true;
    process.stdout.write(frameMessage(reply), () => process.exit(0));
  };
  process.stdin.on('data', (c: Buffer) => {
    chunks.push(c);
    const buf = Buffer.concat(chunks);
    if (buf.length < 4) return;
    const len = buf.readUInt32LE(0);
    if (len > 64 * 1024) return answer({ ok: false, error: 'bad_request', message: 'message too large' });
    if (buf.length < 4 + len) return;
    let msg: { type?: unknown } = {};
    try {
      msg = JSON.parse(buf.subarray(4, 4 + len).toString('utf8')) as { type?: unknown };
    } catch {
      return answer({ ok: false, error: 'bad_request', message: 'not JSON' });
    }
    if (msg.type !== 'pairing') return answer({ ok: false, error: 'bad_request', message: 'unknown request' });
    answer(pairingReply(dataDir, profile));
  });
  process.stdin.on('end', () => answer({ ok: false, error: 'bad_request', message: 'no request' }));
}
