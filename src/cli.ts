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

import { HELP_TEXT, parseArgs, resolveDataDir } from './config';
import { type GcOptions, gcTasks, listTasks } from './bridge/tasks';
import { configureManager } from './executor/manager';
import { createSelector } from './executor/select';
import { BridgeServer } from './bridge/server';
import { ensureDataDir, ensureWorkspace, migrateLegacyLayout } from './bridge/datadir';
import { setActiveWorkspace } from './bridge/workspace';
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

/** Render a byte count as a short human string (1.2 MB, 904 KB, …). */
function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

/** Pull `--flag value` / `--flag` out of an arg list, leaving positionals. */
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  return args[i + 1];
}
function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

const TASKS_HELP = `chrome-mcp tasks — inspect and prune per-profile task workspaces.

Usage:
  chrome-mcp tasks list [--json] [--data-dir <path>]
  chrome-mcp tasks gc   [--older-than <days>] [--keep <n>] [--profile <name>]
                        [--dry-run] [--data-dir <path>]

gc removes a task only when it is NOT among the newest --keep AND is older than
--older-than. At least one of --older-than / --keep is required.
`;

/**
 * Handle the `tasks` subcommand family (list / gc). Returns true if argv was a
 * tasks command (so main() should not start the server), false otherwise.
 */
function runTasksCommand(argv: string[]): boolean {
  if (argv[0] !== 'tasks') return false;
  const args = argv.slice(1);
  const sub = args[0];

  const dataDirFlag = flag(args, '--data-dir');
  if (dataDirFlag) process.env.CHROME_MCP_DATA = dataDirFlag;
  const dataDir = resolveDataDir();

  if (sub === 'list') {
    const tasks = listTasks(dataDir);
    if (hasFlag(args, '--json')) {
      process.stdout.write(`${JSON.stringify(tasks, null, 2)}\n`);
      return true;
    }
    if (tasks.length === 0) {
      process.stdout.write('no tasks found.\n');
      return true;
    }
    process.stdout.write('PROFILE\tTASK\tCREATED\tFILES\tSIZE\n');
    for (const t of tasks) {
      process.stdout.write(`${t.profile}\t${t.task}\t${t.createdAt}\t${t.downloads}\t${humanBytes(t.bytes)}\n`);
    }
    return true;
  }

  if (sub === 'gc') {
    const olderThan = flag(args, '--older-than');
    const keep = flag(args, '--keep');
    if (olderThan === undefined && keep === undefined) {
      process.stderr.write('tasks gc: pass --older-than <days> and/or --keep <n>.\n');
      process.exitCode = 1;
      return true;
    }
    const opts: GcOptions = {
      olderThanDays: olderThan === undefined ? undefined : Number.parseFloat(olderThan),
      keep: keep === undefined ? undefined : Number.parseInt(keep, 10),
      profile: flag(args, '--profile'),
      dryRun: hasFlag(args, '--dry-run'),
    };
    const { removed, freedBytes } = gcTasks(dataDir, opts, Date.now());
    const prefix = opts.dryRun ? '[dry-run] would remove' : 'removed';
    process.stdout.write(`${prefix} ${removed.length} task(s), ${humanBytes(freedBytes)}\n`);
    for (const t of removed) {
      process.stdout.write(`  ${t.profile}/${t.task} (${humanBytes(t.bytes)})\n`);
    }
    return true;
  }

  process.stdout.write(TASKS_HELP);
  return true;
}

async function main(): Promise<void> {
  if (runTasksCommand(process.argv.slice(2))) return;

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
    dataDir,
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

  // Each profile is an identity (its own Chrome user-data dir); each task is a
  // run whose downloads/meta.json live under it. Handshake stays at the data-dir
  // root (auth is machine-scoped, not per-profile). Fold any pre-0.6 flat layout
  // into profiles/default/ first — before ensureWorkspace creates the targets.
  for (const m of migrateLegacyLayout(dataDir)) logErr(`migrated legacy layout: ${m}`);
  const workspace = ensureWorkspace(dataDir, cfg.profile, cfg.task, {
    version: version(),
    pid: process.pid,
    createdAt: new Date().toISOString(),
  });
  setActiveWorkspace(workspace);
  logErr(`workspace: profile "${workspace.profile}" task "${workspace.task}" → ${workspace.taskDir}`);

  configureManager({
    policy: cfg.policy,
    select: createSelector({
      bridge,
      cdpFallback: cfg.cdpFallback,
      prefer: cfg.prefer,
      cdp: {
        mode: cfg.cdpEndpoint ? 'connect' : 'launch',
        cdpEndpoint: cfg.cdpEndpoint,
        userDataDir: workspace.profileDir,
        downloadDir: workspace.downloadDir,
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
