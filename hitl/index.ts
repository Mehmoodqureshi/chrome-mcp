/**
 * test/hitl/index.ts — entry for the human-in-the-loop harness.
 *
 *   npm run test:hitl                 # read-only scenarios
 *   npm run test:hitl -- --include-mutating [--targets path] [--headless]
 *
 * Targets come from a JSON file (default test-targets.json, else the committed
 * example). Mutating scenarios are gated by --include-mutating + a typed "yes".
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { runHitl } from './runner';
import type { RunOptions, Targets } from './types';

function loadTargets(path?: string): Targets {
  const candidates = [path, join(process.cwd(), 'test-targets.json'), join(process.cwd(), 'test-targets.example.json')].filter(
    (p): p is string => !!p,
  );
  for (const c of candidates) {
    if (existsSync(c)) return JSON.parse(readFileSync(c, 'utf8')) as Targets;
  }
  throw new Error('no test-targets.json (or example) found');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const opts: RunOptions = {
    includeMutating: argv.includes('--include-mutating'),
    headless: argv.includes('--headless'),
  };
  const tIdx = argv.indexOf('--targets');
  const targets = loadTargets(tIdx >= 0 ? argv[tIdx + 1] : undefined);

  process.stdout.write(`HITL: ${targets.baseUrl}  (mutating: ${opts.includeMutating ? 'on' : 'off'})\n`);
  const outcomes = await runHitl(targets, opts);

  process.stdout.write('\n=== HITL report ===\n');
  for (const o of outcomes) process.stdout.write(`  ${o.status.toUpperCase().padEnd(5)} ${o.name} — ${o.note}\n`);
  const failed = outcomes.filter((o) => o.status === 'fail' || o.status === 'error').length;
  process.stdout.write(`\n${outcomes.length} scenarios, ${failed} failed/errored.\n`);
  process.exit(failed > 0 ? 1 : 0);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`hitl fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
