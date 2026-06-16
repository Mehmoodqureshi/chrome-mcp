/**
 * upload_file verification — the new file-upload tool.
 *   A. Policy: denied without allowUploads; URL-gated by the destination domain.
 *   B. Dispatch: missing files / missing target render as clean isError (never throw).
 *   C. (gated on Chromium) CdpExecutor.uploadFile actually sets files on an <input>.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { assertUrlAllowed, resolvePolicy } from '../src/security/policy';
import { ExecutorError } from '../src/executor/types';
import { dispatchToolCall, resetRateLimiter, TOOL_DEFINITIONS, TOOL_HANDLERS } from '../src/mcp/tools';
import { configureManager, resetManagerForTesting } from '../src/executor/manager';
import { StubExecutor, type StubOptions } from '../src/executor/stub-executor';
import { CdpExecutor } from '../src/executor/cdp-executor';

// --- A. Policy --------------------------------------------------------------

test('upload_file is denied without allowUploads, even on an allowed domain', () => {
  const policy = resolvePolicy({ allowDomains: ['example.com'], enableMutations: true });
  assert.throws(
    () => assertUrlAllowed('https://example.com/page', 'upload_file', policy),
    (e: unknown) => e instanceof ExecutorError && e.code === 'POLICY_DENIED' && /upload/i.test(e.message),
  );
});

test('upload_file is allowed with allowUploads on an allowlisted domain', () => {
  const policy = resolvePolicy({ allowDomains: ['example.com'], allowUploads: true });
  assert.doesNotThrow(() => assertUrlAllowed('https://example.com/page', 'upload_file', policy));
});

test('upload_file is URL-gated: allowUploads but off-allowlist domain is denied', () => {
  const policy = resolvePolicy({ allowDomains: ['example.com'], allowUploads: true });
  assert.throws(
    () => assertUrlAllowed('https://evil.test/page', 'upload_file', policy),
    (e: unknown) => e instanceof ExecutorError && e.code === 'POLICY_DENIED',
  );
});

// --- catalog parity ---------------------------------------------------------

test('upload_file is in both the catalog and the handler table', () => {
  assert.ok(TOOL_DEFINITIONS.some((d) => d.name === 'upload_file'), 'advertised');
  assert.ok(typeof TOOL_HANDLERS.upload_file === 'function', 'has handler');
});

// --- B. Dispatch (stub; never-throw firewall) -------------------------------

function configure(stub: StubOptions = {}): void {
  resetManagerForTesting();
  resetRateLimiter();
  configureManager({
    // uploads now REQUIRE a confinement dir; the generic happy-path tests below
    // use /tmp so file paths under it are accepted.
    policy: resolvePolicy({ allowDomains: ['*'], allowUploads: true, uploadsDir: '/tmp' }),
    makeExecutor: () => new StubExecutor(stub),
  });
}
const textOf = (r: CallToolResult): string => {
  const b = r.content.find((c) => c.type === 'text');
  return b && b.type === 'text' ? b.text : '';
};

test('upload_file with no files is a clean isError', async () => {
  configure({ activeUrl: 'https://example.com' });
  const r = await dispatchToolCall('upload_file', { selector: '#f' });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /files|target|non-empty/i);
});

test('upload_file with files but no target is a clean isError', async () => {
  configure({ activeUrl: 'https://example.com' });
  const r = await dispatchToolCall('upload_file', { files: ['/tmp/x.pdf'] });
  assert.equal(r.isError, true);
});

test('upload_file happy path through the stub returns ok', async () => {
  configure({ activeUrl: 'https://example.com' });
  const r = await dispatchToolCall('upload_file', { selector: '#f', files: ['/tmp/x.pdf'] });
  assert.notEqual(r.isError, true);
});

test('upload_file is denied when uploads are enabled but no uploads-dir is configured', async () => {
  resetManagerForTesting();
  resetRateLimiter();
  configureManager({
    policy: resolvePolicy({ allowDomains: ['*'], allowUploads: true }), // no uploadsDir
    makeExecutor: () => new StubExecutor({ activeUrl: 'https://example.com' }),
  });
  const r = await dispatchToolCall('upload_file', { selector: '#f', files: ['/tmp/x.pdf'] });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /require.*uploads-dir|uploads require/i);
});

function configureWithDir(uploadsDir: string): void {
  resetManagerForTesting();
  resetRateLimiter();
  configureManager({
    policy: resolvePolicy({ allowDomains: ['*'], allowUploads: true, uploadsDir }),
    makeExecutor: () => new StubExecutor({ activeUrl: 'https://example.com' }),
  });
}

test('uploads-dir: a file INSIDE the allowed dir is accepted', async () => {
  configureWithDir('/srv/uploads');
  const r = await dispatchToolCall('upload_file', { selector: '#f', files: ['/srv/uploads/paper.pdf'] });
  assert.notEqual(r.isError, true);
});

test('uploads-dir: a file OUTSIDE the allowed dir is a clean isError', async () => {
  configureWithDir('/srv/uploads');
  const r = await dispatchToolCall('upload_file', { selector: '#f', files: ['/etc/passwd'] });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /outside the allowed uploads dir/i);
});

test('uploads-dir: a ".." traversal escape is blocked', async () => {
  configureWithDir('/srv/uploads');
  const r = await dispatchToolCall('upload_file', { selector: '#f', files: ['/srv/uploads/../../etc/shadow'] });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /outside the allowed uploads dir/i);
});

test('uploads-dir: a sibling-prefix dir does NOT count as inside', async () => {
  configureWithDir('/srv/uploads');
  const r = await dispatchToolCall('upload_file', { selector: '#f', files: ['/srv/uploads-evil/x.pdf'] });
  assert.equal(r.isError, true);
});

// --- C. Live CDP (skipped when Chromium isn't installed) --------------------

let hasChromium = false;
try {
  hasChromium = existsSync(chromium.executablePath());
} catch {
  hasChromium = false;
}

test('CdpExecutor.uploadFile sets files on a real <input type=file>', { skip: !hasChromium }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cmcp-upload-'));
  const filePath = join(dir, 'paper.pdf');
  writeFileSync(filePath, 'hello');
  const ex = new CdpExecutor({ mode: 'launch', userDataDir: dir, headless: true });
  try {
    await ex.ensureReady();
    await ex.navigate({ url: 'data:text/html,<input id="up" type="file">' });
    await ex.uploadFile({ selector: '#up' }, [filePath]);
    const { value } = await ex.eval('document.getElementById("up").files[0]?.name');
    assert.equal(value, 'paper.pdf');
  } finally {
    await ex.dispose();
  }
});

test('CdpExecutor.uploadFile on a missing file surfaces UPLOAD_FAILED', { skip: !hasChromium }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cmcp-upload2-'));
  const ex = new CdpExecutor({ mode: 'launch', userDataDir: dir, headless: true });
  try {
    await ex.ensureReady();
    await ex.navigate({ url: 'data:text/html,<input id="up" type="file">' });
    await assert.rejects(
      ex.uploadFile({ selector: '#up' }, ['/no/such/file-xyz.pdf']),
      (e: unknown) => e instanceof ExecutorError && e.code === 'UPLOAD_FAILED',
    );
  } finally {
    await ex.dispose();
  }
});
