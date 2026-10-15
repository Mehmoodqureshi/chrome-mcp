/** Phase 5 — server-side helpers: markdown reduction, link extraction, fill_form. */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { htmlToMarkdown } from '../src/mcp/markdown-extract';
import { extractLinks, fillForm, readAsMarkdown } from '../src/mcp/helpers';
import { StubExecutor } from '../src/executor/stub-executor';
import { ExtensionExecutor } from '../src/executor/extension-executor';
import { ExecutorError, type Executor, type Target } from '../src/executor/types';
import type { BridgeServer } from '../src/bridge/server';
import { WIRE_CAP_FILL_FORM } from '../shared/protocol';

test('htmlToMarkdown converts headings, lists, links, emphasis; drops chrome', () => {
  const html = `
    <nav>SKIP NAV</nav>
    <h1>Title</h1>
    <p>Some <strong>bold</strong> and <em>italic</em>.</p>
    <ul><li>one</li><li>two</li></ul>
    <a href="https://example.com">Example</a>
    <script>SKIP SCRIPT</script>`;
  const md = htmlToMarkdown(html);
  assert.match(md, /# Title/);
  assert.match(md, /\*\*bold\*\*/);
  assert.match(md, /_italic_/);
  assert.match(md, /- one/);
  assert.match(md, /\[Example\]\(https:\/\/example\.com\)/);
  assert.ok(!md.includes('SKIP NAV'));
  assert.ok(!md.includes('SKIP SCRIPT'));
});

test('extractLinks falls back to HTML parsing when eval is unavailable', async () => {
  // StubExecutor.eval returns a non-array, so extractLinks parses getHtml.
  const ex = new StubExecutor({ activeUrl: 'https://example.com' });
  const { links } = await extractLinks(ex, {});
  assert.equal(links.length, 1);
  assert.equal(links[0].href, 'https://example.com');
  assert.equal(links[0].text, 'Example');
});

test('extractLinks dedupe collapses repeated hrefs and prefers a non-empty label', async () => {
  // A fake executor whose eval returns anchors directly (the primary path), with
  // the same href appearing thrice — first with an empty label, then labelled.
  const fake = {
    async eval() {
      return {
        ok: true,
        value: [
          { href: 'https://a.com', text: '' },
          { href: 'https://a.com', text: 'A' },
          { href: 'https://b.com', text: 'B' },
          { href: 'https://a.com', text: 'A again' },
        ],
        type: 'object',
      } as const;
    },
  } as unknown as Executor;

  const { links } = await extractLinks(fake, { dedupe: true });
  assert.deepEqual(links, [
    { href: 'https://a.com', text: 'A' },
    { href: 'https://b.com', text: 'B' },
  ]);
});

test('extractLinks limit caps the number of links returned', async () => {
  const fake = {
    async eval() {
      return {
        ok: true,
        value: [
          { href: 'https://a.com', text: 'A' },
          { href: 'https://b.com', text: 'B' },
          { href: 'https://c.com', text: 'C' },
        ],
        type: 'object',
      } as const;
    },
  } as unknown as Executor;

  const { links } = await extractLinks(fake, { limit: 2 });
  assert.equal(links.length, 2);
  assert.deepEqual(links.map((l) => l.href), ['https://a.com', 'https://b.com']);
});

test('readAsMarkdown reduces the page HTML', async () => {
  const ex = new StubExecutor();
  const md = await readAsMarkdown(ex, {});
  assert.match(md, /\[Example\]\(https:\/\/example\.com\)/);
});

test('fillForm fills each field then clicks submit', async () => {
  const calls: string[] = [];
  const fake = {
    async fill(t: Target, value: string) {
      calls.push(`fill ${(t as { selector: string }).selector}=${value}`);
      return { ok: true } as const;
    },
    async click(t: Target) {
      calls.push(`click ${(t as { selector: string }).selector}`);
      return { ok: true } as const;
    },
  } as unknown as Executor;

  const out = await fillForm(fake, {
    fields: { '#email': 'a@b.com', '#name': 'Ada' },
    submitSelector: '#go',
  });
  assert.equal(out.filled, 2);
  assert.equal(out.submitted, true);
  assert.deepEqual(calls, ['fill #email=a@b.com', 'fill #name=Ada', 'click #go']);
});

/** A bridge double: records wire commands and answers `fill_form` from `reply`. */
function fakeBridge(caps: string[], reply: (params: Record<string, unknown>) => unknown) {
  const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  const bridge = {
    hasCap: (_profile: string, cap: string) => caps.includes(cap),
    async sendCommand(method: string, params: Record<string, unknown>) {
      sent.push({ method, params });
      return method === 'fill_form' ? reply(params) : { ok: true };
    },
  } as unknown as BridgeServer;
  return { ex: new ExtensionExecutor(bridge), sent };
}

test('fillForm sends every field in one fill_form command, then submits separately', async () => {
  const { ex, sent } = fakeBridge([WIRE_CAP_FILL_FORM], (p) => ({ filled: (p.ops as unknown[]).length }));
  const out = await fillForm(ex, {
    fields: { '#email': 'a@b.com', '#agree': true },
    submitSelector: '#go',
    frameId: 3,
  });
  assert.deepEqual(out, { filled: 2, submitted: true });
  assert.deepEqual(sent.map((s) => s.method), ['fill_form', 'click']);
  assert.deepEqual(sent[0].params, {
    ops: [
      { selector: '#email', value: 'a@b.com' },
      { selector: '#agree', value: true },
    ],
    frameId: 3,
  });
  assert.equal(sent[1].params.selector, '#go');
});

test('fillForm partial failure throws the failing field and never submits', async () => {
  const { ex, sent } = fakeBridge([WIRE_CAP_FILL_FORM], () => ({
    filled: 1,
    error: { selector: '#missing', code: 'SELECTOR_NOT_FOUND', message: 'no element for selector: #missing' },
  }));
  await assert.rejects(
    fillForm(ex, { fields: { '#email': 'a@b.com', '#missing': 'x', '#name': 'Ada' }, submitSelector: '#go' }),
    // The message locates the failure in the batch, so a caller knows the
    // earlier fields already landed and a blind retry would re-write them.
    (e: unknown) =>
      e instanceof ExecutorError &&
      e.code === 'SELECTOR_NOT_FOUND' &&
      e.message === 'field 2 of 3 (#missing) failed after 1 filled: no element for selector: #missing',
  );
  assert.deepEqual(sent.map((s) => s.method), ['fill_form']);
});

test('fillForm falls back to per-field writes when the extension predates fill_form', async () => {
  const { ex, sent } = fakeBridge([], () => assert.fail('fill_form must not be sent'));
  const out = await fillForm(ex, { fields: { '#email': 'a@b.com', '#agree': true } });
  assert.deepEqual(out, { filled: 2, submitted: false });
  assert.deepEqual(sent.map((s) => s.method), ['type', 'click']);
  assert.equal(sent[0].params.clear, true);
});

test('extractLinks handles thrown eval denial, decoded attributes and relative URLs', async () => {
  const calls: unknown[] = [];
  const ex = new StubExecutor({ activeUrl: 'https://example.com/articles/start' });
  ex.eval = async () => { throw new ExecutorError('POLICY_DENIED', 'eval is disabled'); };
  ex.getHtml = async (...args: unknown[]) => {
    calls.push(args);
    return { html: `
      <!-- <a href="/comment">Not a link</a> -->
      <script>const fake = '<a href="/script">Not a link</a>';</script>
      <template><a href="/template">Not a live link</a></template>
      <a data-href="/wrong" href = "../docs?a=1&amp;b=2">A &amp; <b>B</b> &#x26; C</a>
      <a href='/docs?a=1&amp;b=2'></a>
      <a href=https://other.example/path>External</a>
      <a href="//example.com/network">Network relative</a>
      <a href="?q=hello&amp;page=2">Query</a>
      <a href="#part">Fragment</a><a href="java&#x73;cript:alert(1)">Script</a>
      <a href="data:text/plain,test">Data</a><a href="blob:https://example.com/id">Blob</a>
      <a href="https://example.com.evil.test/">Prefix trap</a>
      <a href="https://example.com:444/">Different port</a>
    ` };
  };
  const { links } = await extractLinks(ex, { selector: '#content', tabId: 'extension:stub:1', sameOriginOnly: true, dedupe: true });
  assert.deepEqual(links, [
    { href: 'https://example.com/docs?a=1&b=2', text: 'A & B & C' },
    { href: 'https://example.com/network', text: 'Network relative' },
    { href: 'https://example.com/articles/start?q=hello&page=2', text: 'Query' },
  ]);
  assert.deepEqual(calls[0], [{ selector: '#content' }, { tabId: 'extension:stub:1', frameId: undefined, allFrames: undefined }]);
  assert.equal((await extractLinks(ex, { limit: 1 })).links.length, 1);
});

test('extractLinks propagates non-policy eval errors without reading HTML', async () => {
  const ex = new StubExecutor();
  const err = new ExecutorError('EXTENSION_DISCONNECTED', 'browser disconnected');
  ex.eval = async () => { throw err; };
  ex.getHtml = async () => assert.fail('must not mask a disconnected browser');
  await assert.rejects(extractLinks(ex, {}), e => e === err);
});

test('extractLinks resolves against the requested tab, the returned frame, and HTML base', async () => {
  const ex = new StubExecutor({
    activeUrl: 'https://wrong.example/',
    backgroundTabs: [{ tabId: 'extension:stub:2', url: 'https://example.com/nested/page' }],
    htmlPayload: '<base href="/assets/"><a href="one">One</a><a href="https://example.com">Absolute</a>',
    frames: [{ frameId: 3, top: false, url: 'https://frame.example/sub/page', title: '' }],
  });
  ex.eval = async () => { throw new ExecutorError('POLICY_DENIED', 'eval is disabled'); };
  assert.deepEqual((await extractLinks(ex, { tabId: 'extension:stub:2' })).links, [
    { href: 'https://example.com/assets/one', text: 'One' },
    { href: 'https://example.com', text: 'Absolute' },
  ]);
  ex.getHtml = async () => ({ html: '<a href="child">Child</a>', frameId: 3 });
  assert.deepEqual((await extractLinks(ex, { allFrames: true, selector: 'main' })).links, [
    { href: 'https://frame.example/sub/child', text: 'Child' },
  ]);
});
