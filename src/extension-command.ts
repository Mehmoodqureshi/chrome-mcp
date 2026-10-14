import { join, resolve } from 'node:path';
import { resolveDataDir } from './config';
import { inspectExtensionProfiles, repairExtensionProfiles, type ExtensionScan } from './extension-repair';

const HELP = `chrome-mcp extension — diagnose an extension missing after a browser restart.

  chrome-mcp extension doctor [--json] [--user-data-dir <browser directory>]
  chrome-mcp extension repair [--apply] [--json] [--user-data-dir <browser directory>]
                             [--data-dir <backup parent>]

doctor is read-only and reports the actual Store/unpacked registration.
repair previews confirmed stale-ID conflicts. --apply requires every Chromium
browser to be fully closed, backs up preferences, then removes only obsolete
registrations that conflict with a valid current copy in the same folder.
It does not reinstall extensions, reset profiles, or change pairing data.
`;

function printScan(scan: ExtensionScan): void {
  for (const p of scan.profiles) {
    process.stdout.write(`${p.profileDir}\n`);
    for (const r of p.registrations) process.stdout.write(`  ${r.source}: ${r.id}\n    ${r.path}\n`);
    for (const issue of p.issues) process.stdout.write(`  ${issue}\n`);
    if (!p.issues.length) process.stdout.write('  No registration or file problem found.\n');
  }
  for (const error of scan.errors) process.stderr.write(`${error}\n`);
  if (!scan.profiles.length) process.stdout.write('No matching extension registrations found in the inspected browser directories. Use --user-data-dir for a custom browser directory.\n');
}

export function runExtensionCommand(argv: string[]): boolean {
  if (argv[0] !== 'extension') return false;
  const sub = argv[1];
  if (!sub || sub === '--help' || sub === 'help') {
    process.stdout.write(HELP);
    return true;
  }
  try {
    if (sub !== 'doctor' && sub !== 'repair') throw new Error(`Unknown extension command: ${sub}`);
    let json = false;
    let apply = false;
    let roots: string[] | undefined;
    let dataDir = resolveDataDir();
    for (let i = 2; i < argv.length; i++) {
      const arg = argv[i];
      if (arg === '--json') json = true;
      else if (arg === '--apply' && sub === 'repair') apply = true;
      else if (arg === '--user-data-dir' || arg === '--data-dir') {
        const value = argv[++i];
        if (!value || value.startsWith('--')) throw new Error(`${arg} needs a directory`);
        if (arg === '--user-data-dir') roots = [resolve(value)];
        else dataDir = resolve(value);
      } else throw new Error(`Unknown option: ${arg}`);
    }
    if (sub === 'doctor') {
      const scan = inspectExtensionProfiles(roots);
      if (json) process.stdout.write(`${JSON.stringify(scan, null, 2)}\n`);
      else printScan(scan);
      if (scan.errors.length) process.exitCode = 1;
    } else {
      const result = repairExtensionProfiles({ roots, apply, backupDir: join(dataDir, 'extension-repair-backups') });
      if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else {
        printScan(result.scan);
        const count = result.scan.profiles.reduce((n, p) => n + p.staleIds.length, 0);
        if (result.applied) process.stdout.write(`Removed ${result.removed.length} obsolete registration(s). Backup: ${result.backup}\nReopen your browser and check chrome://extensions.\n`);
        else if (count) process.stdout.write(`Preview: ${count} obsolete registration(s) can be removed. Fully quit Chromium browsers, then repeat with --apply.\n`);
        else process.stdout.write('No confirmed stale-ID conflict to repair. Nothing changed.\n');
      }
      if (result.scan.errors.length) process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`extension ${sub}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
  return true;
}
