/**
 * One-click pairing through Chrome native messaging.
 *   A. registration writes the launcher + manifest for installed browsers only,
 *      allows only our extension id, and uses the registry on Windows.
 *   B. the reply is the live handshake, never a dead server's.
 *   C. `chrome-mcp --native-host` speaks Chrome's framing end to end.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NATIVE_HOST_NAME, frameMessage, nativeHostPaths, pairingReply, registerNativeHost } from '../src/native-host';
import { STORE_EXTENSION_ID } from '../shared/protocol';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'cmcp-nh-'));

test('registers with installed browsers only, allowing just our extension', async () => {
  const home = tmp();
  const dataDir = tmp();
  mkdirSync(join(home, 'Library/Application Support/Google/Chrome'), { recursive: true });
  mkdirSync(join(home, 'Library/Application Support/BraveSoftware/Brave-Browser'), { recursive: true });
  const got = await registerNativeHost({ dataDir, cliPath: '/x/cli.js', nodePath: '/x/node', platform: 'darwin', home, profile: 'work' });
  assert.equal(got.length, 2, 'Chrome and Brave, not the browsers that are not installed');
  const manifest = JSON.parse(
    readFileSync(join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts', `${NATIVE_HOST_NAME}.json`), 'utf8'),
  );
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${STORE_EXTENSION_ID}/`]);
  assert.equal(manifest.type, 'stdio');
  const launcher = readFileSync(nativeHostPaths(dataDir, 'darwin').launcher, 'utf8');
  assert.match(launcher, /^#!\/bin\/sh\nexec '\/x\/node' '\/x\/cli\.js' --native-host '--data-dir' '.+' '--profile' 'work' "\$@"/);
  assert.ok(!existsSync(join(home, 'Library/Application Support/Microsoft Edge')));
});

test('on Windows it registers through the registry', async () => {
  const calls: string[][] = [];
  const dataDir = tmp();
  const got = await registerNativeHost({
    dataDir,
    cliPath: 'C:\\x\\cli.js',
    nodePath: 'C:\\node.exe',
    platform: 'win32',
    runReg: async (args) => void calls.push(args),
  });
  assert.equal(got.length, 4);
  assert.match(calls[0][1], /Google\\Chrome\\NativeMessagingHosts\\com\.mehmoodqureshi\.mcp_browser_extension$/);
  assert.equal(calls[0][calls[0].indexOf('/d') + 1], nativeHostPaths(dataDir, 'win32').manifest);
  assert.match(readFileSync(nativeHostPaths(dataDir, 'win32').launcher, 'utf8'), /^@echo off\r\n"C:\\node\.exe" "C:\\x\\cli\.js" --native-host/);
});

test('the reply is the live handshake, and a dead server is not a pairing', () => {
  const dir = tmp();
  assert.equal(pairingReply(dir).ok, false, 'no handshake: not running');
  writeFileSync(join(dir, 'handshake.json'), JSON.stringify({ v: 1, port: 38017, token: 't0k', pid: process.pid }));
  assert.deepEqual(pairingReply(dir, 'work'), { ok: true, port: 38017, token: 't0k', profile: 'work' });
  writeFileSync(join(dir, 'handshake.json'), JSON.stringify({ v: 1, port: 38017, token: 't0k', pid: 2 ** 22 + 12345 }));
  assert.equal(pairingReply(dir).ok, false, 'its process is gone');
});

test('chrome-mcp --native-host answers one framed request, as Chrome starts it', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'handshake.json'), JSON.stringify({ v: 1, port: 40000, token: 'abc', pid: process.pid }));
  const cli = join(__dirname, '..', 'src', 'cli.js');
  const out = execFileSync(
    process.execPath,
    [cli, '--native-host', '--data-dir', dir, `chrome-extension://${STORE_EXTENSION_ID}/`],
    { input: frameMessage({ type: 'pairing' }) },
  );
  const len = out.readUInt32LE(0);
  assert.equal(out.length, 4 + len, 'nothing but the framed reply on stdout');
  assert.deepEqual(JSON.parse(out.subarray(4).toString()), { ok: true, port: 40000, token: 'abc' });
});
