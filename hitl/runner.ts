/**
 * test/hitl/runner.ts — drives scenarios against a real (headed) Chromium via
 * the CDP fallback, going through the MCP tool dispatch so the security policy
 * applies. Read scenarios run freely; mutating ones are gated by `decideScenario`
 * and an interactive "yes" confirmation, then verdicted by the operator.
 */

import { createInterface } from 'node:readline/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { configureManager, getManager } from '../src/executor/manager';
import { CdpExecutor } from '../src/executor/cdp-executor';
import { dispatchToolCall } from '../src/mcp/tools';
import { resolvePolicy } from '../src/security/policy';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { decideScenario } from './gating';
import { defaultScenarios } from './scenarios';
import type { RunOptions, Targets } from './types';

interface Outcome {
  name: string;
  status: 'pass' | 'fail' | 'skip' | 'error';
  note: string;
}

function summarize(r: CallToolResult): string {
  const block = r.content.find((c) => c.type === 'text');
  const text = block && block.type === 'text' ? block.text : '(image)';
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

export async function runHitl(targets: Targets, opts: RunOptions): Promise<Outcome[]> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const outcomes: Outcome[] = [];

  const policy = resolvePolicy({
    allowDomains: targets.allowDomains,
    enableMutations: true, // authorized test run
    allowDownloads: true,
    allowEval: false,
  });

  const userDataDir = mkdtempSync(join(tmpdir(), 'cmcp-hitl-'));
  configureManager({
    policy,
    makeExecutor: () => new CdpExecutor({ mode: 'launch', userDataDir, headless: opts.headless }),
  });

  try {
    process.stdout.write(`\nNavigating to ${targets.baseUrl} …\n`);
    const nav = await dispatchToolCall('navigate', { url: targets.baseUrl });
    if (nav.isError) {
      outcomes.push({ name: 'navigate', status: 'error', note: summarize(nav) });
      return outcomes;
    }

    for (const scn of defaultScenarios(targets)) {
      const decision = decideScenario(scn, opts);
      if (!decision.eligible) {
        outcomes.push({ name: scn.name, status: 'skip', note: decision.reason });
        process.stdout.write(`SKIP  ${scn.name} — ${decision.reason}\n`);
        continue;
      }
      if (decision.requiresConfirm) {
        const ans = (await rl.question(`Run mutating "${scn.name}" (${scn.description})? type "yes": `)).trim();
        if (ans !== 'yes') {
          outcomes.push({ name: scn.name, status: 'skip', note: 'declined at prompt' });
          continue;
        }
      }

      const res = await dispatchToolCall(scn.tool, scn.args);
      process.stdout.write(`\n── ${scn.name} ${res.isError ? '(isError)' : ''}\n${summarize(res)}\n`);
      const verdict = (await rl.question(`Verdict for "${scn.name}" [pass/fail]: `)).trim().toLowerCase();
      outcomes.push({
        name: scn.name,
        status: res.isError ? 'error' : verdict === 'fail' ? 'fail' : 'pass',
        note: res.isError ? summarize(res) : verdict,
      });
    }
    return outcomes;
  } finally {
    rl.close();
    await getManager().dispose().catch(() => undefined);
  }
}
