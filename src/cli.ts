#!/usr/bin/env node
/**
 * src/cli.ts — `npx chrome-mcp` entrypoint.
 *
 * Boot order: resolve config → ensure data dir → generate a per-boot token →
 * start the loopback bridge → write the 0600 handshake → configure the manager
 * with the backend selector → serve MCP over stdio. `--help`/`--version` print
 * and exit before stdio is claimed; `--print-pairing` runs only the bridge and
 * prints the handshake path (for manual pairing), never serving MCP.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { HELP_TEXT, parseArgs } from './config';
import { configureManager } from './executor/manager';
import { createSelector } from './executor/select';
import { BridgeServer } from './bridge/server';
import { ensureDataDir } from './bridge/datadir';
import { removeHandshake, resolveToken, writeHandshake } from './bridge/auth';
import { logErr, startMcpServer, stopMcpServer } from './mcp/server';

/** Hard deadline for clean shutdown before we force-exit (a stuck socket must not hang us). */
const SHUTDOWN_DEADLINE_MS = 3000;

/**
 * Race a best-effort shutdown against a hard deadline, then exit. The timer is
 * unref'd so it never itself keeps the process alive; if it fires first we log a
 * brief note that clean shutdown did not complete in time.
 */
function exitWithDeadline(work: Promise<unknown>): void {
  let timer: NodeJS.Timeout;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), SHUTDOWN_DEADLINE_MS);
    timer.unref();
  });
  void Promise.race([work.then(() => 'clean' as const), deadline]).then((outcome) => {
    clearTimeout(timer);
    if (outcome === 'timeout') {
      logErr(`shutdown deadline (${SHUTDOWN_DEADLINE_MS}ms) hit before clean shutdown; forcing exit.`);
    }
    process.exit(0);
  });
}

function version(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function main(): Promise<void> {
  const cfg = parseArgs(process.argv.slice(2));

  if (cfg.showHelp) {
    process.stdout.write(HELP_TEXT);
    return;
  }
  if (cfg.showVersion) {
    process.stdout.write(`${version()}\n`);
    return;
  }

  const dataDir = ensureDataDir(cfg.dataDir);
  const token = resolveToken(dataDir, { persist: cfg.persistToken });

  const { allowDomains, allowEval, allowDownloads, allowUploads, allowAllTabs, enableMutations } = cfg.policy;
  const bridge = new BridgeServer({
    token,
    serverVersion: version(),
    // Wire-serializable policy subset (no local uploadsDir) so the extension mirrors the gate.
    policy: { allowDomains, allowEval, allowDownloads, allowUploads, allowAllTabs, enableMutations },
    port: cfg.wsPort,
    onLog: (m) => logErr(m),
    onDisplacement: (d) =>
      logErr(`SECURITY: extension connection displaced (different id: ${d.differentId})`),
  });
  const port = await bridge.start();
  const handshakePath = writeHandshake(dataDir, { port, token });
  logErr(`pairing handshake written to ${handshakePath} (mode 0600; token not logged)`);
  if (process.env.CHROME_MCP_TOKEN) {
    logErr('token: pinned from CHROME_MCP_TOKEN (stable; pair once, never again).');
  } else if (cfg.persistToken) {
    logErr('token: persisted across restarts (--persist-token; pair once, never again).');
  }

  const cleanup = (): void => {
    removeHandshake(dataDir);
  };

  // Manual pairing helper: run the bridge, print the path, keep alive. NOT MCP.
  if (cfg.printPairing) {
    process.stdout.write(`${handshakePath}\n`);
    logErr('pairing mode — bridge is up; open the extension and pair, then Ctrl-C.');
    process.on('SIGINT', () => {
      cleanup();
      exitWithDeadline(bridge.stop());
    });
    return;
  }

  configureManager({
    policy: cfg.policy,
    select: createSelector({
      bridge,
      cdpFallback: cfg.cdpFallback,
      prefer: cfg.prefer,
      cdp: {
        mode: cfg.cdpEndpoint ? 'connect' : 'launch',
        cdpEndpoint: cfg.cdpEndpoint,
        userDataDir: dataDir,
        headless: cfg.headless,
      },
    }),
  });
  logErr(`backend: extension-if-paired else ${cfg.cdpFallback ? 'CDP fallback' : 'none'} (prefer: ${cfg.prefer})`);

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    cleanup();
    exitWithDeadline(Promise.allSettled([stopMcpServer(), bridge.stop()]));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // The MCP host owns our stdin. When it disconnects (host quit, or a
  // "Reconnect" that spawns a fresh child), stdin reaches EOF — that's our cue
  // to exit and release the port, so a stale process never lingers and blocks
  // the next connection. This is what makes reconnects "just work".
  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);

  await startMcpServer(version());
}

main().catch((err) => {
  // Port-busy and similar startup failures carry a plain-English message already;
  // show that to the user without a noisy stack trace.
  const friendly = err instanceof Error && /Couldn't start:/.test(err.message);
  logErr(friendly ? err.message : `fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
