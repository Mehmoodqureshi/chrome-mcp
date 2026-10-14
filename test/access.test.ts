import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requireAccess, setAccessPollIntervalForTesting } from '../src/access';

test('email link activates one local MCP installation and revoked access fails closed', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'cmcp-access-'));
  let approved = false;
  let prompts = 0;
  let validations = 0;
  const originalFetch = globalThis.fetch;
  const realNow = Date.now;
  let now = realNow();
  setAccessPollIntervalForTesting(1);
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (url.endsWith('/start')) return Response.json({ ok: true, status: 'pending' });
    if (url.endsWith('/status')) return Response.json({ ok: true, status: approved ? 'approved' : 'pending' });
    if (url.endsWith('/validate')) {
      validations += 1;
      return approved ? Response.json({ ok: true, authorized: true }) : Response.json({ ok: false }, { status: 403 });
    }
    throw new Error(`unexpected request ${url} ${JSON.stringify(body)}`);
  };
  Date.now = () => now;
  const fakeServer = {
    elicitInput: async () => {
      prompts += 1;
      return { action: 'accept', content: { email: 'user@example.com' } };
    },
  } as never;

  try {
    const sent = await requireAccess(fakeServer, dataDir);
    assert.equal(sent?.isError, true);
    assert.match(sent?.content[0]?.type === 'text' ? sent.content[0].text : '', /sign-in link has been sent/);
    assert.equal(prompts, 1);

    approved = true;
    await new Promise((resolve) => setTimeout(resolve, 25));
    const saved = JSON.parse(readFileSync(join(dataDir, 'access.json'), 'utf8')) as { verified?: boolean; challengeId?: string };
    assert.equal(saved.verified, true);
    assert.equal(saved.challengeId, undefined);
    assert.equal(statSync(join(dataDir, 'access.json')).mode & 0o777, 0o600);

    assert.equal(await requireAccess(fakeServer, dataDir), null, 'valid grant is cached briefly');
    assert.equal(validations, 1, 'background verification syncs the grant without another tool call');

    now += 60_001;
    approved = false;
    const revoked = await requireAccess(fakeServer, dataDir);
    assert.equal(revoked?.isError, true);
    assert.match(revoked?.content[0]?.type === 'text' ? revoked.content[0].text : '', /revoked/);
    assert.equal(prompts, 1, 'revocation is reported before asking for email again');
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = realNow;
    setAccessPollIntervalForTesting(2_000);
  }
});
