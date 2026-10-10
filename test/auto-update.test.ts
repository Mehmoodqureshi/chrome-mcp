/**
 * Auto-update: an installed copy hands off to the latest published release.
 *   A. version compare, installed-copy detection, and the opt-outs.
 *   B. hands off with the exact version, the same args and the loop guard.
 *   C. stays put when up to date, offline, a dev checkout, or npx won't start.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

import { HANDOFF_ENV, autoUpdateDisabled, isInstalledCopy, isNewer, maybeHandOff } from '../src/auto-update';

const NPX_DIR = join('/home/u/.npm/_npx/abc/node_modules/@mehmoodqureshi/chrome-mcp');
const DEV_DIR = join('/home/u/Work/chrome-mcp');

/** A stand-in child process the test drives by hand. */
function fakeSpawn(behaviour: 'exit' | 'fail') {
  const calls: Array<{ cmd: string; args: string[]; opts: SpawnOptions }> = [];
  const spawn = (cmd: string, args: string[], opts: SpawnOptions): ChildProcess => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter() as ChildProcess;
    (child as unknown as { kill: () => boolean }).kill = () => true;
    setImmediate(() => {
      if (behaviour === 'fail') child.emit('error', new Error('spawn npx ENOENT'));
      else {
        child.emit('spawn');
        child.emit('exit', 3, null);
      }
    });
    return child;
  };
  return { spawn, calls };
}

test('isNewer compares plain releases only', () => {
  assert.equal(isNewer('0.9.16', '0.9.15'), true);
  assert.equal(isNewer('0.10.0', '0.9.15'), true);
  assert.equal(isNewer('1.0.0', '0.99.99'), true);
  assert.equal(isNewer('0.9.15', '0.9.15'), false);
  assert.equal(isNewer('0.9.14', '0.9.15'), false);
  assert.equal(isNewer('0.9.16-beta.1', '0.9.15'), false);
  assert.equal(isNewer('0.9.16', 'debug'), false);
});

test('only an installed copy updates, and the opt-outs work', () => {
  assert.equal(isInstalledCopy(NPX_DIR), true);
  assert.equal(isInstalledCopy(DEV_DIR), false);
  assert.equal(autoUpdateDisabled({}), false);
  assert.equal(autoUpdateDisabled({ CHROME_MCP_AUTO_UPDATE: '0' }), true);
  assert.equal(autoUpdateDisabled({ CHROME_MCP_AUTO_UPDATE: 'off' }), true);
  assert.equal(autoUpdateDisabled({}, true), true);
  assert.equal(autoUpdateDisabled({ [HANDOFF_ENV]: '0.9.15' }), true, 'the handed-off copy never hands off again');
});

test('a newer release takes over with the exact version and the same args', async () => {
  const { spawn, calls } = fakeSpawn('exit');
  const code = await maybeHandOff({
    current: '0.9.15',
    packageDir: NPX_DIR,
    argv: ['--persist-token', '--allow-domain', 'example.com'],
    env: { PATH: '/bin' },
    fetchLatest: async () => '0.9.16',
    spawn,
    platform: 'darwin',
  });
  assert.equal(code, 3, "leaves with the new copy's exit code");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'npx');
  assert.deepEqual(calls[0].args, ['-y', '@mehmoodqureshi/chrome-mcp@0.9.16', '--persist-token', '--allow-domain', 'example.com']);
  assert.equal(calls[0].opts.stdio, 'inherit');
  assert.equal((calls[0].opts.env as NodeJS.ProcessEnv)[HANDOFF_ENV], '0.9.15');
});

test('on Windows the shim runs through a shell with quoted arguments', async () => {
  const { spawn, calls } = fakeSpawn('exit');
  await maybeHandOff({
    current: '0.9.15',
    packageDir: NPX_DIR,
    argv: ['--uploads-dir', 'C:\\My Files\\up'],
    env: {},
    fetchLatest: async () => '0.9.16',
    spawn,
    platform: 'win32',
  });
  assert.equal(calls[0].cmd, 'npx.cmd');
  assert.equal(calls[0].opts.shell, true);
  assert.deepEqual(calls[0].args.slice(2), ['--uploads-dir', '"C:\\My Files\\up"']);
});

test('stays on this copy when up to date, offline, a dev checkout, or npx will not start', async () => {
  const base = { current: '0.9.15', packageDir: NPX_DIR, argv: [], env: {}, platform: 'darwin' as const };
  const never = fakeSpawn('exit');
  assert.equal(await maybeHandOff({ ...base, fetchLatest: async () => '0.9.15', spawn: never.spawn }), null);
  assert.equal(await maybeHandOff({ ...base, fetchLatest: async () => null, spawn: never.spawn }), null);
  assert.equal(await maybeHandOff({ ...base, packageDir: DEV_DIR, fetchLatest: async () => '0.9.16', spawn: never.spawn }), null);
  assert.equal(never.calls.length, 0);

  const broken = fakeSpawn('fail');
  assert.equal(await maybeHandOff({ ...base, fetchLatest: async () => '0.9.16', spawn: broken.spawn }), null);
  assert.equal(broken.calls.length, 1);
});
