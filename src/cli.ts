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
import { generateToken, removeHandshake, writeHandshake } from './bridge/auth';
import { logErr, startMcpServer, stopMcpServer } from './mcp/server';

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
  const token = generateToken();

  const bridge = new BridgeServer({
    token,
    serverVersion: version(),
    port: cfg.wsPort,
    onLog: (m) => logErr(m),
    onDisplacement: (d) =>
      logErr(`SECURITY: extension connection displaced (different id: ${d.differentId})`),
  });
  const port = await bridge.start();
  const handshakePath = writeHandshake(dataDir, { port, token });
  logErr(`pairing handshake written to ${handshakePath} (mode 0600; token not logged)`);

  const cleanup = (): void => {
    removeHandshake(dataDir);
  };

  // Manual pairing helper: run the bridge, print the path, keep alive. NOT MCP.
  if (cfg.printPairing) {
    process.stdout.write(`${handshakePath}\n`);
    logErr('pairing mode — bridge is up; open the extension and pair, then Ctrl-C.');
    process.on('SIGINT', () => {
      cleanup();
      void bridge.stop().finally(() => process.exit(0));
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

  const shutdown = (): void => {
    cleanup();
    void Promise.allSettled([stopMcpServer(), bridge.stop()]).finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await startMcpServer();
}

main().catch((err) => {
  logErr(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
